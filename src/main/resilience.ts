// Same reasoning as gate1.ts -- pulled out of index.ts so it can be
// imported by a test file without booting the Electron app.

export function looksTransient(err: any): boolean {
  const message = err?.message || ''
  // Deliberately narrow: a real, permanent problem (missing API key, bad
  // URL) fails the same way every time and shouldn't burn retries
  // pretending otherwise -- only retry things that plausibly resolve on
  // their own a moment later.
  return /timed out|network|ECONNREFUSED|ETIMEDOUT|fetch failed|error \(50\d\)/i.test(message)
}