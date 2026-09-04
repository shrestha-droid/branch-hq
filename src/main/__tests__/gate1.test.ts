import { describe, it, expect } from 'vitest'
import { stripComments, auditSingleFile, runMechanicalAudit } from '../gate1'

describe('stripComments', () => {
  it('strips a line comment', () => {
    const out = stripComments('const x = 1; // a comment\nconst y = 2;')
    expect(out).not.toContain('a comment')
    expect(out).toContain('const y = 2;')
  })

  it('strips a block comment', () => {
    const out = stripComments('const x = 1; /* block\ncomment */ const y = 2;')
    expect(out).not.toContain('block')
    expect(out).toContain('const y = 2;')
  })

  it('does NOT strip "//" that appears inside a real string literal -- a URL, specifically', () => {
    // Confirmed real risk: naive comment-stripping that doesn't track
    // string state would corrupt a perfectly normal line like this one,
    // treating "//example.com" as the start of a comment and deleting
    // real code after it.
    const out = stripComments(`const url = "http://example.com/path";`)
    expect(out).toContain('http://example.com/path')
  })

  it('does not get confused by an escaped quote inside a string', () => {
    const out = stripComments(`const s = "she said \\"hi\\" // not a comment";`)
    expect(out).toContain('not a comment')
  })
})

describe('auditSingleFile', () => {
  it('blocks code that fails to parse, before any security scan runs', () => {
    const result = auditSingleFile('src/broken.ts', 'const x = {{{ this is not valid typescript')
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.startsWith('PARSE ERROR'))).toBe(true)
  })

  it('does not attempt to parse a non-JS/TS file as code', () => {
    // A CSS file full of content that would never parse as JS/TS should
    // not trigger a false PARSE ERROR -- confirmed real design: only
    // .ts/.tsx/.js/.jsx are run through the Babel parser at all.
    const result = auditSingleFile('src/styles.css', '.foo { color: {{{ not real css either')
    expect(result.blockers.some(b => b.startsWith('PARSE ERROR'))).toBe(false)
  })

  it('blocks a hardcoded credential-like value', () => {
    const result = auditSingleFile('src/config.ts', `const apiKey = "sk-abc123realkeylooking";`)
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.includes('Hardcoded credential-like value'))).toBe(true)
  })

  it('does NOT block a value correctly sourced from process.env', () => {
    const result = auditSingleFile('src/config.ts', `const apiKey = process.env.GEMINI_API_KEY;`)
    expect(result.passed).toBe(true)
  })

  it('blocks res.cookie() missing httpOnly/secure entirely', () => {
    const result = auditSingleFile('src/auth.ts', `res.cookie('session', token);`)
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.includes('missing httpOnly and/or secure'))).toBe(true)
  })

  it('passes res.cookie() with httpOnly/secure both statically true', () => {
    const result = auditSingleFile('src/auth.ts', `res.cookie('session', token, { httpOnly: true, secure: true });`)
    expect(result.passed).toBe(true)
    expect(result.blockers).toHaveLength(0)
  })

  it('warns (does not block) when cookie flags are present but not statically resolvable', () => {
    const result = auditSingleFile('src/auth.ts', `res.cookie('session', token, { httpOnly: isProd, secure: isProd });`)
    expect(result.passed).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('blocks a plaintext password taken from the request body with no hashing anywhere in the file', () => {
    const result = auditSingleFile('src/auth.ts', `
      const password = req.body.password;
      db.data.users.push({ password });
    `)
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.includes('Plaintext password handling'))).toBe(true)
  })

  it('does not block a password from the request body when the file also hashes it', () => {
    const result = auditSingleFile('src/auth.ts', `
      const { password } = req.body;
      const hash = await bcrypt.hash(password, 10);
    `)
    expect(result.passed).toBe(true)
  })

  it('genuinely clean code passes with no blockers and no warnings', () => {
    const result = auditSingleFile('src/util.ts', `export function add(a: number, b: number) { return a + b }`)
    expect(result.passed).toBe(true)
    expect(result.blockers).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })
})

describe('runMechanicalAudit', () => {
  it('an empty file set passes trivially -- documented explicitly, since this exact behavior is why auditAndStage (extraction.ts) has to separately guard against zero-extraction being mistaken for a real pass', () => {
    const result = runMechanicalAudit({})
    expect(result.passed).toBe(true)
    expect(result.blockers).toHaveLength(0)
    expect(result.perFile).toHaveLength(0)
  })

  it('aggregates blockers across multiple files, each prefixed with its own filename', () => {
    const result = runMechanicalAudit({
      'src/good.ts': `export const x = 1`,
      'src/bad.ts': `const apiKey = "sk-realsecretvalue123";`
    })
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.startsWith('[src/bad.ts]'))).toBe(true)
    expect(result.blockers.some(b => b.startsWith('[src/good.ts]'))).toBe(false)
  })

  it('multiple genuinely clean files all pass together', () => {
    const result = runMechanicalAudit({
      'src/a.ts': `export const a = 1`,
      'src/b.ts': `export const b = 2`
    })
    expect(result.passed).toBe(true)
    expect(result.perFile).toHaveLength(2)
  })
})