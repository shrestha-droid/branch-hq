import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as dotenv from 'dotenv'
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
import { getSettings, updateSettings } from './settingsStore'
import { recordAudit, generateAuditReport, markExecutionVerified } from './auditStore'
import { runMechanicalAudit, AuditResult } from './gate1'
import { looksTransient } from './resilience'

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
  generate(systemPrompt: string, history: ChatTurn[], modelOverride?: string): Promise<string>
}

class GeminiProvider implements ModelProvider {
  // NEW: optional modelOverride lets a caller (the fallback logic below)
  // use a different model than whatever Settings has as primary, without
  // needing a second provider instance or touching Settings itself.
  async generate(systemPrompt: string, history: ChatTurn[], modelOverride?: string): Promise<string> {
    // Model NAME is live-configurable via Settings; the API KEY stays in
    // .env only -- a secret has no business sitting in a plain JSON
    // settings file the same way a model name does.
    const settings = await getSettings()
    const apiKey = process.env.GEMINI_API_KEY
    const model = modelOverride || settings.geminiModel
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
    const settings = await getSettings()
    const baseUrl = settings.localModelBaseUrl // e.g. http://localhost:11434/v1 for Ollama
    const apiKey = process.env.LOCAL_MODEL_API_KEY || 'not-needed' // most local servers ignore this
    const model = settings.localModelName
    if (!baseUrl) throw new Error('Missing local model base URL -- set it in Settings.')

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

// FIXED: previously a singleton created once at startup
// (`const modelProvider = getModelProvider()`), which meant switching
// providers required restarting the whole app. Looking it up fresh here
// means a change made in Settings takes effect on the very next message.
async function selectModelProvider(): Promise<ModelProvider> {
  const settings = await getSettings()
  switch (settings.modelProvider) {
    case 'local':
      return new OpenAICompatibleProvider()
    case 'gemini':
    default:
      return new GeminiProvider()
  }
}

// NEW: usage tracking. One request can quietly fan out into a lot of
// model calls -- Michael routes, a specialist generates, Gate 1 can
// trigger up to 3 retries, Pam reviews each attempt, self-healing can add
// more, and embeddings run separately in the background. Nobody -- including
// the person running this -- could previously see how many calls or how
// much text that actually added up to. Counting at the provider layer
// catches every call, since they all funnel through generate().
//
// Character counts are a ROUGH PROXY for tokens, not real token counts:
// neither provider returns usage data in the shape this reads, and
// characters-per-token varies by model and content. Good enough to spot
// "this request cost 10x what I expected"; NOT good enough to bill anyone.
interface UsageStats {
  callCount: number
  charsIn: number
  charsOut: number
}

const sessionUsage: UsageStats = { callCount: 0, charsIn: 0, charsOut: 0 }
const perConversationUsage = new Map<string, UsageStats>()

// Set around a pipeline run so provider calls can be attributed to the
// right conversation without threading an ID through every call site.
let currentUsageConversationId: string | null = null

function recordUsage(charsIn: number, charsOut: number) {
  sessionUsage.callCount++
  sessionUsage.charsIn += charsIn
  sessionUsage.charsOut += charsOut

  if (currentUsageConversationId) {
    const existing = perConversationUsage.get(currentUsageConversationId)
      || { callCount: 0, charsIn: 0, charsOut: 0 }
    existing.callCount++
    existing.charsIn += charsIn
    existing.charsOut += charsOut
    perConversationUsage.set(currentUsageConversationId, existing)
  }
}

// Wraps whichever provider is configured so counting happens in exactly
// one place regardless of which backend is in use.
// NEW: pipeline-level self-healing, distinct from the code-level version
// elsewhere in this file. That one fixes BROKEN CODE a specialist wrote.
// This fixes THE PIPELINE ITSELF failing to complete a call at all --
// a timeout, a dropped connection, a transient server error. Wrapping it
// here means every single agent (Michael, Jim, Dwight, Riley, Pam, chat,
// even self-healing's own calls) gets this for free, since they already
// all funnel through this one function.
const MAX_TRANSIENT_RETRIES = 2
const TRANSIENT_RETRY_DELAY_MS = 1000

async function withTransientRetry(fn: () => Promise<string>): Promise<string> {
  let lastError: any
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      lastError = err
      if (!looksTransient(err)) throw err
      if (attempt === MAX_TRANSIENT_RETRIES) {
        // NEW: previously re-threw the original error unchanged here,
        // so a call that WAS retried and still failed looked identical
        // to one that was never retried at all -- no way to tell them
        // apart from what the user saw. Now the final failure says so
        // explicitly.
        const totalAttempts = MAX_TRANSIENT_RETRIES + 1
        throw new Error(`${err.message} (retried automatically ${totalAttempts} times -- this looks like a genuine outage on the provider's side, not a Branch HQ problem)`)
      }
      await new Promise(resolve => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS * (attempt + 1)))
    }
  }
  throw lastError
}

