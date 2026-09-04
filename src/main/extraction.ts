import { runMechanicalAudit, AuditResult } from './gate1'

// NEW: pulled out of index.ts for exactly the same reason gate1.ts was
// -- index.ts boots the entire Electron app the moment it's imported
// (app.whenReady(), IPC handler registration, all at module load time),
// so nothing defined inside it can be unit-tested without actually
// starting Electron. This file has zero Electron dependencies and zero
// top-level side effects, same as gate1.ts -- it can be imported
// directly by vitest. index.ts now imports FROM here instead of
// defining these functions inline.
//
// This is specifically the extraction/merging/prefixing logic --
// deliberately chosen as the first thing pulled out and given real
// test coverage, because this is exactly where tonight's worst
// confirmed bugs actually lived: the zero-extraction vacuous-pass bug
// (auditAndStage), and the missing server/-prefix bug that caused
// Dwight's backend to be silently misidentified as frontend content
// and run through a spawn path with no port-collision protection
// (prefixStageableFiles). Gate 1 checks whether code is SAFE;
// resilience.ts checks whether a failure is worth retrying; this file
// is what decides whether a specialist's raw output even correctly
// BECOMES the files everything downstream assumes it is -- getting
// that step wrong is exactly what several of tonight's real incidents
// traced back to.


// 2. Gate 1 (deterministic security linter) -- logic now lives in
// ./gate1.ts so it can be unit tested without booting Electron.

// 3. Robust Artifact Extractor with Path Normalization
export function normalizeFilePath(rawPath: string): string {
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


export function extractCodeBlocks(markdown: string): Record<string, string> {
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

    // FIXED: previously required the ENTIRE first line to be nothing but
    // the file-path comment (anchored with $ at the end). Confirmed real
    // failure: when a model puts the start of another comment on that
    // same line right after the path (e.g. "// File: src/App.tsx /*
    // DESIGN PLAN: ..."), the old regex failed to match at all -- zero
    // files got extracted, Gate 1 trivially "passed" on an empty file
    // set, and everything silently vanished with nothing staged, even
    // though Pam had reviewed and approved the real underlying code (she
    // sees the raw text, not the failed extraction). No longer anchored
    // to end-of-line -- just capture the path and stop there.
    const commentMatch = firstLine.match(/^(?:\/\/|#|\/\*)\s*(?:(?:file|filename):\s*)?([\w./-]+)/i)

    if (commentMatch) {
      const filename = normalizeFilePath(commentMatch[1])
      if (!files[filename]) {
        // NEW: don't just drop the whole first line -- keep whatever
        // followed the matched path on that same line (like the start of
        // a design-plan comment) instead of losing it, which would
        // otherwise leave a dangling, unopened closing marker later in
        // the file.
        const matchEndIndex = (commentMatch.index ?? 0) + commentMatch[0].length
        const restOfFirstLine = firstLine.slice(matchEndIndex).trim()
        const remainingLines = content.split('\n').slice(1).join('\n')
        const cleanContent = (restOfFirstLine ? restOfFirstLine + '\n' : '') + remainingLines
        files[filename] = cleanContent.trim()
      }
    }
  }

  return files
}


// 4. Virtual Environment Scaffolder
export function findBackendEntryFile(files: Record<string, string>): string | null {
  const listenFile = Object.entries(files).find(([, content]) => /\.listen\s*\(/.test(content))
  if (listenFile) return listenFile[0]
  const tsFile = Object.keys(files).find(f => f.endsWith('.ts'))
  return tsFile ?? null
}


export function injectFrontendBoilerplate(extractedFiles: Record<string, string>): Record<string, string> {
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
        "@types/react": "^18.2.66",
        "@types/react-dom": "^18.2.22",
        "@types/canvas-confetti": "^1.6.4",
        "tailwindcss": "^3.4.1",
        "postcss": "^8.4.35",
        "autoprefixer": "^10.4.17"
      }
    }, null, 2),
    'vite.config.ts': `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { port: 3000, strictPort: false }\n})`,
    'tailwind.config.js': `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: [\n    "./index.html",\n    "./src/**/*.{js,ts,jsx,tsx}",\n  ],\n  theme: {\n    extend: {},\n  },\n  plugins: [],\n}`,
    'postcss.config.js': `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}`,
    // NEW: confirmed real, long-standing bug -- the build script below
    // runs `tsc`, but no tsconfig.json was ever generated for it to
    // use. With no config and nothing explicit to compile, tsc's real,
    // documented fallback is to print its own help/usage text and exit
    // with an error -- exactly what a real Vercel deploy surfaced,
    // since this is the first time the build script (as opposed to
    // `npm run dev`, which never touches tsc at all) had ever actually
    // been exercised. Standard Vite+React+TS config, matching what
    // `npm create vite` itself generates. noEmit is correct here --
    // Vite's own build step does the actual bundling; tsc's only job
    // in "tsc && vite build" is type-checking.
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        useDefineForClassFields: true,
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
        esModuleInterop: true
      },
      include: ["src"]
    }, null, 2),
    'index.html': `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Sandbox Preview</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script>\n      // NEW: confirmed real gap -- errors happening inside this page\n      // after it loads (a bad import, a runtime exception) were never\n      // detected at all, meaning self-healing had zero chance to ever\n      // see or fix them. Registered before the app's own module below,\n      // so it catches even module-load-time errors, not just ones\n      // after React mounts.\n      window.addEventListener('error', function(e) {\n        try {\n          window.parent.postMessage({ type: 'branch-hq-runtime-error', message: (e.error && e.error.stack) || e.message || String(e) }, '*')\n        } catch (err) {}\n      })\n      window.addEventListener('unhandledrejection', function(e) {\n        try {\n          window.parent.postMessage({ type: 'branch-hq-runtime-error', message: 'Unhandled promise rejection: ' + ((e.reason && e.reason.stack) || e.reason || String(e)) }, '*')\n        } catch (err) {}\n      })\n    </script>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>`,
    'src/main.tsx': hasAppComponent
      ? `import React from 'react'\nimport ReactDOM from 'react-dom/client'\n${appImportLine}\nimport './assets/main.css'\n\nReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n)`
      : `import './assets/main.css'\n\n// No src/App.tsx in this response -- likely a utility/non-visual file\n// (constants, types, helpers), not a renderable component. Nothing to\n// mount here; see the Code tab for what was actually generated.\nconst root = document.getElementById('root')\nif (root) {\n  root.innerHTML = '<div style="font-family: monospace; padding: 2rem; color: #888;">No root App component in this response. Check the Code tab.</div>'\n}`,
    'src/assets/main.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
    // NEW: confirmed real failure -- without this, a deploy tool like
    // Vercel or git has no way to know to skip node_modules, causing a
    // multi-GIGABYTE upload attempt instead of a normal few-MB one, since
    // it has nothing telling it those files aren't meant to be tracked.
    '.gitignore': `node_modules\ndist\n.env\n.env.local\n*.log\n`
  }
}


