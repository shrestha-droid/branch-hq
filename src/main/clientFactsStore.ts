import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

// NEW: the actual fix for build-time hallucination of business-specific
// facts -- confirmed real pattern already observed this session (Dwight
// inventing plausible-but-fake seed data like "Initialize Scrum
// Repository" assigned to "Backend Specialist"). Harmless for a demo
// task board; not harmless if a specialist invents a real clinic's
// hours or a shop's actual prices because nothing grounded it in truth.
// This store holds verified real facts about ONE project's actual
// client -- entered once, injected into every generation for that
// project from then on, the same pattern existingProjectSnapshot and
// self-healing memory already use for their own kind of context.
// Deliberately scoped to per-conversation, not a standalone client/CRM
// entity -- Branch HQ already treats a conversation as the natural unit
// of "one project," and a separate client-management layer wasn't
// asked for.

export interface ClientFactsRecord {
  conversationId: string
  facts: string
  updatedAt: number
}

const CLIENT_FACTS_PATH = () => path.join(app.getPath('userData'), 'branch-hq-client-facts.json')

let cache: Record<string, ClientFactsRecord> | null = null

async function load(): Promise<Record<string, ClientFactsRecord>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(CLIENT_FACTS_PATH(), 'utf-8')
    cache = JSON.parse(raw)
  } catch {
    cache = {}
  }
  return cache!
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.writeFile(CLIENT_FACTS_PATH(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function getClientFacts(conversationId: string): Promise<string> {
  const all = await load()
  return all[conversationId]?.facts || ''
}

export async function setClientFacts(conversationId: string, facts: string): Promise<ClientFactsRecord> {
  const all = await load()
  const record: ClientFactsRecord = { conversationId, facts, updatedAt: Date.now() }
  all[conversationId] = record
  await persist()
  return record
}