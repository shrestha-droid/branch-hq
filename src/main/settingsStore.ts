import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

// Everything here used to only be settable by editing .env or code
// directly -- fine for one person, a hard wall for anyone else. This is
// a small JSON-backed store (same pattern as conversationStore.ts) that
// the renderer can read and write live, no restart needed. Values here
// take priority over environment variables; env vars remain the
// fallback default for a fresh install with nothing configured yet.

export interface AppSettings {
  modelProvider: 'gemini' | 'local'
  geminiModel: string
  localModelBaseUrl: string
  localModelName: string
  localEmbeddingModelName: string
  defaultTargetDir: string
}

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'branch-hq-settings.json')

function defaults(): AppSettings {
  return {
    modelProvider: (process.env.MODEL_PROVIDER as 'gemini' | 'local') || 'gemini',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    localModelBaseUrl: process.env.LOCAL_MODEL_BASE_URL || '',
    localModelName: process.env.LOCAL_MODEL_NAME || 'llama3.1',
    localEmbeddingModelName: process.env.LOCAL_EMBEDDING_MODEL_NAME || 'nomic-embed-text',
    defaultTargetDir: process.env.DEFAULT_TARGET_DIR || ''
  }
}

let cache: AppSettings | null = null

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(SETTINGS_PATH(), 'utf-8')
    // Merge onto defaults so a settings file saved before a new field
    // existed doesn't come back missing that field.
    cache = { ...defaults(), ...JSON.parse(raw) }
  } catch {
    cache = defaults()
  }
  return cache!
}

export async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings()
  cache = { ...current, ...partial }
  await fs.writeFile(SETTINGS_PATH(), JSON.stringify(cache, null, 2), 'utf-8')
  return cache
}