export function injectBackendBoilerplate(extractedFiles: Record<string, string>): Record<string, string> {
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
    }, null, 2),
    // NEW: real encryption-at-rest for lowdb, available whenever a
    // generation's data is sensitive (accounts, PII, anything a real
    // business wouldn't want sitting in a plain-text file). Injected as
    // deterministic, pre-written boilerplate -- not something Dwight is
    // asked to write correctly from scratch every time. AES-256-GCM has
    // real, easy-to-get-wrong failure modes (IV reuse, mishandled auth
    // tags) that are exactly the class of subtle mistake an LLM can
    // introduce under prompt pressure, the same failure pattern already
    // seen elsewhere this session -- security-critical infrastructure
    // code belongs here, reviewed once, not regenerated per request.
    // Uses only Node's built-in 'crypto' module -- no new dependency,
    // stays within Dwight's existing allowlist.
    // Deliberately NOT forced onto every generation via Gate 1: whether
    // a given app's data actually warrants encryption is a judgment
    // call Gate 1 isn't well-positioned to make (a public read-only
    // catalog with zero PII genuinely doesn't need it) -- see Dwight's
    // prompt for when he's instructed to reach for this. That means
    // this is currently a real capability, not yet a hard guarantee the
    // way the plaintext-password check is -- worth knowing honestly.
    'src/encryptedAdapter.ts': `import * as fs from 'fs'
import * as crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'

// Real key from a real environment variable is what a genuine
// deployment should use. The local-file fallback below exists so a
// fresh generation can boot and actually work in this sandbox without
// requiring manual setup first -- it is explicitly a dev-only default,
// not something to rely on once this leaves the sandbox.
function getEncryptionKey(): Buffer {
  const envKey = process.env.DB_ENCRYPTION_KEY
  if (envKey) {
    return crypto.createHash('sha256').update(envKey).digest()
  }
  const keyPath = '.db-key'
  if (fs.existsSync(keyPath)) {
    return Buffer.from(fs.readFileSync(keyPath, 'utf-8'), 'hex')
  }
  const generatedKey = crypto.randomBytes(32)
  fs.writeFileSync(keyPath, generatedKey.toString('hex'), { mode: 0o600 })
  console.warn('[Security] No DB_ENCRYPTION_KEY set -- generated a local dev key at .db-key. Set a real DB_ENCRYPTION_KEY environment variable before deploying this anywhere real; .db-key must never be committed or shared.')
  return generatedKey
}

// A lowdb Adapter implementation -- drop-in replacement for lowdb/node's
// JSONFile adapter. A fresh random IV is generated on every single
// write (never reused), and the auth tag from AES-GCM is stored and
// verified on read, so any tampering with the encrypted file on disk is
// detected rather than silently accepted.
// FIXED: confirmed real, significant bug -- read()/write() were
// previously declared async (returning Promise<T | null> / Promise<void>),
// even though every operation inside them was already genuinely
// synchronous (fs.readFileSync/writeFileSync, never the async fs.promises
// versions) -- the async keyword did nothing the code actually needed.
// The real problem: LowSync (which this is meant to be used with, and
// is exactly what got generated here) requires its adapter's read()/write()
// to return the raw value directly, not a Promise. LowSync.read() calling
// this adapter's read() got back a Promise object -- which IS an object,
// just one with no .services (or any schema field) on it -- so db.data
// ended up silently holding a Promise instead of real data, with every
// route reading from it seeing an object that looks populated but has
// none of the actual fields. Removing async (there was never any real
// asynchronous work happening here to begin with) makes the declared
// type finally match what the implementation already, correctly, did.
export class EncryptedJSONFile<T> {
  #filename: string
  #key: Buffer

  constructor(filename: string) {
    this.#filename = filename
    this.#key = getEncryptionKey()
  }

  read(): T | null {
    if (!fs.existsSync(this.#filename)) return null
    const raw = fs.readFileSync(this.#filename, 'utf-8')
    if (!raw.trim()) return null
    const { iv, authTag, data } = JSON.parse(raw)
    const decipher = crypto.createDecipheriv(ALGORITHM, this.#key, Buffer.from(iv, 'hex'))
    decipher.setAuthTag(Buffer.from(authTag, 'hex'))
    const decrypted = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()])
    return JSON.parse(decrypted.toString('utf-8'))
  }

  write(data: T): void {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGORITHM, this.#key, iv)
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8')
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()
    fs.writeFileSync(this.#filename, JSON.stringify({
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      data: encrypted.toString('hex')
    }))
  }
}
`,
    // NEW: same real gap, same real fix as the frontend scaffold -- a
    // deploy host or git push has no way to know to skip node_modules
    // (or the real db.json data file) without this. .db-key added
    // alongside db.json for the same reason -- the dev-fallback
    // encryption key must never end up committed either.
    '.gitignore': `node_modules\ndist\n.env\ndb.json\n.db-key\n*.log\n`
  }
}


