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

// 1. Native Google Gemini API Wrapper
async function fetchFrontierAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash'

  if (!apiKey) throw new Error('Missing GEMINI_API_KEY in environment.')

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 40000)

  try {
    // Fixed: Using proper backticks so `${model}` interpolates correctly without breaking interchangeability
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\nUser Request: ${userPrompt}` }]
          }
        ],
        generationConfig: {
          temperature: 0.2
        }
      }),
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`API Error (${response.status}): ${errText}`)
    }

    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  } catch (err: any) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('API Request timed out after 40 seconds.')
    }
    throw err
  }
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
function isFrontendOutput(files: Record<string, string>, agentKey?: 'jim' | 'dwight'): boolean {
  if (agentKey) return agentKey !== 'dwight'
  return Object.entries(files).some(([filename, content]) =>
    filename.endsWith('.tsx') || filename.endsWith('.jsx') || /from ['"]react['"]/.test(content)
  )
}

function findBackendEntryFile(files: Record<string, string>): string | null {
  const listenFile = Object.entries(files).find(([, content]) => /\.listen\s*\(/.test(content))
  if (listenFile) return listenFile[0]
  const tsFile = Object.keys(files).find(f => f.endsWith('.ts'))
  return tsFile ?? null
}

function injectFrontendBoilerplate(extractedFiles: Record<string, string>): Record<string, string> {
  const hasAppComponent = Object.keys(extractedFiles).includes('src/App.tsx')

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
      ? `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport './assets/main.css'\n\nReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n)`
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

function injectBoilerplate(extractedFiles: Record<string, string>, agentKey?: 'jim' | 'dwight'): Record<string, string> {
  if (Object.keys(extractedFiles).length === 0) return extractedFiles
  return isFrontendOutput(extractedFiles, agentKey)
    ? injectFrontendBoilerplate(extractedFiles)
    : injectBackendBoilerplate(extractedFiles)
}

// 5. System Prompts
const PROMPTS = {
  MICHAEL_MANAGER: `You are Michael, the Lead Orchestrator. Output ONLY a valid JSON object.
Format:
{
  "action": "delegate",
  "assignTo": "Jim" | "Dwight",
  "instructions": "<concise implementation instructions>"
}`,
  JIM_FRONTEND: `You are Jim, Frontend Specialist. Write complete, functional React/TypeScript code using Tailwind CSS.
ALWAYS wrap your code in standard Markdown code blocks (e.g., \`\`\`tsx ).
ALWAYS declare file paths at the very start of the code blocks (e.g., // File: src/App.tsx).
CRITICAL: You are ONLY allowed to use 'react', 'lucide-react', and 'canvas-confetti' as external dependencies. Do not import anything else.`,
  DWIGHT_BACKEND: `You are Dwight, Backend Specialist. Write complete, functional Node.js/TypeScript code using Express.
ALWAYS wrap your code in standard Markdown code blocks (e.g., \`\`\`ts ).
ALWAYS declare file paths at the very start of the code blocks (e.g., // File: src/server.ts).
CRITICAL: You are ONLY allowed to use 'express', 'cors', 'bcryptjs', 'jsonwebtoken', 'zod', and 'dotenv' as external dependencies. Do not import anything else. In particular, never import 'bcrypt' -- use 'bcryptjs' instead, since this code runs inside a browser-based WebContainer sandbox that cannot compile native Node addons.`,
  PAM_AUDITOR_LOGIC: `You are Pam, the QA Auditor. Mechanical checks have passed.
Review the code for logical correctness, security vulnerabilities, edge cases, and missing input validation.`
}

function auditAndStage(rawOutput: string, agentKey?: 'jim' | 'dwight') {
  const extractedFiles = extractCodeBlocks(rawOutput)
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

    const managerResponse = await fetchFrontierAI(PROMPTS.MICHAEL_MANAGER, prompt)
    let delegation: { action: string; assignTo: string; instructions: string }

    try {
      const jsonMatch = managerResponse.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error("No JSON structure found")
      delegation = JSON.parse(jsonMatch[0])
    } catch {
      const errMessage = await addMessage(conversationId, 'error', "Manager routing failed: malformed JSON response.")
      return { success: false, messages: [...newMessages, errMessage] }
    }

    const ragNote = retrievedFiles.length > 0
      ? `\n\n[RAG] Retrieved context from: ${retrievedFiles.join(', ')}`
      : `\n\n[RAG] No relevant project context retrieved.`
    const michaelMsg = await addMessage(conversationId, 'michael', `Delegating to ${delegation.assignTo}: ${delegation.instructions}${ragNote}`)
    newMessages.push(michaelMsg)

    const agentKey: 'jim' | 'dwight' = delegation.assignTo === 'Dwight' ? 'dwight' : 'jim'
    const targetPrompt = agentKey === 'dwight' ? PROMPTS.DWIGHT_BACKEND : PROMPTS.JIM_FRONTEND
    const fullInstructions = delegation.instructions + projectContext
    const specialistOutput = await fetchFrontierAI(targetPrompt, fullInstructions)

    const { staticAudit, stageableFiles } = auditAndStage(specialistOutput, agentKey)
    if (!staticAudit.passed) {
      const errMsg = await addMessage(conversationId, 'error', `Gate 1 Hard Blockers Enforced:\n- ${staticAudit.blockers.join('\n- ')}`)
      return { success: false, messages: [...newMessages, errMsg] }
    }

    const agentMsg = await addMessage(conversationId, agentKey, specialistOutput, stageableFiles)
    newMessages.push(agentMsg)

    const warningContext = staticAudit.warnings.length > 0
      ? `\n\n[Gate 1 Heuristic Warnings to Review]:\n- ${staticAudit.warnings.join('\n- ')}`
      : ''

    const finalAudit = await fetchFrontierAI(PROMPTS.PAM_AUDITOR_LOGIC, specialistOutput + warningContext)
    const pamMsg = await addMessage(conversationId, 'pam', finalAudit)
    newMessages.push(pamMsg)

    return { success: true, messages: newMessages, files: stageableFiles }
  } catch (error: any) {
    const errMsg = await addMessage(conversationId, 'error', error.message || 'Fatal pipeline error.')
    return { success: false, messages: [...newMessages, errMsg] }
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