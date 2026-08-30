import { app, BrowserWindow, ipcMain, session } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as dotenv from 'dotenv'
import { parse as babelParse } from '@babel/parser'
import {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  renameConversation,
  addMessage,
  ConversationMode
} from './conversationStore'
import { searchRelevantCode } from './vectorStore'
import { generateEmbedding, indexWorkspace } from './indexer'

dotenv.config()

// 1. Model Provider Abstraction
//
// NEW: previously every call in this file went straight to Google's
// Gemini API, hardcoded -- meaning for a regulated customer, their real
// project code left their building the moment they typed a message, no
// matter what the audit trail said afterward. This layer fixes that by
// making "the model" swap-able: everything else in the pipeline
// (Michael, Jim, Dwight, Riley, Pam, chat, self-healing) just calls
// fetchFrontierAI/fetchChatCompletion exactly as before -- neither of
// those function names or call sites changed. Only what happens INSIDE
// them changed: they now go through whichever provider is configured.
//
// Two providers exist today:
//   - GeminiProvider: the existing cloud path. Cheap, easy, fine for most
//     users -- stays the default.
//   - OpenAICompatibleProvider: talks to anything exposing an OpenAI-shaped
//     /chat/completions endpoint -- this covers Ollama, vLLM, LM Studio,
//     and a customer's own private Azure OpenAI tenant, all with ONE
//     implementation, since they all agree on the same request shape.
//     Set MODEL_PROVIDER=local and LOCAL_MODEL_BASE_URL to use this.
//
// Picking a provider is one environment variable, not a code change.

type ChatTurn = { role: 'user' | 'assistant'; content: string }

interface ModelProvider {
  generate(systemPrompt: string, history: ChatTurn[]): Promise<string>
}

class GeminiProvider implements ModelProvider {
  async generate(systemPrompt: string, history: ChatTurn[]): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash'
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY in environment.')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 40000)

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const contents = history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.5 }
        }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      if (!response.ok) {
        throw new Error(`Gemini API Error (${response.status}): ${await response.text()}`)
      }
      const data = await response.json()
      return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    } catch (err: any) {
      clearTimeout(timeoutId)
      if (err.name === 'AbortError') throw new Error('API Request timed out after 40 seconds.')
      throw err
    }
  }
}

// Covers any self-hosted or private model server speaking the OpenAI
// chat-completions shape. This is the piece that actually solves the
// data-residency problem: point LOCAL_MODEL_BASE_URL at something running
// on the customer's own hardware or their own private cloud account, and
// project code never has to leave it.
class OpenAICompatibleProvider implements ModelProvider {
  async generate(systemPrompt: string, history: ChatTurn[]): Promise<string> {
    const baseUrl = process.env.LOCAL_MODEL_BASE_URL // e.g. http://localhost:11434/v1 for Ollama
    const apiKey = process.env.LOCAL_MODEL_API_KEY || 'not-needed' // most local servers ignore this
    const model = process.env.LOCAL_MODEL_NAME || 'llama3.1'
    if (!baseUrl) throw new Error('Missing LOCAL_MODEL_BASE_URL in environment.')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000) // local models can be slower than a cloud API

    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content }))
      ]

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, temperature: 0.5 }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      if (!response.ok) {
        throw new Error(`Local model API Error (${response.status}): ${await response.text()}`)
      }
      const data = await response.json()
      return data.choices?.[0]?.message?.content || ''
    } catch (err: any) {
      clearTimeout(timeoutId)
      if (err.name === 'AbortError') throw new Error('Local model request timed out.')
      throw err
    }
  }
}

function getModelProvider(): ModelProvider {
  const providerName = process.env.MODEL_PROVIDER || 'gemini'
  switch (providerName) {
    case 'local':
    case 'openai-compatible':
      return new OpenAICompatibleProvider()
    case 'gemini':
    default:
      return new GeminiProvider()
  }
}

const modelProvider = getModelProvider()

// Kept as the same function names/signatures every existing call site
// already uses -- Michael, Jim, Dwight, Riley, Pam, chat, and
// self-healing all call these exactly as before. Only the inside changed.
async function fetchFrontierAI(systemPrompt: string, userPrompt: string): Promise<string> {
  return modelProvider.generate(systemPrompt, [{ role: 'user', content: userPrompt }])
}

async function fetchChatCompletion(systemPrompt: string, history: ChatTurn[]): Promise<string> {
  return modelProvider.generate(systemPrompt, history)
}

// 2. Hardened Deterministic Security Linter (Gate 1)
interface FileAuditResult {
  file: string
  passed: boolean
  blockers: string[]
  warnings: string[]
}

