import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { createHash } from 'crypto'

const testDir = path.join(os.tmpdir(), 'branch-hq-audit-test-' + Date.now())

vi.mock('electron', () => ({
  app: { getPath: () => testDir }
}))

describe('auditStore', () => {
  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true })
    await fs.rm(path.join(testDir, 'branch-hq-audit-log.json'), { force: true })
    vi.resetModules()
  })

  it('records and retrieves an audit entry for the right conversation only', async () => {
    const { recordAudit, getAuditRecords } = await import('../auditStore')
    await recordAudit({
      conversationId: 'convo-a',
      agentKey: 'jim',
      attempt: 1,
      gate1Passed: true,
      perFile: [{ file: 'src/App.tsx', passed: true, blockers: [], warnings: [] }],
      pamVerdict: 'APPROVED'
    })
    await recordAudit({
      conversationId: 'convo-b',
      agentKey: 'dwight',
      attempt: 1,
      gate1Passed: true,
      perFile: [],
      pamVerdict: 'APPROVED'
    })

    const recordsForA = await getAuditRecords('convo-a')
    expect(recordsForA).toHaveLength(1)
    expect(recordsForA[0].agentKey).toBe('jim')
  })

  it('the integrity hash is a real, verifiable SHA-256 of the report content -- not just a random string', async () => {
    const { recordAudit, generateAuditReport } = await import('../auditStore')
    await recordAudit({
      conversationId: 'convo-hash-test',
      agentKey: 'riley',
      attempt: 1,
      gate1Passed: true,
      perFile: [{ file: 'src/generate.ts', passed: true, blockers: [], warnings: [] }],
      pamVerdict: 'APPROVED'
    })

    const { report, integrityHash } = await generateAuditReport('convo-hash-test')
    const recomputed = createHash('sha256').update(report).digest('hex')
    expect(integrityHash).toBe(recomputed)
  })

  it('a Gate 1 block is recorded faithfully, including the actual blocker text', async () => {
    const { recordAudit, generateAuditReport } = await import('../auditStore')
    await recordAudit({
      conversationId: 'convo-blocked',
      agentKey: 'dwight',
      attempt: 1,
      gate1Passed: false,
      perFile: [{ file: 'src/routes/auth.ts', passed: false, blockers: ['SECURITY BLOCK: Plaintext password handling detected without hashing.'], warnings: [] }],
      pamVerdict: 'UNKNOWN'
    })

    const { report } = await generateAuditReport('convo-blocked')
    expect(report).toContain('BLOCKED')
    expect(report).toContain('Plaintext password handling detected')
  })

  it('a conversation with no recorded generations produces a valid, honest empty report rather than an error', async () => {
    const { generateAuditReport } = await import('../auditStore')
    const { report } = await generateAuditReport('convo-that-never-happened')
    expect(report).toContain('Total generations recorded: 0')
  })
})