const countingProvider: ModelProvider = {
  async generate(systemPrompt: string, history: ChatTurn[]): Promise<string> {
    const charsIn = systemPrompt.length + history.reduce((sum, m) => sum + m.content.length, 0)
    const settings = await getSettings()
    const provider = await selectModelProvider()

    try {
      const result = await withTransientRetry(() => provider.generate(systemPrompt, history))
      recordUsage(charsIn, result.length)
      return result
    } catch (err: any) {
      // NEW: if the primary model is persistently down (not just a bad
      // prompt -- withTransientRetry only reaches here after genuinely
      // exhausting retries on something that looked like a real outage)
      // and a fallback model is configured, try that once before giving
      // up entirely. Deliberately same-provider-only: Gemini falling
      // back to a different Gemini model doesn't depend on anything
      // else being set up correctly, unlike a cross-provider fallback
      // to local routing would.
      if (settings.modelProvider === 'gemini' && settings.fallbackGeminiModel && looksTransient(err)) {
        try {
          const result = await withTransientRetry(() => provider.generate(systemPrompt, history, settings.fallbackGeminiModel))
          recordUsage(charsIn, result.length)
          return result
        } catch (fallbackErr: any) {
          // FIXED: previously, if the fallback ALSO failed, the original
          // primary-model error was silently discarded -- the user would
          // only ever see the fallback's error, with no way to tell this
          // was actually a dual failure or what the primary problem was.
          throw new Error(`Primary model failed (${err.message}); fallback also failed (${fallbackErr.message})`)
        }
      }
      throw err
    }
  }
}

// Kept as the same function names/signatures every existing call site
// already uses -- Michael, Jim, Dwight, Riley, Pam, chat, and
// self-healing all call these exactly as before. Only the inside changed.
async function fetchFrontierAI(systemPrompt: string, userPrompt: string): Promise<string> {
  return countingProvider.generate(systemPrompt, [{ role: 'user', content: userPrompt }])
}

async function fetchChatCompletion(systemPrompt: string, history: ChatTurn[]): Promise<string> {
  return countingProvider.generate(systemPrompt, history)
}

// 2. Gate 1 (deterministic security linter) -- logic now lives in
// ./gate1.ts so it can be unit tested without booting Electron.

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
        "canvas-confetti": "^1.9.2",
        "framer-motion": "^11.0.0"
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
        "dotenv": "^16.4.5",
        "lowdb": "^7.0.1",
        "express-rate-limit": "^7.2.0"
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
CRITICAL: You are ONLY allowed to use 'react', 'lucide-react', 'canvas-confetti', and 'framer-motion' as external dependencies. Do not import anything else. For real typography (not just system fonts), you may still add a single <link> or @import for a Google Font in your CSS -- this does not require an npm package and is not a dependency violation.

DESIGN APPROACH -- follow this before writing any code:
Act like a design lead giving every request its own distinct visual identity, never a template. In a short comment block at the top of your first file, plan: 2-4 named colors as hex values, two font roles (one characterful display face used with restraint, one plain body face), and one signature visual element specific to what's actually being built. Then build exactly that plan -- don't let the code drift back to defaults.

AVOID THESE -- they are tells of generic AI-generated UI, not real design choices:
- Purple-to-indigo gradients, especially on buttons or hero sections
- Frosted-glass/blur cards (backdrop-blur, translucent panels) used by default
- A near-black background with one glowing blue/neon accent and ambient blur circles
- A cream background with a warm serif and a terracotta/clay accent (a well-known AI-default look)
- Numbered badges (01 / 02 / 03) unless the content is genuinely an ordered sequence
- Animation on every element -- motion should be rare and deliberate, not scattered everywhere

