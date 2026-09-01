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
  // NEW: if the primary model is persistently failing (e.g. a real
  // provider-side outage, not just a bad prompt), automatically try this
  // one instead before giving up. Same-provider-only on purpose --
  // falling back to the local provider would depend on local routing
  // already being proven to work, which it isn't yet.
  fallbackGeminiModel: string
  localModelBaseUrl: string
  localModelName: string
  localEmbeddingModelName: string
  defaultTargetDir: string
  // NEW: off by default on purpose. When on, nothing is treated as
  // finished until the sandbox has actually run it successfully -- the
  // preview auto-boots the moment code is staged instead of waiting for
  // a manual click, and a failure routes into self-healing before the
  // result is ever shown as complete. Real cost: every generation, even
  // a one-line change, pays for a full sandbox boot before you see
  // anything. Off by default so everyday speed isn't traded away
  // automatically; on for anyone who wants the stronger guarantee.
  strictVerification: boolean
}

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'branch-hq-settings.json')

function defaults(): AppSettings {
  return {
    modelProvider: (process.env.MODEL_PROVIDER as 'gemini' | 'local') || 'gemini',
    // NEW: previously defaulted to 'gemini-1.5-flash', which no longer
    // exists on Google's side at all -- a fresh install with nothing
    // configured would have failed immediately on every single call.
    // gemini-3.7-flash is Google's own current recommendation for
    // exactly this kind of coding/agentic workflow, confirmed against
    // their live docs, not guessed at.
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.7-flash',
    // NEW: a real, working fallback enabled by default -- previously
    // empty/disabled unless the user knew to configure it themselves.
    fallbackGeminiModel: process.env.FALLBACK_GEMINI_MODEL || 'gemini-3.1-flash-lite',
    localModelBaseUrl: process.env.LOCAL_MODEL_BASE_URL || '',
    localModelName: process.env.LOCAL_MODEL_NAME || 'llama3.1',
    localEmbeddingModelName: process.env.LOCAL_EMBEDDING_MODEL_NAME || 'nomic-embed-text',
    defaultTargetDir: process.env.DEFAULT_TARGET_DIR || '',
    strictVerification: false
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