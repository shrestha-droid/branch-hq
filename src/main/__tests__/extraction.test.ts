import { describe, it, expect } from 'vitest'
import {
  normalizeFilePath, extractCodeBlocks, prefixStageableFiles, auditAndStage
} from '../extraction'

describe('normalizeFilePath', () => {
  it('adds a src/ prefix to a bare .tsx file', () => {
    expect(normalizeFilePath('App.tsx')).toBe('src/App.tsx')
  })

  it('adds a src/ prefix to a bare .ts file', () => {
    expect(normalizeFilePath('server.ts')).toBe('src/server.ts')
  })

  it('does not double-prefix a path that already starts with src/', () => {
    expect(normalizeFilePath('src/App.tsx')).toBe('src/App.tsx')
  })

  it('specifically exempts vite.config.ts from the src/ prefix rule', () => {
    expect(normalizeFilePath('vite.config.ts')).toBe('vite.config.ts')
  })

  it('leaves non-ts/tsx files untouched', () => {
    expect(normalizeFilePath('package.json')).toBe('package.json')
    expect(normalizeFilePath('.gitignore')).toBe('.gitignore')
  })
})

describe('extractCodeBlocks', () => {
  it('extracts a single well-formed file from its own fence', () => {
    const md = '```tsx\n// File: src/App.tsx\nexport default function App() { return null }\n```'
    const files = extractCodeBlocks(md)
    expect(Object.keys(files)).toEqual(['src/App.tsx'])
    expect(files['src/App.tsx']).toContain('export default function App')
  })

  it('extracts multiple files when each is in its own separate fence', () => {
    const md = [
      '```json\n// File: package.json\n{ "name": "x" }\n```',
      '```ts\n// File: src/server.ts\napp.listen(8787)\n```'
    ].join('\n\n')
    const files = extractCodeBlocks(md)
    expect(Object.keys(files).sort()).toEqual(['package.json', 'src/server.ts'])
  })

  it('confirmed real fix: still extracts correctly when another comment trails on the same line as the File: path', () => {
    const md = '```tsx\n// File: src/App.tsx /* DESIGN PLAN: colors, etc */\nexport default function App() {}\n```'
    const files = extractCodeBlocks(md)
    expect(Object.keys(files)).toEqual(['src/App.tsx'])
    // The trailing comment content is preserved (not silently dropped),
    // just no longer required to be alone on the first line.
    expect(files['src/App.tsx']).toContain('DESIGN PLAN')
  })

  it('KNOWN, CONFIRMED LIMITATION -- documented, not silently assumed fixed: multiple files crammed into ONE code block only yields the first one, with the rest appended as garbage to it', () => {
    // This is the exact real failure that broke Dwight's backend
    // generation twice tonight (Task Studio, then Scrum). The actual
    // fix that closed it was a prompt change (Dwight's prompt now
    // explicitly forbids this), not a code-level fix here -- so this
    // test exists to make that limitation visible and intentional, not
    // to claim extractCodeBlocks itself now handles it. If this test
    // ever starts failing because someone DID fix it at the code level,
    // that's a genuine improvement -- update this test to match, don't
    // just re-force the old behavior.
    const md = '```ts\n// File: src/db.ts\nexport const db = 1\n// File: src/schemas.ts\nexport const schema = 2\n```'
    const files = extractCodeBlocks(md)
    expect(Object.keys(files)).toEqual(['src/db.ts'])
    expect(files['src/db.ts']).toContain('schemas.ts')
  })

  it('returns an empty object when there is no fenced code at all', () => {
    const files = extractCodeBlocks('Just some plain prose with no code blocks in it.')
    expect(Object.keys(files)).toHaveLength(0)
  })
})

describe('prefixStageableFiles', () => {
  const sample = { 'package.json': '{}', 'src/server.ts': 'code' }

  it('prefixes Dwight\'s files with server/ -- the exact behavior missing from direct-chat and self-heal that caused a real EADDRINUSE crash tonight', () => {
    const result = prefixStageableFiles(sample, 'dwight')
    expect(Object.keys(result!).sort()).toEqual(['server/package.json', 'server/src/server.ts'])
  })

  it('prefixes Riley\'s files with docs/', () => {
    const result = prefixStageableFiles(sample, 'riley')
    expect(Object.keys(result!).sort()).toEqual(['docs/package.json', 'docs/src/server.ts'])
  })

  it('does not prefix Jim\'s files at all', () => {
    const result = prefixStageableFiles(sample, 'jim')
    expect(Object.keys(result!).sort()).toEqual(['package.json', 'src/server.ts'])
  })

  it('passes undefined straight through without throwing', () => {
    expect(prefixStageableFiles(undefined, 'dwight')).toBeUndefined()
  })
})

describe('auditAndStage', () => {
  it('CRITICAL REGRESSION TEST: zero files extracted from a non-empty response is a real Gate 1 failure, not a vacuous pass', () => {
    // This is the exact confirmed root cause of tonight's original bug:
    // Dwight's response looked fine as raw text (Pam would have
    // approved it), but its markdown structure didn't match what
    // extraction expects, yielding zero files. Before the fix, Gate 1
    // had nothing to flag on an empty set and passed trivially --
    // meaning the whole pipeline reported success while staging
    // nothing. This must never regress silently.
    const rawOutput = 'Sure, here is your backend: I will describe it but forget to use code fences.'
    const { staticAudit, stageableFiles } = auditAndStage(rawOutput, 'dwight')
    expect(staticAudit.passed).toBe(false)
    expect(staticAudit.blockers.some(b => b.includes('No files could be extracted'))).toBe(true)
    expect(stageableFiles).toBeUndefined()
  })

  it('a real security violation in otherwise well-formed output is still caught and blocks staging', () => {
    const rawOutput = '```ts\n// File: src/config.ts\nconst apiKey = "sk-realsecretvalue123";\n```'
    const { staticAudit, stageableFiles } = auditAndStage(rawOutput, 'dwight')
    expect(staticAudit.passed).toBe(false)
    expect(stageableFiles).toBeUndefined()
  })

  it('clean, well-formed output passes and gets real boilerplate injected, including the encrypted adapter for Dwight', () => {
    const rawOutput = '```ts\n// File: src/util.ts\nexport const x = 1\n```'
    const { staticAudit, stageableFiles } = auditAndStage(rawOutput, 'dwight')
    expect(staticAudit.passed).toBe(true)
    expect(stageableFiles).toBeDefined()
    expect(stageableFiles!['package.json']).toBeDefined()
    // Regression test for the encryption-at-rest feature actually being
    // wired into every backend generation, not just described in a
    // prompt.
    expect(stageableFiles!['src/encryptedAdapter.ts']).toContain('aes-256-gcm')
  })

  it('a completely empty raw response (nothing generated at all) does not falsely report the same "no files could be extracted" blocker -- there is a real difference between "wrote something that failed to fence correctly" and "wrote nothing"', () => {
    const { stageableFiles } = auditAndStage('', 'dwight')
    expect(stageableFiles).toBeUndefined()
  })
})