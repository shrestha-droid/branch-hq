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

export async function recordAudit(entry: Omit<AuditRecord, 'id' | 'timestamp'>): Promise<AuditRecord> {
  const records = await load()
  const record: AuditRecord = { ...entry, id: randomUUID(), timestamp: Date.now() }
  records.push(record)
  await persist()
  return record
}

export async function getAuditRecords(conversationId: string): Promise<AuditRecord[]> {
  const records = await load()
  return records.filter(r => r.conversationId === conversationId).sort((a, b) => a.timestamp - b.timestamp)
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

  const report = lines.join('\n')
  const integrityHash = createHash('sha256').update(report).digest('hex')

  return { report, integrityHash, generatedAt }
}