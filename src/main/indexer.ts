import * as fs from 'fs/promises'
import * as path from 'path'
import { saveCodeChunk, deleteChunksForFile, getAllIndexedFilePaths } from './vectorStore'
import * as crypto from 'crypto'
import { parse as babelParse } from '@babel/parser'

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out'])
const ALLOWED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css'])
// NEW: .json was allowed for things like tsconfig.json, but that also let
// package-lock.json (and friends) through -- often thousands of lines with
// near-zero semantic value for code retrieval, each chunked 50 lines at a
// time and each chunk costing a real embedding API call. Excluded by exact
// filename rather than dropping .json entirely, since tsconfig.json etc.
// are still worth indexing.
const IGNORE_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

// 1. Recursive File Scanner
export async function getProjectFiles(dir: string): Promise<string[]> {
  let results: string[] = []
  const list = await fs.readdir(dir, { withFileTypes: true })

  for (const file of list) {
    if (IGNORE_DIRS.has(file.name)) continue
    if (IGNORE_FILES.has(file.name)) continue

    const fullPath = path.join(dir, file.name)
    if (file.isDirectory()) {
      const subFiles = await getProjectFiles(fullPath)
      results = results.concat(subFiles)
    } else {
      if (ALLOWED_EXT.has(path.extname(file.name))) {
        results.push(fullPath)
      }
    }
  }
  return results
}

// 2. Generate Vectors -- Gemini by default, or a local/private embedding
// server when MODEL_PROVIDER=local. Fixing generation alone wasn't
// enough: this function is a second, separate path that was ALSO sending
// project code (as embedding text) straight to Gemini, quietly, in the
// background -- easy to miss since it's not part of the visible chat flow.
export async function generateEmbedding(text: string): Promise<number[]> {
  const providerName = process.env.MODEL_PROVIDER || 'gemini'

  if (providerName === 'local' || providerName === 'openai-compatible') {
    // Most local/private model servers (Ollama, vLLM, LM Studio) expose
    // an OpenAI-compatible /v1/embeddings endpoint -- same base URL used
    // for chat generation in index.ts, just a different path on it.
    const baseUrl = process.env.LOCAL_MODEL_BASE_URL
    const model = process.env.LOCAL_EMBEDDING_MODEL_NAME || 'nomic-embed-text'
    if (!baseUrl) throw new Error('Missing LOCAL_MODEL_BASE_URL in environment.')

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text })
    })

    if (!response.ok) {
      throw new Error(`Local embedding API Error (${response.status}): ${await response.text()}`)
    }

    const data = await response.json()
    return data.data?.[0]?.embedding || []
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY in environment.')

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] }
      })
    }
  )

  if (!response.ok) {
    throw new Error(`Embedding failed: ${await response.text()}`)
  }

  const data = await response.json()
  return data.embedding.values
}

// 3. AST Semantic Block Extractor
function extractASTChunks(code: string, relativePath: string): string[] {
  const chunks: string[] = []
  const isScript = /\.[jt]sx?$/.test(relativePath)

  if (isScript) {
    try {
      const ast = babelParse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx']
      })

      for (const node of ast.program.body) {
        // Strict 'number' check satisfies TS and avoids passing null to slice()
        if (typeof node.start === 'number' && typeof node.end === 'number') {
          const rawBlock = code.slice(node.start, node.end).trim()
          // Only index meaningful blocks (ignoring trivial one-liners)
          if (rawBlock.length > 20) {
            chunks.push(`// File: ${relativePath}\n${rawBlock}`)
          }
        }
      }
    } catch {
      // If AST parsing fails, fallback to line-based chunking
    }
  }

  // Fallback: If non-JS or AST produced no chunks, chunk by 50 lines
  if (chunks.length === 0) {
    const lines = code.split('\n')
    const chunkSize = 50
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunkContent = lines.slice(i, i + chunkSize).join('\n').trim()
      if (chunkContent) {
        chunks.push(`// File: ${relativePath}\n${chunkContent}`)
      }
    }
  }

  return chunks
}

// 4. Index a Single File
export async function indexFile(filePath: string, projectRoot: string) {
  const content = await fs.readFile(filePath, 'utf-8')
  const relativePath = path.relative(projectRoot, filePath)
  const chunks = extractASTChunks(content, relativePath)

  // NEW: clear this file's previous chunks before writing its new ones.
  // Handles the "file shrank" case that INSERT OR REPLACE alone can't --
  // if this file previously produced 5 chunks and now produces 3, chunks
  // 3 and 4 from the old version would otherwise never get overwritten.
  deleteChunksForFile(relativePath)

  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i]
    const vector = await generateEmbedding(chunkText)
    const id = crypto.createHash('sha256').update(`${relativePath}-${i}`).digest('hex')

    saveCodeChunk(id, relativePath, i, chunkText, vector)
  }
}

// 5. Index Entire Project Workspace
export async function indexWorkspace(projectRoot: string): Promise<{ indexed: number; failed: string[]; pruned: number }> {
  const files = await getProjectFiles(projectRoot)
  const currentRelativePaths = new Set(files.map(f => path.relative(projectRoot, f)))

  // NEW: prune chunks for files that were indexed before but no longer
  // exist on disk. Per-file delete-then-insert in indexFile() only fires
  // for files that still exist and get re-indexed -- a deleted file is
  // never visited again, so its old chunks would sit in the table forever
  // without this pass.
  let pruned = 0
  for (const oldPath of getAllIndexedFilePaths()) {
    if (!currentRelativePaths.has(oldPath)) {
      deleteChunksForFile(oldPath)
      pruned++
    }
  }

  let indexed = 0
  const failed: string[] = []

  for (const file of files) {
    // NEW: isolated per-file. Previously one failed embedding call (rate
    // limit, transient network error, anything) threw out of indexFile()
    // uncaught, which rejected the whole indexWorkspace() call -- files
    // already processed stayed indexed (SQLite writes happen per chunk,
    // not in one batch), but every file after the failure was silently
    // never attempted, with no signal that the run stopped short.
    try {
      await indexFile(file, projectRoot)
      indexed++
    } catch (err: any) {
      const relativePath = path.relative(projectRoot, file)
      failed.push(relativePath)
      console.error(`[indexer] Failed to index ${relativePath}:`, err.message || err)
    }
  }

  return { indexed, failed, pruned }
}