WHEN MOTION GENUINELY SERVES THE DESIGN, you now have framer-motion available -- reach for one of these named, specific techniques rather than a generic fade-in. Pick what's genuinely appropriate to the build, not all of them at once, and never let this override the restraint rule above:
- Scroll-triggered reveal: elements animate in once as they enter the viewport (whileInView + viewport={{ once: true }}), not on every scroll pass
- Staggered children: a list or grid where each item's entrance is offset slightly (staggerChildren) instead of all appearing at once
- Animated text reveal: a heading's words or characters animate in individually on mount, for a hero or title moment specifically -- not body text
- Magnetic hover: a button or card subtly shifts toward the cursor within a small radius, using onMouseMove + a spring-based transform
- Layout animation: an element smoothly reflows to a new position/size when content changes (the layout prop), instead of snapping
- Shared element transition: a clicked card visually morphs into its expanded/detail view (layoutId) rather than a hard cut
- Animated number counter: a stat counts up from 0 to its real value once, when it first enters view -- not on every render
- Aurora/mesh gradient background: pure CSS, no dependency needed -- several large, soft, slowly-drifting blurred gradient shapes behind content, distinct from the "one glowing blue accent" AI tell above by using the build's own actual palette and genuine slow motion, not a static glow

A financial dashboard, a kids' game, and a developer tool should never end up looking like the same template in different colors. Match the whole visual style to what's actually being built.`,
  DWIGHT_BACKEND: `You are Dwight, Backend Specialist. Write complete, functional Node.js/TypeScript code using Express.
