import { parse as babelParse } from '@babel/parser'

// This file exists specifically to make Gate 1 testable. It used to live
// entirely inside index.ts, which boots the Electron app the moment it's
// imported (app.whenReady() and friends run at module load time) -- a
// test file importing anything from index.ts would have launched the
// whole app as a side effect. This file has zero Electron dependencies
// and zero top-level side effects, so it can be imported directly by
// vitest. index.ts now imports FROM here instead of defining this inline.

export interface FileAuditResult {
  file: string
  passed: boolean
  blockers: string[]
  warnings: string[]
}

export interface AuditResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
  perFile: FileAuditResult[]
}

export function stripComments(code: string): string {
  let out = ''
  let i = 0
  let inString: '"' | "'" | '`' | null = null

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === inString) inString = null
      i++
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      out += ch
      i++
      continue
    }

    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }

    out += ch
    i++
  }

  return out
}

export function auditSingleFile(filename: string, rawCode: string): FileAuditResult {
  const blockers: string[] = []
  const warnings: string[] = []
  const code = stripComments(rawCode)

  // Only run Babel AST parsing on JavaScript/TypeScript files -- CSS/HTML
  // content isn't valid JS and would false-positive as a parse error.
  const isJsOrTs = /\.(ts|tsx|js|jsx)$/i.test(filename)

  if (isJsOrTs) {
    try {
      babelParse(rawCode, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx']
      })
    } catch (err: any) {
      blockers.push(`PARSE ERROR: ${err.message || 'Code failed to parse.'} Rejected prior to security scan.`)
      return { file: filename, passed: false, blockers, warnings }
    }
  }

  const secretDeclRegex = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"`])(?:(?!\2).)+\2/g
  const secretKeywords = /pass(word)?|pwd|secret|token|api[-_]?key|credential|auth(?!or)/i
  let secretMatch: RegExpExecArray | null
  while ((secretMatch = secretDeclRegex.exec(code)) !== null) {
    const [fullMatch, varName] = secretMatch
    if (secretKeywords.test(varName) && !fullMatch.includes('process.env')) {
      blockers.push(`SECURITY BLOCK: Hardcoded credential-like value assigned to "${varName}" without process.env.`)
    }
  }

  if (/res\.cookie\s*\(/.test(code)) {
    const hasHttpOnlyKey = /httpOnly\s*:/i.test(code)
    const hasSecureKey = /secure\s*:/i.test(code)
    const hasHttpOnlyTrue = /httpOnly\s*:\s*true/i.test(code)
    const hasSecureTrue = /secure\s*:\s*true/i.test(code)

    if (!hasHttpOnlyKey || !hasSecureKey) {
      blockers.push('SECURITY BLOCK: res.cookie() call is missing httpOnly and/or secure flags entirely.')
    } else if (!hasHttpOnlyTrue || !hasSecureTrue) {
      warnings.push('HEURISTIC WARNING: Cookie flags present but not statically resolvable to `true`. Forwarded to Pam (Gate 2).')
    }
  }

  const passwordFromBody =
    /password\s*=\s*(req\.body|body)\.password/i.test(code) ||
    /const\s*\{[^}]*\bpassword\b[^}]*\}\s*=\s*(req\.body|body)\b/i.test(code)
  if (passwordFromBody && !/(bcrypt|argon2|hash)/i.test(code)) {
    blockers.push('SECURITY BLOCK: Plaintext password handling detected without hashing.')
  }

  return { file: filename, passed: blockers.length === 0, blockers, warnings }
}

export function runMechanicalAudit(extractedFiles: Record<string, string>): AuditResult {
  const perFile: FileAuditResult[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  for (const [filename, code] of Object.entries(extractedFiles)) {
    const result = auditSingleFile(filename, code)
    perFile.push(result)
    for (const b of result.blockers) blockers.push(`[${filename}] ${b}`)
    for (const w of result.warnings) warnings.push(`[${filename}] ${w}`)
  }

  return { passed: blockers.length === 0, blockers, warnings, perFile }
}