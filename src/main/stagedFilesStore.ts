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
  // FIXED: confirmed real regression -- this store originally only
  // carried `files`, so selectConversation (which reads from here) could
  // only ever pass files + conversationId to onCodeGenerated, never the
  // agentKey/instructions/auditId self-heal actually needs. handleSend's
  // own onCodeGenerated call (right when a generation finishes) DOES
  // carry all of that correctly -- but if anything re-triggers
  // selectConversation afterward (even just clicking the same
  // already-active conversation in the sidebar again), it would
  // overwrite that correct, complete context with this incomplete one,
  // silently breaking self-heal for a run that had genuinely just
  // succeeded. Persisting the same context here that handleSend already
  // has closes that gap -- selectConversation and a fresh generation now
  // both hand onCodeGenerated the same complete shape.
  agentKey?: 'jim' | 'dwight' | 'riley'
  instructions?: string
  auditId?: string | null
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

export async function getStagedFiles(conversationId: string): Promise<{ files: Record<string, string>; agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string; auditId?: string | null } | null> {
  const all = await load()
  const record = all[conversationId]
  if (!record) return null
  return { files: record.files, agentKey: record.agentKey, instructions: record.instructions, auditId: record.auditId }
}

export async function setStagedFiles(conversationId: string, files: Record<string, string>, context?: { agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string; auditId?: string | null }): Promise<void> {
  const all = await load()
  all[conversationId] = { conversationId, files, agentKey: context?.agentKey, instructions: context?.instructions, auditId: context?.auditId, updatedAt: Date.now() }
  await persist()
}