ALWAYS wrap your code in standard Markdown code blocks (e.g., \`\`\`ts ).
ALWAYS declare file paths at the very start of the code blocks (e.g., // File: src/server.ts).
CRITICAL: You are ONLY allowed to use 'express', 'cors', 'bcryptjs', 'jsonwebtoken', 'zod', 'dotenv', 'lowdb', and 'express-rate-limit' as external dependencies. Do not import anything else. In particular, never import 'bcrypt' -- use 'bcryptjs' instead, since this code runs inside a browser-based WebContainer sandbox that cannot compile native Node addons. For unique IDs, use Node's built-in crypto.randomUUID() -- no separate package needed.

APPROACH -- follow this before writing any code:
Act like a senior backend engineer reviewing a junior's first draft, not someone who just wants the endpoint to respond. Before writing code, briefly consider: what actually goes wrong with this request in the real world -- bad input, a resource that doesn't exist, a duplicate submission, no auth -- and what response shape communicates that clearly, not just "it works" for the one happy path.

AVOID THESE -- they are tells of a lazy, generic backend, not real engineering:
- Returning 200 for every response regardless of what actually happened, success or failure
- One catch-all try/catch that does res.status(500).send('Error') with no distinction between what went wrong
- Validation that only checks a field is present, never its shape, type, or bounds
- An endpoint that only works for the happy path, with no handling for a missing resource or a duplicate entry
- Storing anything in a plain in-memory array or object and calling it "the database" -- real persistence is available now, use it
- Skipping hashing or validation "for now, it's just a prototype" -- Gate 1 will block it anyway, and it's not real practice either way

NEW: you now have real persistence available (lowdb) and real rate limiting (express-rate-limit) -- reach for these specific, named techniques where they genuinely fit the request, not as a checklist to force into every response:
- Real persistence via lowdb: data written in one request is actually still there on the next one, backed by a real JSON file in the sandbox -- not an array that resets. Use this by default for anything that should survive between requests.
- Rate limiting on anything a real attacker would abuse: login, registration, password reset, search -- apply express-rate-limit directly on that route, not globally on the whole app if only one route actually needs it.
- Meaningful status codes: 201 for something created, 404 for a resource that doesn't exist, 409 for a duplicate/conflict, 422 for a validation failure that's well-formed but semantically wrong -- not just 200 and 500 for everything.
- A consistent error shape across the whole API (e.g. { error: { code, message } }), not a different ad hoc string per route.
- Pagination (?page=, ?limit=) on any endpoint that returns a list, instead of dumping the entire dataset back every time.
- Field-level validation errors from zod surfaced clearly to the client (which field, what was wrong), not just a generic "invalid input."

A login endpoint, a public search API, and an internal admin tool have real, different security and reliability needs -- match the actual engineering to what's genuinely being built, not a template.`,
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
CRITICAL: NEVER include your own name or role ("Riley", "Research & Documents Specialist", "Published by...", etc.) anywhere in the actual document content. The document is for the user to give to their own audience -- it must never describe itself as AI-generated or reference who/what produced it.
CRITICAL for page numbers in PDFs: if you add page numbers, add each one incrementally as its page is created (e.g. using pdfkit's 'pageAdded' event, tracking a running count), never in a separate loop after all pages already exist -- that requires switchToPage() and is a common source of every page number landing in the same spot instead of on its own page. A simple running "Page N" without a "of TOTAL" is safer and preferred, since knowing the total in advance requires that same error-prone two-pass approach.
CRITICAL for shapes in PPTX files: every addShape() call's first argument must be a real shape type from pptxgen.ShapeType (e.g. pptxgen.ShapeType.rect, pptxgen.ShapeType.roundRect, pptxgen.ShapeType.line) -- never leave it missing or guess at a name. A confirmed real failure: calling addShape() with a missing or invalid shape type crashes the whole script. If you use the same shape type more than once, use the exact same correct constant every time -- do not vary it.
CRITICAL for PPTX slide width: 'LAYOUT_16X9' is only 10" x 5.625" -- NOT the ~13.3" wide canvas its name suggests. A confirmed real failure: writing multi-column layouts (3-4 cards, wide titles) with x-coordinates going up to 11-12" while using LAYOUT_16X9 silently cuts off everything past x=10" -- titles, whole columns, right-edge cards. pptxgenjs writes coordinates past the slide edge without any warning; they are simply gone from the rendered file. ALWAYS set pres.layout = 'LAYOUT_WIDE' (13.3" x 7.5") for any slide with 3+ columns or a title near full-width, and keep every x + w within that actual boundary.
CRITICAL, separate rule, do not skip this: NEVER add a decorative color bar or accent stripe anywhere in a deck. This is a confirmed, repeated real failure across multiple generations -- it keeps appearing in different forms even after being told to stop once, so read this as covering ALL of the following, not just one of them: a vertical stripe down the left edge of a slide, a horizontal bar across the top of a slide, and a thin colored stripe down the left edge of an individual card or content box (a common habit: giving every card a colored left border to "make it pop"). All three are the same mistake. If a card needs to stand out, use a subtle background color difference or a soft shadow -- never a stripe or bar of any kind, on a slide or on a card.
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

// NEW: two size caps, not compression -- the goal is sending fewer words
// to the model, not the same words in a smaller shape (which wouldn't
// help; the model has to read actual text either way). Both trade a
// small amount of context depth for meaningfully faster, cheaper calls
// as conversations and RAG matches grow.
const MAX_CONTEXT_CHUNK_CHARS = 800
const MICHAEL_HISTORY_WINDOW = 12
const MAX_EXISTING_FILE_CHARS = 2400

// NEW: "check what's actually there first." Specialists previously
// generated as if every request started from a blank project, even when
// a real, existing project already sits on disk in the configured
// target folder -- there was no step where they looked at what
// currently exists before writing something that might silently ignore
// or duplicate it. This is a genuinely LIVE filesystem read, done fresh
// on every delegated request -- not a stale snapshot from the memory
// index, which only updates when someone remembers to click Scan
// Workspace. It's local disk I/O, not a network call, so it's fast
// enough not to undo the pipeline-speed work already done.
async function listProjectFilesShallow(targetDir: string): Promise<string[]> {
  const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out'])
  const results: string[] = []

  async function walk(dir: string, relBase: string) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath)
      } else {
        results.push(relPath)
      }
    }
  }

  await walk(path.resolve(targetDir), '')
  return results
}

async function getExistingProjectSnapshot(targetDir: string, userPrompt: string): Promise<string> {
  if (!targetDir) return ''

  try {
    const allFiles = await listProjectFilesShallow(targetDir)
    if (allFiles.length === 0) return ''

    let snapshot = `\n\n[EXISTING PROJECT FILES -- read live from disk just now, not from memory or a stale index]:\nThis project already has these files:\n${allFiles.map(f => `- ${f}`).join('\n')}`

    // If the request seems to name a specific file, fetch its REAL,
    // current content -- not a similarity-based guess from the memory
    // index, which can be stale the moment a file actually changes.
    const mentionedFile = allFiles.find(f => {
      const base = f.split('/').pop() || ''
      const baseNoExt = base.replace(/\.(tsx?|jsx?)$/i, '')
      return userPrompt.toLowerCase().includes(base.toLowerCase())
        || (baseNoExt.length > 2 && userPrompt.toLowerCase().includes(baseNoExt.toLowerCase()))
    })

    if (mentionedFile) {
      try {
        const fullPath = path.join(path.resolve(targetDir), mentionedFile)
        const fileContent = await fs.readFile(fullPath, 'utf-8')
        const truncated = fileContent.length > MAX_EXISTING_FILE_CHARS
          ? fileContent.slice(0, MAX_EXISTING_FILE_CHARS) + '\n... (truncated)'
          : fileContent
        snapshot += `\n\nCURRENT CONTENT of ${mentionedFile} (read live, right now, not from memory):\n${truncated}\n\nIf your task involves this file, modify it based on what is actually here -- do not silently rewrite it from scratch or ignore what already exists.`
      } catch {
        // Couldn't read it -- proceed with just the file listing.
      }
    }

    return snapshot
  } catch {
    return ''
  }
}

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

