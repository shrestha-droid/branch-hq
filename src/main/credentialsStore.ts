import * as fs from 'fs/promises'
import * as path from 'path'
import { app, safeStorage } from 'electron'

// NEW: real, secure storage for third-party credentials -- starting
// with a GitHub Personal Access Token. Deliberately kept separate from
// settingsStore.ts: everything there (model names, target folder) is
// genuinely not sensitive; this is. Uses Electron's safeStorage, which
// encrypts through the OS's own secure storage -- Keychain on macOS,
// DPAPI on Windows, libsecret on Linux -- not a homemade encryption
// scheme. The encrypted bytes are the only thing ever written to disk;
// the raw token is never persisted in plaintext, and is never sent back
// to the renderer once stored (only a boolean "is something set").
//
// Honest limit: safeStorage protects against another user or process
// reading the file directly. It does not protect against something
// with the same OS-level access this app itself has (e.g. another
// process running as the same logged-in user). That is the actual
// guarantee here -- worth being precise about rather than overselling
// it as absolute.

const CREDENTIALS_PATH = () => path.join(app.getPath('userData'), 'branch-hq-credentials.enc')

interface StoredCredentials {
  githubToken?: string // base64 of the encrypted bytes, never the raw token
}

async function loadRaw(): Promise<StoredCredentials> {
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function persistRaw(data: StoredCredentials): Promise<void> {
  await fs.mkdir(path.dirname(CREDENTIALS_PATH()), { recursive: true })
  await fs.writeFile(CREDENTIALS_PATH(), JSON.stringify(data), 'utf-8')
}

export async function setGithubToken(token: string): Promise<{ success: boolean; error?: string }> {
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'Secure storage is not available on this system -- the OS-level keychain this depends on could not be reached.' }
  }
  const encrypted = safeStorage.encryptString(token)
  const data = await loadRaw()
  data.githubToken = encrypted.toString('base64')
  await persistRaw(data)
  return { success: true }
}

export async function hasGithubToken(): Promise<boolean> {
  const data = await loadRaw()
  return !!data.githubToken
}

export async function clearGithubToken(): Promise<void> {
  const data = await loadRaw()
  delete data.githubToken
  await persistRaw(data)
}

// Internal only -- never exposed directly over IPC. Used by the actual
// git/GitHub API calls in index.ts, which run entirely in the main
// process; the decrypted token itself never crosses into the renderer.
export async function getGithubTokenForInternalUse(): Promise<string | null> {
  const data = await loadRaw()
  if (!data.githubToken) return null
  try {
    return safeStorage.decryptString(Buffer.from(data.githubToken, 'base64'))
  } catch {
    return null
  }
}