import * as dotenv from 'dotenv'
import * as path from 'path'
import { indexFile, generateEmbedding } from './indexer'
import { searchRelevantCode } from './vectorStore'

dotenv.config()

async function runMemoryTest() {
  console.log('🧠 Starting Phase 3 Memory Test...')
  
  // 1. Point the indexer at our main Electron file
  const targetFile = path.join(process.cwd(), 'src/main/index.ts')
  console.log(`\n📚 Reading, chunking, and embedding: ${targetFile}`)
  
  try {
    await indexFile(targetFile, process.cwd())
    console.log('✅ File successfully vectorized and saved to SQLite!')
  } catch (err) {
    console.error('❌ Indexing failed:', err)
    return
  }

  // 2. Ask a natural language question about the codebase
  const query = "Where is the mechanical audit linter function located and how does it handle passwords?"
  console.log(`\n🔍 Searching database for: "${query}"`)
  
  try {
    // Embed the query and search the DB
    const queryVector = await generateEmbedding(query)
    const results = searchRelevantCode(queryVector, 2) // Get top 2 most relevant chunks
    
    console.log(`\n🎯 Found ${results.length} relevant chunks:`)
    results.forEach((res, index) => {
      console.log(`\n--- Result ${index + 1} (Relevance Score: ${res.score.toFixed(3)}) ---`)
      console.log(`File: ${res.filePath}`)
      console.log(`Snippet:\n${res.content.substring(0, 350)}...\n`)
    })
  } catch (err) {
    console.error('❌ Query failed:', err)
  }
}

runMemoryTest()