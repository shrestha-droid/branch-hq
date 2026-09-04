import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

// NEW: the actual fix for a confirmed real bug -- reopening or
// reselecting a conversation (clicking it in the sidebar, or the app
// reloading) previously had no durable record of "the real, finished,
// merged file set" to load. It guessed instead, by scanning messages
// in reverse for the last one with a `files` field -- which is
// whichever individual AGENT'S message happened to have files, not
// necessarily the true final result. Confirmed real failure mode: if a
// multi-agent build's second agent (Jim) was still mid-retry when the
// conversation got reselected, the first agent's (Dwight's) own
// already-saved message would be found instead, loading a genuinely
// incomplete, in-progress snapshot as if it were the finished result --
// with no way to tell the difference from the UI.
//
// This store holds the one true answer: the actual `mergedFiles` from
// the most recent SUCCESSFUL, COMPLETE run of ai:invoke for a given
// conversation, written once, only when the whole pipeline genuinely
// finishes -- never from an individual agent's own in-progress message.
// Same conversation-keyed JSON-in-userData pattern as
// clientFactsStore.ts and modelOverridesStore.ts, for the same reason:
// this is project-scoped, not global.

interface StagedFilesRecord {
  conversationId: string
  files: Record<string, string>
  updatedAt: number
}

const STAGED_FILES_PATH = () => path.join(app.getPath('userData'), 'branch-hq-staged-files.json')

let cache: Record<string, StagedFilesRecord> | null = null

async function load(): Promise<Record<string, StagedFilesRecord>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(STAGED_FILES_PATH(), 'utf-8')
    cache = JSON.parse(raw)
  } catch {
    cache = {}
  }
  return cache!
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.writeFile(STAGED_FILES_PATH(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function getStagedFiles(conversationId: string): Promise<Record<string, string> | null> {
  const all = await load()
  return all[conversationId]?.files || null
}

export async function setStagedFiles(conversationId: string, files: Record<string, string>): Promise<void> {
  const all = await load()
  all[conversationId] = { conversationId, files, updatedAt: Date.now() }
  await persist()
}