interface AuditResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
  perFile: FileAuditResult[]
}

function stripComments(code: string): string {
  let out = ''
  let i = 0
  let inString: '"' | "'" | '`' | null = null

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === inString) inString = null
      i++
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      out += ch
      i++
      continue
    }

    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }

    out += ch
    i++
  }

  return out
}

function auditSingleFile(filename: string, rawCode: string): FileAuditResult {
  const blockers: string[] = []
  const warnings: string[] = []
  const code = stripComments(rawCode)

  // FIX: Only run Babel AST parsing on JavaScript/TypeScript files
  const isJsOrTs = /\.(ts|tsx|js|jsx)$/i.test(filename)

  if (isJsOrTs) {
    try {
      babelParse(rawCode, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx']
      })
    } catch (err: any) {
      blockers.push(`PARSE ERROR: ${err.message || 'Code failed to parse.'} Rejected prior to security scan.`)
      return { file: filename, passed: false, blockers, warnings }
    }
  }

  const secretDeclRegex = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"`])(?:(?!\2).)+\2/g
  const secretKeywords = /pass(word)?|pwd|secret|token|api[-_]?key|credential|auth(?!or)/i
  let secretMatch: RegExpExecArray | null
  while ((secretMatch = secretDeclRegex.exec(code)) !== null) {
    const [fullMatch, varName] = secretMatch
    if (secretKeywords.test(varName) && !fullMatch.includes('process.env')) {
      blockers.push(`SECURITY BLOCK: Hardcoded credential-like value assigned to "${varName}" without process.env.`)
    }
  }

  if (/res\.cookie\s*\(/.test(code)) {
    const hasHttpOnlyKey = /httpOnly\s*:/i.test(code)
    const hasSecureKey = /secure\s*:/i.test(code)
    const hasHttpOnlyTrue = /httpOnly\s*:\s*true/i.test(code)
    const hasSecureTrue = /secure\s*:\s*true/i.test(code)

    if (!hasHttpOnlyKey || !hasSecureKey) {
      blockers.push('SECURITY BLOCK: res.cookie() call is missing httpOnly and/or secure flags entirely.')
    } else if (!hasHttpOnlyTrue || !hasSecureTrue) {
      warnings.push('HEURISTIC WARNING: Cookie flags present but not statically resolvable to `true`. Forwarded to Pam (Gate 2).')
    }
  }

  const passwordFromBody =
    /password\s*=\s*(req\.body|body)\.password/i.test(code) ||
    /const\s*\{[^}]*\bpassword\b[^}]*\}\s*=\s*(req\.body|body)\b/i.test(code)
  if (passwordFromBody && !/(bcrypt|argon2|hash)/i.test(code)) {
    blockers.push('SECURITY BLOCK: Plaintext password handling detected without hashing.')
  }

  return { file: filename, passed: blockers.length === 0, blockers, warnings }
}