// NEW: lets the UI show what a session/conversation has actually cost in
// model calls. See the note on recordUsage -- char counts are a rough
// proxy, not real token accounting.
typedIpc.handle('usage:get', async (_event: any, conversationId?: string) => {
  return {
    success: true,
    session: { ...sessionUsage },
    conversation: conversationId
      ? (perConversationUsage.get(conversationId) || { callCount: 0, charsIn: 0, charsOut: 0 })
      : null
  }
})

// NEW: Settings -- what provider/model/folder to use, live and
// user-editable instead of only settable by hand-editing .env.
typedIpc.handle('settings:get', async () => {
  return await getSettings()
})

typedIpc.handle('settings:set', async (_event: any, partial: any) => {
  return await updateSettings(partial)
})

// NEW: the actual differentiator -- a factual, unedited record of every
// Gate 1 / Pam result for a conversation, with an integrity hash proving
// the report wasn't altered after being generated.
typedIpc.handle('audit:export', async (_event: any, conversationId: string) => {
  try {
    const result = await generateAuditReport(conversationId)
    return { success: true, ...result }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// NEW: called from the renderer -- the only place a sandbox actually
// runs -- the moment a generation has genuinely been executed
// successfully (a web app reached server-ready, or a document script
// produced its real output file). Upgrades that specific record from
// "Pam approved" to "confirmed running." Best-effort: a missing/unknown
// id (e.g. an old conversation reopened without healing context) is not
// an error, just nothing to upgrade.
typedIpc.handle('audit:markExecuted', async (_event: any, auditId: string) => {
  try {
    if (!auditId) return { success: true, updated: false }
    const record = await markExecutionVerified(auditId)
    return { success: true, updated: !!record }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
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
        .slice(-MICHAEL_HISTORY_WINDOW)
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
  currentUsageConversationId = conversationId
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
        // NEW: cap each chunk's length before sending it. Most chunks
        // from AST-based chunking are already reasonably sized, but an
        // occasional large function isn't -- and every extra character
        // here is something the model has to actually read on every
        // single delegated request, not something that compresses away.
        const truncate = (text: string) => text.length > MAX_CONTEXT_CHUNK_CHARS
          ? text.slice(0, MAX_CONTEXT_CHUNK_CHARS) + '\n... (truncated)'
          : text
        projectContext = `\n\n[RELEVANT PROJECT CONTEXT FROM MEMORY]:\n` +
          matches.map((m: any) => `--- ${m.filePath} (Similarity: ${m.score.toFixed(3)}) ---\n${truncate(m.content)}`).join('\n\n')
      }
    } catch {
      // Proceed without context if retrieval fails.
    }

    // NEW: Michael now sees the whole conversation, not just the latest
    // message -- otherwise casual back-and-forth ("forget the commute
    // one, just compare the other two") wouldn't work here the way it did
    // in the old separate chat mode, since he'd have no memory of what
    // came before. Capped to the most recent turns rather than sending
    // the entire history every time -- a long-running conversation would
    // otherwise mean every single new message resends every message that
    // ever preceded it, growing forever and making even a quick "delegate
    // to Jim" decision slower every time.
    const existing = await getConversation(conversationId)
    const michaelHistory = (existing?.messages || [])
      .filter((m: any) => m.role === 'user' || m.role === 'michael')
      .slice(-MICHAEL_HISTORY_WINDOW)
      .map((m: any) => ({ role: (m.role === 'michael' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }))

    // NEW: pipeline self-healing for routing specifically. Previously a
    // single malformed JSON response killed the whole request instantly
    // -- no retry at all. This matters more now that a local model can
    // be in the loop (see selectModelProvider): weaker/self-hosted
    // models are known to be less reliable at strict JSON output than
    // Gemini, so this failure just got more likely to actually happen,
    // not less.
    const MAX_ROUTING_JSON_RETRIES = 2
    let decision: { action: 'delegate' | 'respond'; assignTo?: string; instructions?: string; response?: string } | null = null
    let managerResponse = ''

    for (let jsonAttempt = 1; jsonAttempt <= MAX_ROUTING_JSON_RETRIES; jsonAttempt++) {
      const historyForAttempt = jsonAttempt === 1
        ? michaelHistory
        : [
            ...michaelHistory,
            { role: 'assistant' as const, content: managerResponse },
            { role: 'user' as const, content: 'That was not valid JSON. Respond with ONLY the JSON object -- no explanation, no markdown formatting, nothing else.' }
          ]

      managerResponse = await fetchChatCompletion(PROMPTS.MICHAEL_MANAGER, historyForAttempt)

      try {
        // FIXED: if the model wraps its JSON in a markdown code fence
        // (```json ... ```) with any prose before or after it, the old
        // greedy match-from-first-{-to-last-} could swallow fence
        // markers or extra text along with the real JSON. Stripping
        // fences first is cheap and removes that whole class of failure.
        const withoutFences = managerResponse.replace(/```(?:json)?/gi, '')
        const jsonMatch = withoutFences.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error("No JSON structure found")
        decision = JSON.parse(jsonMatch[0])
        break
      } catch {
        if (jsonAttempt === MAX_ROUTING_JSON_RETRIES) {
          const errMessage = await addMessage(conversationId, 'error', `Manager routing failed after ${MAX_ROUTING_JSON_RETRIES} attempts: malformed JSON response.`)
          return { success: false, messages: [...newMessages, errMessage] }
        }
        // fall through to the next attempt
      }
    }

    if (!decision) {
      const errMessage = await addMessage(conversationId, 'error', "Manager routing failed: no valid decision produced.")
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
    // FIXED: this used to run for every agent, including Riley. Riley
    // produces a standalone document script -- there's no legitimate
    // reason for him to see React/Express source from some other,
    // unrelated project sitting in the target folder. Confirmed real
    // failure pattern: after several code projects had been built, a PPT
    // prompt sharing a word with an old project's filename (e.g. "hero
    // section" matching a leftover Hero.tsx) fed that file's actual
    // source code into Riley's instructions, producing broken output.
    // Only Jim and Dwight legitimately need to see what already exists.
    const settingsForSnapshot = await getSettings()
    const existingProjectSnapshot = agentKey === 'riley'
      ? ''
      : await getExistingProjectSnapshot(settingsForSnapshot.defaultTargetDir, prompt)
    let currentInstructions = baseInstructions + projectContext + existingProjectSnapshot
    let specialistOutput = ''
    let staticAudit: AuditResult
    let stageableFiles: Record<string, string> | undefined

    let latestAuditId: string | null = null

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
          currentInstructions = `${baseInstructions}${projectContext}${existingProjectSnapshot}\n\nYour previous attempt was rejected by the automated security check. Fix ALL of these before trying again:\n- ${staticAudit.blockers.join('\n- ')}`
          continue
        }
        await recordAudit({
          conversationId, agentKey, attempt: round,
          gate1Passed: false, perFile: staticAudit.perFile, pamVerdict: 'UNKNOWN'
        })
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

      const auditRecord = await recordAudit({
        conversationId, agentKey, attempt: round,
        gate1Passed: true, perFile: staticAudit.perFile,
        pamVerdict: verdictMatch ? (verdictMatch[1].toUpperCase() as 'APPROVED' | 'CHANGES_REQUESTED') : 'UNKNOWN'
      })
      latestAuditId = auditRecord.id

      if (approved || round === MAX_AUTO_FIX_ROUNDS) {
        break
      }

      currentInstructions = `${baseInstructions}${projectContext}${existingProjectSnapshot}\n\nYour previous attempt received this QA feedback -- address it before trying again:\n${pamReview}`
    }

    return { success: true, messages: newMessages, files: stageableFiles, agentKey, instructions: baseInstructions, auditId: latestAuditId }
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

    // NEW: the error only points at where execution STOPPED, which can
    // be the first of several identical mistakes, not the only one --
    // confirmed by watching a real case where the same bug moved to a
    // different line between healing attempts instead of disappearing
    // in one try, because only the one instance the error named got
    // fixed each time.
    const healingInstructions = `${previousInstructions}\n\nYour previous code passed review, but FAILED WHEN ACTUALLY RUN. Here is the real error:\n\n${errorLog}\n\nFix the specific problem causing this error. If this exact kind of mistake appears more than once in your code, fix EVERY occurrence, not just the one the error happened to stop at -- the error only shows where execution failed first, which may not be the only instance. Do not change anything else.`

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

    // NEW: previously self-healing produced no audit record at all --
    // any conversation where it fired had a genuinely incomplete audit
    // trail, since the corrected version that actually got staged was
    // never recorded anywhere. Recorded the same way the main pipeline
    // does, so this generation can also be upgraded to execution-verified
    // once the renderer confirms it actually runs.
    const verdictMatch = pamReview.match(/PAM_VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/i)
    const auditRecord = await recordAudit({
      conversationId, agentKey, attempt,
      gate1Passed: true, perFile: staticAudit.perFile,
      pamVerdict: verdictMatch ? (verdictMatch[1].toUpperCase() as 'APPROVED' | 'CHANGES_REQUESTED') : 'UNKNOWN'
    })

    return { success: true, messages: newMessages, files: stageableFiles, agentKey, instructions: previousInstructions, auditId: auditRecord.id }
  } catch (error: any) {
    const errMsg = await addMessage(conversationId, 'error', error.message || 'Self-healing failed.')
    return { success: false, messages: [errMsg] }
  }
})

// NEW: dry-run check. Reports which files already exist at the target
// path WITHOUT writing anything, so the UI can warn before overwriting
// rather than silently replacing someone's real work.
typedIpc.handle('fs:checkConflicts', async (_event: any, { targetDirectory, files }: { targetDirectory: string; files: Record<string, string> }) => {
  try {
    const resolvedTarget = path.resolve(targetDirectory)
    const conflicts: string[] = []

    for (const relativePath of Object.keys(files)) {
      const absolutePath = path.resolve(resolvedTarget, relativePath)
      const isInsideTarget =
        absolutePath === resolvedTarget || absolutePath.startsWith(resolvedTarget + path.sep)
      if (!isInsideTarget) continue

      try {
        await fs.access(absolutePath)
        conflicts.push(relativePath)
      } catch {
        // Doesn't exist -- not a conflict, nothing to warn about.
      }
    }

    return { success: true, conflicts }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

typedIpc.handle('fs:write', async (_event: any, { targetDirectory, files, overwriteConfirmed }: { targetDirectory: string; files: Record<string, string>; overwriteConfirmed?: boolean }) => {
  try {
    const writtenPaths: string[] = []
    const skippedPaths: string[] = []
    const resolvedTarget = path.resolve(targetDirectory)

    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.resolve(resolvedTarget, relativePath)

      const isInsideTarget =
        absolutePath === resolvedTarget || absolutePath.startsWith(resolvedTarget + path.sep)
      if (!isInsideTarget) {
        throw new Error(`Refused to write outside target directory: "${relativePath}" resolved to ${absolutePath}`)
      }

      // NEW: unless overwriting was explicitly confirmed, leave existing
      // files alone. Previously this silently replaced whatever was
      // there -- fine for an empty output folder, potentially destructive
      // when pointed at a real project.
      if (!overwriteConfirmed) {
        try {
          await fs.access(absolutePath)
          skippedPaths.push(relativePath)
          continue
        } catch {
          // Doesn't exist -- safe to write.
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, content, 'utf-8')
      writtenPaths.push(absolutePath)
    }

    return { success: true, writtenFiles: writtenPaths, skippedFiles: skippedPaths }
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

  // NEW: previously nothing was configured here at all, and modern
  // Electron blocks target="_blank"/window.open by default unless a
  // handler explicitly allows it -- meaning the "Open Externally" link
  // in the sandbox panel was very likely doing nothing when clicked.
  // This routes it to the OS's real default browser. Worth knowing
  // honestly: a WebContainer preview URL depends on cross-origin
  // isolation and virtual networking specific to the context that
  // booted it (see the custom COOP/COEP headers below, only applied
  // here inside the app) -- opening it in a genuinely separate browser
  // process may not always render correctly, since that separate
  // process never gets those same headers. This fix makes the click
  // actually do something real; it does not guarantee the WebContainer
  // preview specifically will load outside the app every time.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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