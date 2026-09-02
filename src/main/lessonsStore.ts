import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'

// NEW: self-healing "learns from its mistakes." Deliberately local-only,
// by explicit decision -- everything here lives in one file on this
// machine, in userData, and is never sent anywhere. A shared-across-
// users version was considered and explicitly rejected: it would mean
// collecting data from customer machines, which directly conflicts with
// "your code never leaves your building" -- the actual thing that makes
// Branch HQ different for every regulated prospect on the outreach
// list. If a shared-learning version is ever genuinely wanted, that
// needs its own real decision and a real privacy policy, not a default.
//
// A "lesson" is recorded only when self-healing actually SUCCEEDS --
// proving the fix was real, not just recording every failed guess. Each
// lesson is the real error text a specialist has already been shown
// once and already fixed once; future generations for that same agent
// get the accumulated list injected as "known past mistakes," so the
// same class of hallucination or bug doesn't have to be rediscovered
// from scratch every single time.

export interface Lesson {
  id: string
  agentKey: string
  timestamp: number
  errorSummary: string
}

const LESSONS_PATH = () => path.join(app.getPath('userData'), 'branch-hq-lessons.json')

// Capped per agent -- this gets injected into every future prompt for
// that agent, so it needs to stay small and relevant rather than grow
// into an ever-larger wall of text. Most recent wins; older lessons
// naturally age out once the cap is hit.
const MAX_LESSONS_PER_AGENT = 8
const MAX_ERROR_SUMMARY_CHARS = 400

let cache: Lesson[] | null = null

async function load(): Promise<Lesson[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(LESSONS_PATH(), 'utf-8')
    cache = JSON.parse(raw)
  } catch {
    cache = []
  }
  return cache!
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.mkdir(path.dirname(LESSONS_PATH()), { recursive: true })
  await fs.writeFile(LESSONS_PATH(), JSON.stringify(cache, null, 2), 'utf-8')
}

// Called after a self-heal attempt actually succeeds -- see heal:invoke
// in index.ts. Deduplicates near-identical errors so the same mistake
// doesn't fill up the whole list with copies of itself, and trims to
// the cap per agent, dropping the oldest first.
export async function recordLesson(agentKey: string, rawErrorText: string): Promise<void> {
  const lessons = await load()
  const errorSummary = rawErrorText.slice(0, MAX_ERROR_SUMMARY_CHARS)

  const alreadyKnown = lessons.some(l => l.agentKey === agentKey && l.errorSummary === errorSummary)
  if (alreadyKnown) return

  lessons.push({ id: randomUUID(), agentKey, timestamp: Date.now(), errorSummary })

  const forThisAgent = lessons.filter(l => l.agentKey === agentKey).sort((a, b) => a.timestamp - b.timestamp)
  if (forThisAgent.length > MAX_LESSONS_PER_AGENT) {
    const toDrop = forThisAgent.slice(0, forThisAgent.length - MAX_LESSONS_PER_AGENT)
    const dropIds = new Set(toDrop.map(l => l.id))
    cache = lessons.filter(l => !dropIds.has(l.id))
  }

  await persist()
}

// Called before every generation for a given agent -- returns a
// ready-to-inject prompt fragment, or an empty string if nothing has
// been learned for that agent yet (the common case early on).
export async function getLearnedGuidance(agentKey: string): Promise<string> {
  const lessons = await load()
  const forThisAgent = lessons
    .filter(l => l.agentKey === agentKey)
    .sort((a, b) => b.timestamp - a.timestamp)

  if (forThisAgent.length === 0) return ''

  const list = forThisAgent.map(l => `- ${l.errorSummary}`).join('\n')
  return `\n\n[Known past mistakes for this project, each one previously caused a real failure that was fixed -- avoid repeating any of these]:\n${list}`
}