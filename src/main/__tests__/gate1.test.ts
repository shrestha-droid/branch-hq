import { describe, it, expect } from 'vitest'
import { auditSingleFile, runMechanicalAudit, stripComments } from '../gate1'

// Every case here is grounded in either a documented Gate 1 rule or a
// real bug actually found and fixed in this project -- not invented
// examples. This is the regression suite that's been named as the
// single highest-priority missing piece, repeatedly, throughout this
// project's whole history.

describe('Gate 1 -- hardcoded secrets', () => {
  it('blocks a hardcoded password not sourced from process.env', () => {
    const code = `const password = "sup3rSecret123";`
    const result = auditSingleFile('src/config.ts', code)
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.includes('Hardcoded credential'))).toBe(true)
  })

  it('blocks a hardcoded API key', () => {
    const code = `const apiKey = "AIzaSyD-hardcoded-value-here";`
    const result = auditSingleFile('src/client.ts', code)
    expect(result.passed).toBe(false)
  })

  it('allows a secret correctly sourced from process.env', () => {
    const code = `const password = process.env.DB_PASSWORD;`
    const result = auditSingleFile('src/config.ts', code)
    expect(result.passed).toBe(true)
    expect(result.blockers).toHaveLength(0)
  })

  it('does not false-positive on an unrelated variable name', () => {
    const code = `const username = "admin_display_name";`
    const result = auditSingleFile('src/config.ts', code)
    expect(result.passed).toBe(true)
  })
})

describe('Gate 1 -- insecure cookies', () => {
  it('blocks a cookie call missing httpOnly/secure entirely', () => {
    const code = `res.cookie('session', token);`
    const result = auditSingleFile('src/routes/auth.ts', code)
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.includes('httpOnly'))).toBe(true)
  })

  it('warns (does not block) when flags are present but not statically true', () => {
    const code = `res.cookie('session', token, { httpOnly: isProd, secure: isProd });`
    const result = auditSingleFile('src/routes/auth.ts', code)
    expect(result.passed).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('passes a correctly secured cookie', () => {
    const code = `res.cookie('session', token, { httpOnly: true, secure: true });`
    const result = auditSingleFile('src/routes/auth.ts', code)
    expect(result.passed).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })
})

describe('Gate 1 -- plaintext passwords', () => {
  it('blocks a plaintext password pulled directly off req.body', () => {
    const code = `const password = req.body.password; db.save({ password });`
    const result = auditSingleFile('src/routes/register.ts', code)
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.includes('Plaintext password'))).toBe(true)
  })

  it('blocks the destructured form too -- this exact pattern was missed by an earlier version of Gate 1', () => {
    const code = `const { password } = req.body; db.save({ password });`
    const result = auditSingleFile('src/routes/register.ts', code)
    expect(result.passed).toBe(false)
  })

  it('allows a password that is actually hashed before storage', () => {
    const code = `const { password } = req.body; const hash = await bcrypt.hash(password, 10);`
    const result = auditSingleFile('src/routes/register.ts', code)
    expect(result.passed).toBe(true)
  })
})

describe('Gate 1 -- parse validity', () => {
  it('blocks genuinely invalid syntax -- the real bug: a trailing comma after render()', () => {
    // This exact mistake shipped once in a real generation and was
    // caught by Gate 1 automatically, triggering a retry.
    const code = `ReactDOM.createRoot(document.getElementById('root')!).render(<App />),`
    const result = auditSingleFile('src/main.tsx', code)
    expect(result.passed).toBe(false)
    expect(result.blockers.some(b => b.includes('PARSE ERROR'))).toBe(true)
  })

  it('passes valid TypeScript/JSX', () => {
    const code = `export default function App() { return <div>Hello</div> }`
    const result = auditSingleFile('src/App.tsx', code)
    expect(result.passed).toBe(true)
  })

  it('never parses CSS as JS -- would false-positive as a parse error otherwise', () => {
    const code = `.crt-scanlines { background: linear-gradient(rgba(0,0,0,0.2) 50%, transparent 50%); }`
    const result = auditSingleFile('src/assets/main.css', code)
    expect(result.passed).toBe(true)
  })

  it('never parses HTML as JS either', () => {
    const code = `<!DOCTYPE html><html><body><div id="root"></div></body></html>`
    const result = auditSingleFile('index.html', code)
    expect(result.passed).toBe(true)
  })
})

describe('Gate 1 -- comment stripping does not create false negatives', () => {
  it('still catches a hardcoded secret sitting next to a comment', () => {
    const code = `// TODO: move this to env eventually\nconst secret = "not-actually-moved-yet";`
    const result = auditSingleFile('src/config.ts', code)
    expect(result.passed).toBe(false)
  })

  it('does not strip content out of a string that merely contains // or /*', () => {
    const stripped = stripComments(`const url = "https://example.com";`)
    expect(stripped).toContain('https://example.com')
  })
})

describe('runMechanicalAudit -- multi-file aggregation', () => {
  it('passes only when every file passes', () => {
    const result = runMechanicalAudit({
      'src/App.tsx': `export default function App() { return null }`,
      'src/config.ts': `const apiKey = "hardcoded-bad-value";`
    })
    expect(result.passed).toBe(false)
    expect(result.perFile).toHaveLength(2)
    expect(result.perFile.find(f => f.file === 'src/App.tsx')?.passed).toBe(true)
    expect(result.perFile.find(f => f.file === 'src/config.ts')?.passed).toBe(false)
  })

  it('prefixes every blocker with the file it came from', () => {
    const result = runMechanicalAudit({
      'src/routes/auth.ts': `res.cookie('x', y);`
    })
    expect(result.blockers[0]).toContain('[src/routes/auth.ts]')
  })

  it('passes cleanly on a real, multi-file, secure example', () => {
    const result = runMechanicalAudit({
      'src/App.tsx': `export default function App() { return <div>OK</div> }`,
      'src/server.ts': `const key = process.env.API_KEY; res.cookie('s', t, { httpOnly: true, secure: true });`
    })
    expect(result.passed).toBe(true)
    expect(result.blockers).toHaveLength(0)
  })
})