function runMechanicalAudit(extractedFiles: Record<string, string>): AuditResult {
  const perFile: FileAuditResult[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  for (const [filename, code] of Object.entries(extractedFiles)) {
    const result = auditSingleFile(filename, code)
    perFile.push(result)
    for (const b of result.blockers) blockers.push(`[${filename}] ${b}`)
    for (const w of result.warnings) warnings.push(`[${filename}] ${w}`)
  }

  return { passed: blockers.length === 0, blockers, warnings, perFile }
}

// 3. Robust Artifact Extractor with Path Normalization
function normalizeFilePath(rawPath: string): string {
  let filename = rawPath.trim()
  if (
    (filename.endsWith('.tsx') || filename.endsWith('.ts')) &&
    !filename.startsWith('src/') &&
    filename !== 'vite.config.ts'
  ) {
    filename = `src/${filename}`
  }
  return filename
}

function extractCodeBlocks(markdown: string): Record<string, string> {
  const files: Record<string, string> = {}

  const regex = /```(?:\w+)?\s+([\w./-]+)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(markdown)) !== null) {
    const filename = normalizeFilePath(match[1])
    files[filename] = match[2].trim()
  }

  const genericRegex = /```(?:\w+)?\s*\n([\s\S]*?)```/g
  while ((match = genericRegex.exec(markdown)) !== null) {
    const content = match[1].trim()
    const firstLine = content.split('\n')[0].trim()

    // Optional "File:" or "Filename:" prefix support
    const commentMatch = firstLine.match(/^(?:\/\/|#|\/\*)\s*(?:(?:file|filename):\s*)?([\w./-]+)\s*\*?\/?$/i)

    if (commentMatch) {
      const filename = normalizeFilePath(commentMatch[1])
      if (!files[filename]) {
        const cleanContent = content.split('\n').slice(1).join('\n').trim()
        files[filename] = cleanContent
      }
    }
  }

  return files
}

// 4. Virtual Environment Scaffolder
function findBackendEntryFile(files: Record<string, string>): string | null {
  const listenFile = Object.entries(files).find(([, content]) => /\.listen\s*\(/.test(content))
  if (listenFile) return listenFile[0]
  const tsFile = Object.keys(files).find(f => f.endsWith('.ts'))
  return tsFile ?? null
}

function injectFrontendBoilerplate(extractedFiles: Record<string, string>): Record<string, string> {
  const hasAppComponent = Object.keys(extractedFiles).includes('src/App.tsx')

  // NEW: don't just assume App.tsx used a default export -- check. A
  // named export (`export function App()`) is equally valid TypeScript,
  // it just needs a different import line. Detecting this instead of
  // hardcoding one assumption means a mismatch here can't crash the
  // sandbox even if the specialist doesn't follow the prompt instruction.
  const appFileContent = extractedFiles['src/App.tsx'] || ''
  const appUsesDefaultExport = /export\s+default\b/.test(appFileContent)
  const appImportLine = appUsesDefaultExport
    ? `import App from './App'`
    : `import { App } from './App'`

  return {
    ...extractedFiles,
    'package.json': JSON.stringify({
      name: "branch-hq-preview",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc && vite build",
        preview: "vite preview"
      },
      dependencies: {
        "react": "^18.2.0",
        "react-dom": "^18.2.0",
        "lucide-react": "^0.263.1",
        "canvas-confetti": "^1.9.2"
      },
      devDependencies: {
        "@vitejs/plugin-react": "^4.2.1",
        "vite": "^5.1.0",
        "typescript": "^5.2.2",
        "@types/canvas-confetti": "^1.6.4",
        "tailwindcss": "^3.4.1",
        "postcss": "^8.4.35",
        "autoprefixer": "^10.4.17"
      }
    }, null, 2),
    'vite.config.ts': `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { port: 3000, strictPort: false }\n})`,
    'tailwind.config.js': `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: [\n    "./index.html",\n    "./src/**/*.{js,ts,jsx,tsx}",\n  ],\n  theme: {\n    extend: {},\n  },\n  plugins: [],\n}`,
    'postcss.config.js': `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}`,
    'index.html': `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Sandbox Preview</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>`,
    'src/main.tsx': hasAppComponent
      ? `import React from 'react'\nimport ReactDOM from 'react-dom/client'\n${appImportLine}\nimport './assets/main.css'\n\nReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n)`
      : `import './assets/main.css'\n\n// No src/App.tsx in this response -- likely a utility/non-visual file\n// (constants, types, helpers), not a renderable component. Nothing to\n// mount here; see the Code tab for what was actually generated.\nconst root = document.getElementById('root')\nif (root) {\n  root.innerHTML = '<div style="font-family: monospace; padding: 2rem; color: #888;">No root App component in this response. Check the Code tab.</div>'\n}`,
    'src/assets/main.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`
  }
}

function injectBackendBoilerplate(extractedFiles: Record<string, string>): Record<string, string> {
  const entryFile = findBackendEntryFile(extractedFiles)
  return {
    ...extractedFiles,
    'package.json': JSON.stringify({
      name: "branch-hq-preview-backend",
      type: "module",
      scripts: {
        dev: entryFile
          ? `tsx watch ${entryFile}`
          : `echo "No runnable entry file found (no .listen() call detected in any generated file)" && exit 1`
      },
      dependencies: {
        "express": "^4.19.2",
        "cors": "^2.8.5",
        "bcryptjs": "^2.4.3",
        "jsonwebtoken": "^9.0.2",
        "zod": "^3.23.8",
        "dotenv": "^16.4.5"
      },
      devDependencies: {
        "typescript": "^5.4.5",
        "tsx": "^4.7.0",
        "@types/express": "^4.17.21",
        "@types/cors": "^2.8.17",
        "@types/jsonwebtoken": "^9.0.6",
        "@types/bcryptjs": "^2.4.6"
      }
    }, null, 2)
  }
}

