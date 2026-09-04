import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

// NEW: per-conversation model overrides -- a second, narrower layer on
// top of the global per-agent overrides in settingsStore.ts (michaelModel,
// jimModel, dwightModel, pamModel, rileyModel). Those apply everywhere;
// this lets ONE specific chat use a different model for one or more
// agents without touching the global default that every other chat
// still uses. Same storage pattern as clientFactsStore.ts -- a
// conversation-keyed JSON file in userData -- since this is the same
// shape of problem: something that belongs to one project, not
// everywhere at once.

export interface ConversationModelOverrides {
  michael?: string
  jim?: string
  dwight?: string
  pam?: string
  riley?: string
}

interface ModelOverridesRecord {
  conversationId: string
  overrides: ConversationModelOverrides
  updatedAt: number
}

const MODEL_OVERRIDES_PATH = () => path.join(app.getPath('userData'), 'branch-hq-model-overrides.json')

let cache: Record<string, ModelOverridesRecord> | null = null

async function load(): Promise<Record<string, ModelOverridesRecord>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(MODEL_OVERRIDES_PATH(), 'utf-8')
    cache = JSON.parse(raw)
  } catch {
    cache = {}
  }
  return cache!
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.writeFile(MODEL_OVERRIDES_PATH(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function getConversationModelOverrides(conversationId: string): Promise<ConversationModelOverrides> {
  const all = await load()
  return all[conversationId]?.overrides || {}
}

export async function setConversationModelOverrides(conversationId: string, overrides: ConversationModelOverrides): Promise<ModelOverridesRecord> {
  const all = await load()
  // Empty-string values are treated as "clear this agent's override,"
  // not "set it to an empty string" -- keeps the stored record clean
  // and matches how the settings UI's empty-means-inherit convention
  // already works for the global per-agent fields.
  const cleaned: ConversationModelOverrides = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (value && value.trim()) cleaned[key as keyof ConversationModelOverrides] = value.trim()
  }
  const record: ModelOverridesRecord = { conversationId, overrides: cleaned, updatedAt: Date.now() }
  all[conversationId] = record
  await persist()
  return record
}