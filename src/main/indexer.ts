import * as fs from 'fs/promises'
import * as path from 'path'
import { saveCodeChunk } from './vectorStore'
import * as crypto from 'crypto'
import { parse as babelParse } from '@babel/parser'

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out'])
const ALLOWED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css'])

// 1. Recursive File Scanner
export async function getProjectFiles(dir: string): Promise<string[]> {
  let results: string[] = []
  const list = await fs.readdir(dir, { withFileTypes: true })

  for (const file of list) {
    if (IGNORE_DIRS.has(file.name)) continue

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

// 2. Generate Vectors via Gemini Embedding API
export async function generateEmbedding(text: string): Promise<number[]> {
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
        // FIXED: Check strictly for 'number' to satisfy TS and avoid passing null to slice()
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

  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i]
    const vector = await generateEmbedding(chunkText)
    const id = crypto.createHash('sha256').update(`${relativePath}-${i}`).digest('hex')

    saveCodeChunk(id, relativePath, i, chunkText, vector)
  }
}

// 5. Index Entire Project Workspace
export async function indexWorkspace(projectRoot: string): Promise<number> {
  const files = await getProjectFiles(projectRoot)
  let count = 0

  for (const file of files) {
    await indexFile(file, projectRoot)
    count++
  }

  return count
}