// NEW: Riley (document generation) gets its own scaffold, separate from
// frontend/backend -- there's no page to render and no server to run, just
// a script that produces a file once and exits.
function injectDocumentBoilerplate(extractedFiles: Record<string, string>): Record<string, string> {
  const hasEntryScript = Object.keys(extractedFiles).includes('src/generate.ts')
  return {
    ...extractedFiles,
    'package.json': JSON.stringify({
      name: "branch-hq-preview-docs",
      type: "module",
      scripts: {
        dev: hasEntryScript
          ? 'tsx src/generate.ts'
          : 'echo "No src/generate.ts found -- Riley must name the script exactly that" && exit 1'
      },
      // Both libraries are pure JS/TS, no native compilation -- same
      // WebContainer-safety reasoning as bcryptjs over bcrypt for Dwight.
      dependencies: {
        "pdfkit": "^0.15.0",
        "pptxgenjs": "^3.12.0"
      },
      devDependencies: {
        "typescript": "^5.4.5",
        "tsx": "^4.7.0",
        "@types/pdfkit": "^0.13.4"
      }
    }, null, 2)
  }
}

function injectBoilerplate(extractedFiles: Record<string, string>, agentKey?: 'jim' | 'dwight' | 'riley'): Record<string, string> {
  if (Object.keys(extractedFiles).length === 0) return extractedFiles
  if (agentKey === 'dwight') return injectBackendBoilerplate(extractedFiles)
  if (agentKey === 'riley') return injectDocumentBoilerplate(extractedFiles)
  return injectFrontendBoilerplate(extractedFiles)
}

// 5. System Prompts
const PROMPTS = {
  MICHAEL_MANAGER: `You are Michael -- the single point of contact for this workspace. People talk to you directly for everything: casual conversation, day-to-day questions, brainstorming, AND requests to build code or documents. For each message, decide whether it needs something actually built, or whether you can just answer it yourself.

Output ONLY a valid JSON object, in ONE of these two shapes:

If the request needs code, an app, or a document (PDF/PowerPoint) actually built:
{
  "action": "delegate",
  "assignTo": "Jim" | "Dwight" | "Riley",
  "instructions": "<concise implementation instructions>"
}
Assign to Jim for frontend/React/UI work, Dwight for backend/Express/API work, and Riley for anything that should produce a PDF or PowerPoint document.

If the request is conversational -- a question, advice, brainstorming, something from your own knowledge, or just talking -- answer it yourself, directly and naturally, the way a genuinely helpful person would:
{
  "action": "respond",
  "response": "<your full, natural, conversational reply>"
}

Default to "respond." Most everyday messages are conversation, not a build request -- only delegate when something real actually needs to be built.`,
  JIM_FRONTEND: `You are Jim, Frontend Specialist. Write complete, functional React/TypeScript code using Tailwind CSS.
ALWAYS wrap your code in standard Markdown code blocks (e.g., \`\`\`tsx ).
ALWAYS declare file paths at the very start of the code blocks (e.g., // File: src/App.tsx).
CRITICAL: src/App.tsx must always use a DEFAULT export (export default function App() ...), never a named export (export function App() ...) -- the app's entry point imports it as a default import and will fail to load otherwise.
CRITICAL: You are ONLY allowed to use 'react', 'lucide-react', and 'canvas-confetti' as external dependencies. Do not import anything else. For real typography (not just system fonts), you may still add a single <link> or @import for a Google Font in your CSS -- this does not require an npm package and is not a dependency violation.

DESIGN APPROACH -- follow this before writing any code:
Act like a design lead giving every request its own distinct visual identity, never a template. In a short comment block at the top of your first file, plan: 2-4 named colors as hex values, two font roles (one characterful display face used with restraint, one plain body face), and one signature visual element specific to what's actually being built. Then build exactly that plan -- don't let the code drift back to defaults.

AVOID THESE -- they are tells of generic AI-generated UI, not real design choices:
- Purple-to-indigo gradients, especially on buttons or hero sections
- Frosted-glass/blur cards (backdrop-blur, translucent panels) used by default
- A near-black background with one glowing blue/neon accent and ambient blur circles
- A cream background with a warm serif and a terracotta/clay accent (a well-known AI-default look)
- Numbered badges (01 / 02 / 03) unless the content is genuinely an ordered sequence
- Animation on every element -- motion should be rare and deliberate, not scattered everywhere

A financial dashboard, a kids' game, and a developer tool should never end up looking like the same template in different colors. Match the whole visual style to what's actually being built.`,
  DWIGHT_BACKEND: `You are Dwight, Backend Specialist. Write complete, functional Node.js/TypeScript code using Express.
ALWAYS wrap your code in standard Markdown code blocks (e.g., \`\`\`ts ).
ALWAYS declare file paths at the very start of the code blocks (e.g., // File: src/server.ts).
CRITICAL: You are ONLY allowed to use 'express', 'cors', 'bcryptjs', 'jsonwebtoken', 'zod', and 'dotenv' as external dependencies. Do not import anything else. In particular, never import 'bcrypt' -- use 'bcryptjs' instead, since this code runs inside a browser-based WebContainer sandbox that cannot compile native Node addons.`,
  PAM_AUDITOR_LOGIC: `You are Pam, the QA Auditor. Mechanical checks have passed.
Review the code for logical correctness, security vulnerabilities, edge cases, and missing input validation.
End your review with exactly one line, in exactly this format and nothing else on that line, so it can be read automatically:
PAM_VERDICT: APPROVED
or
PAM_VERDICT: CHANGES_REQUESTED`,
  // NEW: Riley, the third specialist -- produces PDF/PPT files via a
  // script instead of app code.
  RILEY_DOCS: `You are Riley, the Research & Documents Specialist. You produce PDF and PowerPoint files by writing a single Node.js/TypeScript script.
ALWAYS wrap your code in a standard Markdown code block.
ALWAYS declare the file path at the very start of the code block (e.g., // File: src/generate.ts).
ALWAYS name your script exactly src/generate.ts -- this is the only file the system will run.
CRITICAL: You are ONLY allowed to use 'pdfkit' (for PDF files) and 'pptxgenjs' (for PowerPoint files) as external dependencies. Do not import anything else.
CRITICAL: Your script must write its output to exactly output.pdf or output.pptx in the project root when run -- that is the file that gets saved for the user.
IMPORTANT: You do not have live internet access. Write from your own knowledge -- never claim to have searched the web or cite sources you were not actually given. If the user needs current or live information, say so plainly rather than inventing facts.`,
  // NEW: the plain chatbot -- not part of the pipeline, no code, no Gate 1,
  // just a normal back-and-forth conversation.
  GENERAL_CHAT: `You are a helpful, general-purpose assistant inside Branch HQ. Unlike Michael, Jim, Dwight, Pam, and Riley, you are not part of the coding/document pipeline -- you have a normal, free-ranging conversation with the user about anything they want: questions, advice, writing help, brainstorming, or just talking. You do not generate stageable files, and nothing you write goes through Gate 1 or gets pushed to the sandbox. Be direct, clear, and genuinely helpful.`
}

