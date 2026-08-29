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

// Retrieve the top K most relevant code chunks for a prompt
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