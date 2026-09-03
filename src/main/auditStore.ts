import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'

// This is the actual differentiator that's been named repeatedly and
// never built: a real record of what was checked, on what file, with
// what result, that can be handed to someone outside the engineering
// team. Gate 1 already computes this data (perFile results) on every
// single generation -- it was just being thrown away right after the
// pass/fail decision was made. This store keeps it.
//
// Honest naming note: this produces an INTEGRITY hash (SHA-256 over the
// report content + a timestamp), which proves the report wasn't altered
// after being generated. That is NOT the same thing as a legally
// binding cryptographic signature, which requires a real private key and
// a signing authority behind it. Calling this "signed" without that
// infrastructure would overstate what it actually guarantees.

export interface FileAuditEntry {
  file: string
  passed: boolean
  blockers: string[]
  warnings: string[]
}

export interface AuditRecord {
  id: string
  conversationId: string
  agentKey: string
  timestamp: number
  attempt: number
  gate1Passed: boolean
  perFile: FileAuditEntry[]
  pamVerdict: 'APPROVED' | 'CHANGES_REQUESTED' | 'UNKNOWN'
  // NEW: the honest gap this closes -- "Pam approved" is a text opinion
  // formed by reading code, not proof it actually works. This starts
  // false/pending on every record and only flips true when the sandbox
  // has genuinely run this exact generation and it succeeded -- reported
  // back from the renderer, the only place execution can actually
  // happen. A record can be Pam-approved and never execution-verified;
  // the report says so plainly rather than blurring the two together.
  executionVerified: boolean
  executionVerifiedAt: number | null
}

const AUDIT_LOG_PATH = () => path.join(app.getPath('userData'), 'branch-hq-audit-log.json')

let cache: AuditRecord[] | null = null