// How many total tries the specialist gets before we stop auto-retrying and
// just show whatever we have. 1 = no auto-retry at all. Keep this small --
// every extra round is real API cost, and Pam finding one more small thing
// to mention is not a reason to loop forever.
const MAX_AUTO_FIX_ROUNDS = 3

// Separate, smaller cap for self-healing. This is a different kind of
// retry than MAX_AUTO_FIX_ROUNDS -- it only fires after code has already
// passed Gate 1 and Pam and then failed for real when actually run.
// Kept small on purpose: if two attempts at a real runtime fix don't
// work, the problem is probably not something worth guessing at a third
// time automatically.
const MAX_SELF_HEAL_ROUNDS = 2

// NEW: Riley's script is always named src/generate.ts by convention --
// if he forgets to declare that path on the first line (unlike Jim and
// Dwight, who have that instruction spelled out and reliably follow it),
// the normal extractor finds nothing at all, and the whole document
// pipeline silently produces no stageable file. Since we already know
// deterministically what the file must be called, just grab the first
// code fence directly instead of depending on him naming it correctly.
function extractRileyFallback(rawOutput: string): Record<string, string> {
  const anyFenceRegex = /```(?:\w+)?\s*\n?([\s\S]*?)```/
  const match = rawOutput.match(anyFenceRegex)
  if (!match) return {}
  return { 'src/generate.ts': match[1].trim() }
}

function auditAndStage(rawOutput: string, agentKey?: 'jim' | 'dwight' | 'riley') {
  let extractedFiles = extractCodeBlocks(rawOutput)
  if (agentKey === 'riley' && !extractedFiles['src/generate.ts']) {
    extractedFiles = extractRileyFallback(rawOutput)
  }
  const staticAudit = runMechanicalAudit(extractedFiles)
  const stageableFiles =
    staticAudit.passed && Object.keys(extractedFiles).length > 0
      ? injectBoilerplate(extractedFiles, agentKey)
      : undefined
  return { extractedFiles, staticAudit, stageableFiles }
}

// 6. IPC Invocation Pipeline & Conversation Handlers
const typedIpc = ipcMain as any

typedIpc.handle('conversation:create', async (_event: any, { mode, title }: { mode: ConversationMode; title?: string }) => {
  return await createConversation(mode, title)
})

