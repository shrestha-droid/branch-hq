import Database from 'better-sqlite3'
import * as path from 'path'

// Initialize local SQLite database
const dbPath = path.join(process.cwd(), 'branch-hq-memory.db')
const db = new Database(dbPath)

// Create the schema to hold our project memory
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filePath TEXT NOT NULL,
    chunkIndex INTEGER,
    content TEXT NOT NULL,
    embedding TEXT NOT NULL
  );
`)

// Save a chunk of code and its vector embedding
export function saveCodeChunk(id: string, filePath: string, chunkIndex: number, content: string, embedding: number[]) {
  const stmt = db.prepare('INSERT OR REPLACE INTO documents (id, filePath, chunkIndex, content, embedding) VALUES (?, ?, ?, ?, ?)')
  stmt.run(id, filePath, chunkIndex, content, JSON.stringify(embedding))
}

// NEW: deletes all chunks belonging to one file. Without this, re-indexing
// a file that shrank from 5 chunks to 3 left chunks 3 and 4 sitting in the
// table forever -- IDs are `sha256(filePath-chunkIndex)`, so a shorter file
// simply never overwrites the old higher-index rows, and they stay
// silently retrievable, describing code that no longer exists. Called by
// indexFile() before writing a file's new chunks.
export function deleteChunksForFile(filePath: string): void {
  const stmt = db.prepare('DELETE FROM documents WHERE filePath = ?')
  stmt.run(filePath)
}

// NEW: every distinct filePath currently in the index. Used by
// indexWorkspace() to detect files that were indexed before but no longer
// exist on disk (deleted since the last index run), so their chunks can be
// pruned too -- per-file delete-then-insert alone doesn't catch a file
// that's gone entirely, since indexFile() is never called for it again.
export function getAllIndexedFilePaths(): string[] {
  const stmt = db.prepare('SELECT DISTINCT filePath FROM documents')
  const rows = stmt.all() as { filePath: string }[]
  return rows.map(r => r.filePath)
}

// Wipe the entire index. Useful for a deliberate full re-index rather than
// the incremental per-file/pruned approach above.
export function clearAllChunks(): void {
  db.exec('DELETE FROM documents')
}

// Calculate Cosine Similarity between two vectors
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Retrieve the top K most relevant code chunks for a prompt.
//
// KNOWN CEILING, NOT FIXED HERE: this does a full table scan every query --
// pulls every row, parses its embedding out of JSON, and computes cosine
// similarity against all of them in JS. That's genuinely fine at prototype
// scale (hundreds to low thousands of chunks). It is not an incremental
// step toward the SQ8-quantized / pgvector-backed retrieval already in the
// Phase 3 plan -- that requires an actual ANN index (e.g. a real vector
// extension or a move to pgvector), not a tweak to this function. Flagging
// it here rather than silently leaving it since it's a real ceiling on
// however large a single indexed workspace can practically get.
export function searchRelevantCode(queryEmbedding: number[], limit: number = 3): { filePath: string, content: string, score: number }[] {
  const stmt = db.prepare('SELECT filePath, content, embedding FROM documents')
  const allDocs = stmt.all() as { filePath: string, content: string, embedding: string }[]

  const scoredDocs = allDocs.map(doc => {
    const dbVector = JSON.parse(doc.embedding) as number[]
    return {
      filePath: doc.filePath,
      content: doc.content,
      score: cosineSimilarity(queryEmbedding, dbVector)
    }
  })

  // Sort by highest similarity score and grab the top results
  return scoredDocs.sort((a, b) => b.score - a.score).slice(0, limit)
}