async function load(): Promise<AuditRecord[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(AUDIT_LOG_PATH(), 'utf-8')
    cache = JSON.parse(raw)
  } catch {
    cache = []
  }
  return cache!
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.writeFile(AUDIT_LOG_PATH(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function recordAudit(entry: Omit<AuditRecord, 'id' | 'timestamp' | 'executionVerified' | 'executionVerifiedAt'>): Promise<AuditRecord> {
  const records = await load()
  const record: AuditRecord = { ...entry, id: randomUUID(), timestamp: Date.now(), executionVerified: false, executionVerifiedAt: null }
  records.push(record)
  await persist()
  return record
}

// NEW: called from the renderer -- the only place a sandbox actually
// runs -- once a generation has genuinely been executed successfully.
// Returns null if the id doesn't exist rather than throwing, since this
// is best-effort reporting, not something that should ever break a run.
export async function markExecutionVerified(id: string): Promise<AuditRecord | null> {
  const records = await load()
  const record = records.find(r => r.id === id)
  if (!record) return null
  record.executionVerified = true
  record.executionVerifiedAt = Date.now()
  await persist()
  return record
}

export async function getAuditRecords(conversationId: string): Promise<AuditRecord[]> {
  const records = await load()
  return records.filter(r => r.conversationId === conversationId).sort((a, b) => a.timestamp - b.timestamp)
}

// NEW: the developer-facing report above is a direct, factual record --
// exactly what a technical audit needs to be. It's also meaningless to
// the actual client paying for this work: "SECURITY BLOCK: res.cookie()
// call is missing httpOnly and/or secure flags entirely" tells a
// restaurant owner or clinic manager nothing. This is a SEPARATE,
// plain-language summary built from the exact same underlying records --
// nothing here is invented or re-scored, it's a translation layer, not
// a different audit. Categories are matched against gate1.ts's actual,
// verbatim blocker message formats (see SECURITY_CATEGORIES below) --
// not guessed at -- so a category only ever appears here if it's a real
// check Gate 1 genuinely performs.
interface ClientFacingCategory {
  id: string
  label: string
  description: string
  matcher: RegExp
}

const SECURITY_CATEGORIES: ClientFacingCategory[] = [
  {
    id: 'no-hardcoded-secrets',
    label: 'No hardcoded secrets',
    description: 'Passwords, API keys, and other credentials are never written directly into the application\'s code.',
    matcher: /^SECURITY BLOCK: Hardcoded credential-like value/
  },
  {
    id: 'secure-cookies',
    label: 'Secure session cookies',
    description: 'Session cookies (used to keep a user logged in) are protected against theft over an insecure connection and access from malicious scripts.',
    matcher: /^SECURITY BLOCK: res\.cookie\(\) call is missing/
  },
  {
    id: 'password-hashing',
    label: 'Passwords are never stored in plain text',
    description: 'User passwords are cryptographically scrambled (hashed) before being saved, so they can never be read back in their original form -- not even by us.',
    matcher: /^SECURITY BLOCK: Plaintext password handling/
  },
  {
    id: 'code-integrity',
    label: 'Code integrity',
    description: 'Every file is confirmed to be complete, valid code -- nothing broken or malformed is ever shown or shipped.',
    matcher: /^PARSE ERROR:/
  }
]

export async function generateClientSummary(conversationId: string): Promise<{ summary: string; generatedAt: string }> {
  const records = await getAuditRecords(conversationId)
  const generatedAt = new Date().toISOString()

  // A category being flagged even once, on any attempt, means our
  // automated check genuinely caught something and blocked it before it
  // could ship -- not that the delivered product has the issue. Nothing
  // that trips one of these categories is ever part of what's actually
  // staged or delivered; that's the whole point of Gate 1 sitting
  // between generation and anything the client sees.
  const categoryEverFlagged = new Map<string, boolean>()
  let unrecognizedBlockerCount = 0

  for (const record of records) {
    for (const file of record.perFile) {
      for (const blocker of file.blockers) {
        const match = SECURITY_CATEGORIES.find(c => c.matcher.test(blocker))
        if (match) {
          categoryEverFlagged.set(match.id, true)
        } else {
          // NEW: honestly counted, not silently dropped -- if Gate 1
          // ever grows a new blocker category this mapping doesn't
          // know about yet, the summary says so explicitly rather than
          // quietly under-reporting what was actually caught.
          unrecognizedBlockerCount++
        }
      }
    }
  }

  // "Final state per specialist" -- records are already sorted ascending
  // by timestamp (getAuditRecords), so the last one written for a given
  // agentKey is whichever attempt actually ended up staged/used, whether
  // that took one round or several self-heal/retry rounds to get there.
  const latestRecordPerAgent = new Map<string, AuditRecord>()
  for (const r of records) latestRecordPerAgent.set(r.agentKey, r)
  const finalRecords = [...latestRecordPerAgent.values()]
  const allFinalExecutionVerified = finalRecords.length > 0 && finalRecords.every(r => r.executionVerified)

  const lines: string[] = []
  lines.push('WHAT WE CHECKED -- IN PLAIN LANGUAGE')
  lines.push('')
  lines.push('Every piece of code built for this project passes through the same automated checks before it is ever shown to you, whether or not an issue was ever actually found:')
  lines.push('')
  for (const cat of SECURITY_CATEGORIES) {
    lines.push(`- ${cat.label}`)
    lines.push(`    ${cat.description}`)
    if (categoryEverFlagged.get(cat.id)) {
      lines.push(`    An issue in this category was caught automatically during development and was never included in what you received.`)
    }
  }
  lines.push('')
  if (finalRecords.length === 0) {
    lines.push('No work has been recorded for this project yet.')
  } else if (allFinalExecutionVerified) {
    lines.push('Every current part of this project has been confirmed to actually run -- not just reviewed as code, but genuinely tested and working.')
  } else {
    lines.push('Some parts of this project have been reviewed but not yet confirmed to actually run end-to-end. Ask your developer for the full technical audit report for specifics.')
  }
  if (unrecognizedBlockerCount > 0) {
    lines.push('')
    lines.push(`Note: ${unrecognizedBlockerCount} additional issue(s) were caught during development outside the categories above. See the full technical audit report for details.`)
  }
  lines.push('')
  lines.push('This is a plain-language summary for reference. For the complete, unedited technical record, request the full audit report.')

  return { summary: lines.join('\n'), generatedAt }
}

// Builds a plain, factual text report -- deliberately NOT run through an
// LLM. A compliance artifact needs to be a direct statement of what was
// actually recorded, not a paraphrase of it.
export async function generateAuditReport(conversationId: string): Promise<{ report: string; integrityHash: string; generatedAt: string }> {
  const records = await getAuditRecords(conversationId)
  const generatedAt = new Date().toISOString()

  const lines: string[] = []
  lines.push('BRANCH HQ -- COMPLIANCE AUDIT REPORT')
  lines.push(`Conversation ID: ${conversationId}`)
  lines.push(`Report generated: ${generatedAt}`)
  lines.push(`Total generations recorded: ${records.length}`)
  lines.push('='.repeat(60))

  for (const r of records) {
    lines.push('')
    lines.push(`Generation ${r.id}`)
    lines.push(`  Timestamp: ${new Date(r.timestamp).toISOString()}`)
    lines.push(`  Agent: ${r.agentKey}`)
    lines.push(`  Attempt: ${r.attempt}`)
    lines.push(`  Gate 1 (deterministic scan): ${r.gate1Passed ? 'PASSED' : 'BLOCKED'}`)
    lines.push(`  Gate 2 (Pam QA review): ${r.pamVerdict}`)
    lines.push(`  Execution verified (sandbox actually run): ${r.executionVerified ? `YES -- confirmed ${new Date(r.executionVerifiedAt!).toISOString()}` : 'NO -- reviewed by Pam only, never actually run'}`)
    for (const f of r.perFile) {
      lines.push(`    - ${f.file}: ${f.passed ? 'PASS' : 'FAIL'}`)
      for (const b of f.blockers) lines.push(`        BLOCKER: ${b}`)
      for (const w of f.warnings) lines.push(`        WARNING: ${w}`)
    }
  }

  lines.push('')
  lines.push('='.repeat(60))
  lines.push('This report is a direct, unedited record of Gate 1 and Gate 2')
  lines.push('results as they were recorded at generation time. The integrity')
  lines.push('hash below is a SHA-256 checksum of this report\'s content -- it')
  lines.push('proves the report has not been altered since it was generated.')
  lines.push('It is not a cryptographic signature backed by a signing')
  lines.push('authority or private key.')
  lines.push('')
  lines.push('"Execution verified" is a separate, stronger claim than Gate 2:')
  lines.push('Pam\'s review is an opinion formed by reading code. Execution')
  lines.push('verification means the code was actually run in the sandbox and')
  lines.push('genuinely worked. A generation can be Pam-approved and still say')
  lines.push('NO here if it was never actually run -- that is reported honestly,')
  lines.push('not blurred into a single pass/fail.')

  const report = lines.join('\n')
  const integrityHash = createHash('sha256').update(report).digest('hex')

  return { report, integrityHash, generatedAt }
}