typedIpc.handle('conversation:list', async () => {
  return await listConversations()
})

typedIpc.handle('conversation:get', async (_event: any, id: string) => {
  return await getConversation(id)
})

typedIpc.handle('conversation:delete', async (_event: any, id: string) => {
  await deleteConversation(id)
  return { success: true }
})

typedIpc.handle('conversation:rename', async (_event: any, { id, title }: { id: string; title: string }) => {
  await renameConversation(id, title)
  return { success: true }
})

typedIpc.handle('workspace:index', async (_event: any, targetPath?: string) => {
  try {
    const dirToIndex = targetPath || path.join(__dirname, '../../')
    const { indexed, failed, pruned } = await indexWorkspace(dirToIndex)
    return { success: true, indexedFiles: indexed, failedFiles: failed, prunedFiles: pruned }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// FIXED: this channel's real shape (per the actual preload) is
// (conversationId, agentName, prompt) -- agentName was originally meant
// for direct chat with Jim/Dwight/Pam, a feature that was planned but
// never actually built. My first version of this handler only expected
// (conversationId, prompt), which would have silently misread whatever
// the renderer sent as agentName as if it were the prompt. Now it reads
// agentName correctly and branches on it.
typedIpc.handle('agent:invoke', async (_event: any, { conversationId, agentName, prompt }: { conversationId: string; agentName: 'jim' | 'dwight' | 'pam' | 'chat'; prompt: string }) => {
  const newMessages: any[] = []
  try {
    const userMsg = await addMessage(conversationId, 'user', prompt)
    newMessages.push(userMsg)

    if (agentName === 'chat') {
      const existing = await getConversation(conversationId)
      const history = (existing?.messages || [])
        .filter((m: any) => m.role === 'user' || m.role === 'chat')
        .map((m: any) => ({ role: (m.role === 'chat' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }))

      const response = await fetchChatCompletion(PROMPTS.GENERAL_CHAT, history)
      const chatMsg = await addMessage(conversationId, 'chat', response)
      newMessages.push(chatMsg)
      return { success: true, messages: newMessages }
    }

    // Direct chat with Jim/Dwight/Pam (skipping Michael's routing) is the
    // original, still-unbuilt feature this channel was designed for.
    // Failing clearly here beats guessing at behavior for something that
    // was never actually implemented.
    const errMsg = await addMessage(conversationId, 'error', `Direct chat with ${agentName} isn't implemented yet -- only general chat mode is currently wired up.`)
    return { success: false, messages: [...newMessages, errMsg] }
  } catch (error: any) {
    const errMsg = await addMessage(conversationId, 'error', error.message || 'Chat error.')
    return { success: false, messages: [...newMessages, errMsg] }
  }
})

// This is now the ONE handler every message goes through -- one chatbox,
// no mode to pick. Michael sees the whole conversation and decides for
// himself whether to just answer, or bring in a specialist.
typedIpc.handle('ai:invoke', async (_event: any, { conversationId, prompt }: { conversationId: string; prompt: string }) => {
  const newMessages: any[] = []
  try {
    const userMsg = await addMessage(conversationId, 'user', prompt)
    newMessages.push(userMsg)

    let projectContext = ''
    let retrievedFiles: string[] = []
    try {
      const queryVector = await generateEmbedding(prompt)
      const matches = await searchRelevantCode(queryVector, 3)
      if (matches && matches.length > 0) {
        retrievedFiles = matches.map((m: any) => `${m.filePath} (${m.score.toFixed(3)})`)
        projectContext = `\n\n[RELEVANT PROJECT CONTEXT FROM MEMORY]:\n` +
          matches.map((m: any) => `--- ${m.filePath} (Similarity: ${m.score.toFixed(3)}) ---\n${m.content}`).join('\n\n')
      }
    } catch {
      // Proceed without context if retrieval fails.
    }

    // NEW: Michael now sees the whole conversation, not just the latest
    // message -- otherwise casual back-and-forth ("forget the commute
    // one, just compare the other two") wouldn't work here the way it did
    // in the old separate chat mode, since he'd have no memory of what
    // came before.
    const existing = await getConversation(conversationId)
    const michaelHistory = (existing?.messages || [])
      .filter((m: any) => m.role === 'user' || m.role === 'michael')
      .map((m: any) => ({ role: (m.role === 'michael' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }))

    const managerResponse = await fetchChatCompletion(PROMPTS.MICHAEL_MANAGER, michaelHistory)
    let decision: { action: 'delegate' | 'respond'; assignTo?: string; instructions?: string; response?: string }

    try {
      const jsonMatch = managerResponse.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error("No JSON structure found")
      decision = JSON.parse(jsonMatch[0])
    } catch {
      const errMessage = await addMessage(conversationId, 'error', "Manager routing failed: malformed JSON response.")
      return { success: false, messages: [...newMessages, errMessage] }
    }

    // NEW: Michael can just answer directly -- no specialist, no Gate 1,
    // no Pam. This is the whole reason one chatbox can now do both
    // casual conversation and real build requests without switching.
    if (decision.action === 'respond') {
      const michaelMsg = await addMessage(conversationId, 'michael', decision.response || '(no response)')
      newMessages.push(michaelMsg)
      return { success: true, messages: newMessages }
    }

    const ragNote = retrievedFiles.length > 0
      ? `\n\n[RAG] Retrieved context from: ${retrievedFiles.join(', ')}`
      : `\n\n[RAG] No relevant project context retrieved.`
    const michaelMsg = await addMessage(conversationId, 'michael', `Delegating to ${decision.assignTo}: ${decision.instructions}${ragNote}`)
    newMessages.push(michaelMsg)

    const agentKey: 'jim' | 'dwight' | 'riley' =
      decision.assignTo === 'Dwight' ? 'dwight' :
      decision.assignTo === 'Riley' ? 'riley' :
      'jim'
    const targetPrompt =
      agentKey === 'dwight' ? PROMPTS.DWIGHT_BACKEND :
      agentKey === 'riley' ? PROMPTS.RILEY_DOCS :
      PROMPTS.JIM_FRONTEND

    // Automatic correction loop. Round 1 is the original attempt; rounds
    // after that feed either Gate 1's blockers (structured, no parsing
    // needed) or Pam's review text (now forced into a strict PAM_VERDICT
    // line so code can read it) straight back to the specialist and try
    // again -- capped at MAX_AUTO_FIX_ROUNDS so a never-satisfied Pam
    // can't loop forever.
    const baseInstructions = decision.instructions || ''
    let currentInstructions = baseInstructions + projectContext
    let specialistOutput = ''
    let staticAudit: AuditResult
    let stageableFiles: Record<string, string> | undefined

    for (let round = 1; round <= MAX_AUTO_FIX_ROUNDS; round++) {
      const roundTag = MAX_AUTO_FIX_ROUNDS > 1 ? ` (attempt ${round} of ${MAX_AUTO_FIX_ROUNDS})` : ''

      specialistOutput = await fetchFrontierAI(targetPrompt, currentInstructions)
      const auditResult = auditAndStage(specialistOutput, agentKey)
      staticAudit = auditResult.staticAudit
      stageableFiles = auditResult.stageableFiles

      if (!staticAudit.passed) {
        if (round < MAX_AUTO_FIX_ROUNDS) {
          newMessages.push(await addMessage(
            conversationId,
            agentKey,
            `${specialistOutput}\n\n[Gate 1 blocked this attempt${roundTag} -- retrying automatically]`
          ))
          currentInstructions = `${baseInstructions}${projectContext}\n\nYour previous attempt was rejected by the automated security check. Fix ALL of these before trying again:\n- ${staticAudit.blockers.join('\n- ')}`
          continue
        }
        const errMsg = await addMessage(conversationId, 'error', `Gate 1 Hard Blockers Enforced (after ${round} attempts):\n- ${staticAudit.blockers.join('\n- ')}`)
        return { success: false, messages: [...newMessages, errMsg] }
      }

      const agentMsg = await addMessage(conversationId, agentKey, specialistOutput + roundTag, stageableFiles)
      newMessages.push(agentMsg)

      const warningContext = staticAudit.warnings.length > 0
        ? `\n\n[Gate 1 Heuristic Warnings to Review]:\n- ${staticAudit.warnings.join('\n- ')}`
        : ''

      const pamReview = await fetchFrontierAI(PROMPTS.PAM_AUDITOR_LOGIC, specialistOutput + warningContext)
      const pamMsg = await addMessage(conversationId, 'pam', pamReview)
      newMessages.push(pamMsg)

      const verdictMatch = pamReview.match(/PAM_VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/i)
      const approved = verdictMatch ? verdictMatch[1].toUpperCase() === 'APPROVED' : false

      if (approved || round === MAX_AUTO_FIX_ROUNDS) {
        break
      }

      currentInstructions = `${baseInstructions}${projectContext}\n\nYour previous attempt received this QA feedback -- address it before trying again:\n${pamReview}`
    }

    return { success: true, messages: newMessages, files: stageableFiles, agentKey, instructions: baseInstructions }
  } catch (error: any) {
    const errMsg = await addMessage(conversationId, 'error', error.message || 'Fatal pipeline error.')
    return { success: false, messages: [...newMessages, errMsg] }
  }
})

// NEW: self-healing. Called from the renderer AFTER code has already
// passed Gate 1 and Pam and been staged, but then actually failed when
// run in the sandbox -- a category of failure neither of those checks
// can see, since neither of them executes anything.
typedIpc.handle('heal:invoke', async (_event: any, {
  conversationId, agentKey, previousInstructions, errorLog, attempt
}: {
  conversationId: string
  agentKey: 'jim' | 'dwight' | 'riley'
  previousInstructions: string
  errorLog: string
  attempt: number
}) => {
  const newMessages: any[] = []
  try {
    if (attempt > MAX_SELF_HEAL_ROUNDS) {
      const errMsg = await addMessage(
        conversationId,
        'error',
        `Self-healing gave up after ${MAX_SELF_HEAL_ROUNDS} attempts -- the code still doesn't run. This needs a manual look.`
      )
      return { success: false, messages: [errMsg] }
    }

    const targetPrompt =
      agentKey === 'dwight' ? PROMPTS.DWIGHT_BACKEND :
      agentKey === 'riley' ? PROMPTS.RILEY_DOCS :
      PROMPTS.JIM_FRONTEND

    const healingInstructions = `${previousInstructions}\n\nYour previous code passed review, but FAILED WHEN ACTUALLY RUN. Here is the real error:\n\n${errorLog}\n\nFix the specific problem causing this error. Do not change anything else.`

    const specialistOutput = await fetchFrontierAI(targetPrompt, healingInstructions)
    const { staticAudit, stageableFiles } = auditAndStage(specialistOutput, agentKey)

    // A self-heal fix still has to clear Gate 1 like anything else -- a
    // repair is not a shortcut around the same safety check everything
    // else goes through.
    if (!staticAudit.passed) {
      const errMsg = await addMessage(
        conversationId,
        'error',
        `Self-healing attempt ${attempt} was rejected by Gate 1:\n- ${staticAudit.blockers.join('\n- ')}`
      )
      return { success: false, messages: [errMsg] }
    }

    const agentMsg = await addMessage(
      conversationId,
      agentKey,
      `${specialistOutput}\n\n[Self-healing attempt ${attempt} of ${MAX_SELF_HEAL_ROUNDS} -- fixing a real runtime failure]`,
      stageableFiles
    )
    newMessages.push(agentMsg)

    // Re-run Pam too -- a runtime fix deserves the same review any other
    // change would get, not a pass just because it's a repair.
    const pamReview = await fetchFrontierAI(PROMPTS.PAM_AUDITOR_LOGIC, specialistOutput)
    const pamMsg = await addMessage(conversationId, 'pam', pamReview)
    newMessages.push(pamMsg)

    return { success: true, messages: newMessages, files: stageableFiles, agentKey, instructions: previousInstructions }
  } catch (error: any) {
    const errMsg = await addMessage(conversationId, 'error', error.message || 'Self-healing failed.')
    return { success: false, messages: [errMsg] }
  }
})

typedIpc.handle('fs:write', async (_event: any, { targetDirectory, files }: { targetDirectory: string; files: Record<string, string> }) => {
  try {
    const writtenPaths: string[] = []
    const resolvedTarget = path.resolve(targetDirectory)

    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.resolve(resolvedTarget, relativePath)

      const isInsideTarget =
        absolutePath === resolvedTarget || absolutePath.startsWith(resolvedTarget + path.sep)
      if (!isInsideTarget) {
        throw new Error(`Refused to write outside target directory: "${relativePath}" resolved to ${absolutePath}`)
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, content, 'utf-8')
      writtenPaths.push(absolutePath)
    }

    return { success: true, writtenFiles: writtenPaths }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// 7. Window Configuration
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#131314',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }

    delete responseHeaders['Content-Security-Policy']
    delete responseHeaders['content-security-policy']

    if (details.url.includes('localhost') || details.url.includes('127.0.0.1')) {
      responseHeaders['Cross-Origin-Embedder-Policy'] = ['credentialless']
      responseHeaders['Cross-Origin-Opener-Policy'] = ['same-origin']
      responseHeaders['Content-Security-Policy'] = [
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src * data: blob:; worker-src * data: blob:;"
      ]
    }

    callback({ responseHeaders })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.disableHardwareAcceleration()

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })