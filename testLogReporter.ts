import * as fs from 'fs'
import * as path from 'path'

// NEW: "a file with logs of testing inside the software." Appends one
// line per test run to a durable log living in the project itself.
//
// FIXED: the first version targeted onFinished(files) with a raw
// task-tree shape, which was Vitest's OLDER reporter API. Vitest 4 (what
// this project actually runs) calls onTestRunEnd(testModules, errors)
// instead, and hands back results through the newer Reported Tasks API
// (testModule.children.allTests(), each with a result() METHOD, not a
// plain property) -- not the old raw .tasks tree. The old code never
// threw an error; it just silently never ran. Both hooks are wired up
// here so this keeps working even if the version changes again later.

const LOG_DIR = path.join(process.cwd(), 'test-results')
const LOG_FILE = path.join(LOG_DIR, 'test-log.jsonl')

function writeLogEntry(passed: number, failedNames: string[], total: number) {
  const entry = {
    timestamp: new Date().toISOString(),
    total,
    passed,
    failed: failedNames.length,
    failedTests: failedNames
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8')
  } catch (err) {
    // A logging failure should never fail the actual test run.
    console.error('Could not write to test-results/test-log.jsonl:', err)
  }
}

export default class TestLogReporter {
  private loggedThisRun = false

  // Current Vitest 4 hook -- confirmed against the live docs, uses the
  // Reported Tasks API rather than the older raw task tree.
  onTestRunEnd(testModules: readonly any[] = []) {
    const failedNames: string[] = []
    let passed = 0
    let total = 0

    for (const testModule of testModules) {
      const tests = testModule?.children?.allTests ? testModule.children.allTests() : []
      for (const test of tests) {
        total++
        const state = typeof test.result === 'function' ? test.result()?.state : test.result?.state
        if (state === 'passed' || state === 'pass') {
          passed++
        } else if (state === 'failed' || state === 'fail') {
          failedNames.push(test.name ?? test.fullName ?? 'unnamed test')
        }
      }
    }

    if (total > 0) {
      writeLogEntry(passed, failedNames, total)
      this.loggedThisRun = true
    }
  }

  // Older Vitest hook, kept as a fallback so this doesn't silently break
  // again on a future version change in the other direction. Guarded so
  // it never double-logs if a version somehow calls both.
  onFinished(files: readonly any[] = []) {
    if (this.loggedThisRun) return

    const failedNames: string[] = []
    let passed = 0
    let total = 0

    const walk = (tasks: any[]) => {
      for (const task of tasks) {
        if (task.tasks?.length) {
          walk(task.tasks)
        } else if (task.result?.state) {
          total++
          if (task.result.state === 'pass' || task.result.state === 'passed') passed++
          else if (task.result.state === 'fail' || task.result.state === 'failed') failedNames.push(task.name)
        }
      }
    }
    for (const file of files) {
      if (file.tasks) walk(file.tasks)
    }

    if (total > 0) writeLogEntry(passed, failedNames, total)
  }
}