// NEW: Riley (document generation) gets its own scaffold, separate from
// frontend/backend -- there's no page to render and no server to run, just
// a script that produces a file once and exits.
export function injectDocumentBoilerplate(extractedFiles: Record<string, string>): Record<string, string> {
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
      // All four are pure JS/TS, no native compilation -- same
      // WebContainer-safety reasoning as bcryptjs over bcrypt for Dwight.
      dependencies: {
        "pdfkit": "^0.15.0",
        "pptxgenjs": "^3.12.0",
        "docx": "^9.0.2",
        "exceljs": "^4.4.0"
      },
      devDependencies: {
        "typescript": "^5.4.5",
        "tsx": "^4.7.0",
        "@types/pdfkit": "^0.13.4"
      }
    }, null, 2)
  }
}


export function injectBoilerplate(extractedFiles: Record<string, string>, agentKey?: 'jim' | 'dwight' | 'riley'): Record<string, string> {
  if (Object.keys(extractedFiles).length === 0) return extractedFiles
  if (agentKey === 'dwight') return injectBackendBoilerplate(extractedFiles)
  if (agentKey === 'riley') return injectDocumentBoilerplate(extractedFiles)
  return injectFrontendBoilerplate(extractedFiles)
}


// NEW: Riley's script is always named src/generate.ts by convention --
// if he forgets to declare that path on the first line (unlike Jim and
// Dwight, who have that instruction spelled out and reliably follow it),
// the normal extractor finds nothing at all, and the whole document
// pipeline silently produces no stageable file. Since we already know
// deterministically what the file must be called, just grab the first
// code fence directly instead of depending on him naming it correctly.
export function extractRileyFallback(rawOutput: string): Record<string, string> {
  const anyFenceRegex = /```(?:\w+)?\s*\n?([\s\S]*?)```/
  const match = rawOutput.match(anyFenceRegex)
  if (!match) return {}
  return { 'src/generate.ts': match[1].trim() }
}


export function auditAndStage(rawOutput: string, agentKey?: 'jim' | 'dwight' | 'riley') {
  let extractedFiles = extractCodeBlocks(rawOutput)
  if (agentKey === 'riley' && !extractedFiles['src/generate.ts']) {
    extractedFiles = extractRileyFallback(rawOutput)
  }

  // FIXED: confirmed real, currently-occurring failure -- a specialist's
  // response can look completely fine as raw text (real, well-written
  // code) while still yielding ZERO extracted files, if its markdown
  // structure doesn't match what extractCodeBlocks expects: a missing
  // code fence around one file, or multiple files jammed into a single
  // fence (extraction only recognizes one "// File:" comment per fence
  // -- the first line inside it -- so a fence containing four files'
  // worth of content still yields at most one entry). Previously,
  // Object.keys(extractedFiles).length > 0 being false just meant
  // stageableFiles came out undefined further down -- but staticAudit
  // itself, from runMechanicalAudit({}), had nothing to flag on an
  // empty set and trivially passed. Since Pam reviews rawOutput
  // directly (not the extraction result), she'd approve genuinely good
  // code with no idea it never actually turned into files -- the whole
  // pipeline reported success with real code behind it, while nothing
  // was ever staged. This is the same root failure class as the
  // earlier same-line-comment extraction bug, just a different
  // trigger: zero extracted files from a non-empty response is a real
  // failure, not a vacuous pass, and is now surfaced as a blocker so it
  // feeds the existing retry loop (MAX_AUTO_FIX_ROUNDS) instead of
  // silently succeeding on nothing.
  if (Object.keys(extractedFiles).length === 0 && rawOutput.trim().length > 0) {
    return {
      extractedFiles,
      staticAudit: {
        passed: false,
        blockers: ['No files could be extracted from this response. Every file must be in its own separate markdown code block, with a "// File: path" comment as the very first line inside that block -- do not combine multiple files into one code block.'],
        warnings: [],
        perFile: []
      } as AuditResult,
      stageableFiles: undefined
    }
  }

  const staticAudit = runMechanicalAudit(extractedFiles)
  const stageableFiles =
    staticAudit.passed && Object.keys(extractedFiles).length > 0
      ? injectBoilerplate(extractedFiles, agentKey)
      : undefined
  return { extractedFiles, staticAudit, stageableFiles }
}


// FIXED: confirmed real, currently-occurring bug -- direct agent chat
// and self-healing both returned stageableFiles completely unprefixed,
// unlike the main Michael-routed pipeline (ai:invoke), which explicitly
// prefixes Dwight's output with 'server/' and Riley's with 'docs/'
// before merging. Every downstream consumer that decides "is a backend
// present" checks for that exact prefix -- SandboxPreview.tsx's
// hasBackendThisRun, and sandbox:startNative's own hasBackend split.
// Without it, Dwight's backend files (reached via clicking his
// character directly, or via a self-heal on his own code) were
// indistinguishable from frontend files: they landed at the scratch
// directory's root, got npm-installed and run through the FRONTEND'S
// OWN spawn path -- which has no fixed-port collision handling at all,
// since a frontend's dev-server port is dynamic (Vite auto-increments
// on conflict) and was never expected to need any. Confirmed via a
// real crash: Dwight's own dependency count (111 packages), his own
// dev script ('tsx watch src/server.ts'), and his own encrypted-adapter
// startup log all appeared under the '[frontend]' log tag, with zero
// genuine frontend content anywhere in the same run. One shared helper
// here, used everywhere a specialist's raw stageableFiles need to
// become the same prefixed shape the rest of the pipeline expects --
// so this can't drift out of sync across the three places that need it
// the way it just did.
export function prefixStageableFiles(files: Record<string, string> | undefined, agentKey: 'jim' | 'dwight' | 'riley'): Record<string, string> | undefined {
  if (!files) return files
  const prefix = agentKey === 'dwight' ? 'server/' : agentKey === 'riley' ? 'docs/' : ''
  if (!prefix) return files
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [`${prefix}${path}`, content]))
}