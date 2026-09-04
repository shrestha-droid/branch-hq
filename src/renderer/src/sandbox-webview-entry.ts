// NEW: this file is the renderer-side half of the COOP/COEP architectural
// fix. Previously, getWebContainer()/buildFileSystemTree() were called
// directly from SandboxPreview.tsx, inside Branch HQ's own main window --
// which is exactly why that window's top-level page needed COEP/COOP
// forced onto it, colliding with native mode's need for the opposite.
// This page now owns that boot logic instead, running entirely inside
// its own <webview>, in its own session partition (sandboxSession in
// index.ts) -- so isolation headers apply here, unconditionally, without
// ever touching the main window's session. ../lib/webcontainer.ts is
// reused exactly as it already was; this is a relocation, not a rewrite.
import { getWebContainer, buildFileSystemTree } from './lib/webcontainer'

// Mirrors SandboxPreview.tsx's own list -- same known-fatal build/runtime
// error signatures. Vite keeps its process running even after logging one
// of these, so there's no exit code to check; pattern-matching the live
// output stream is the only signal available, same as before the move.
const FATAL_ERROR_PATTERNS = [
  /Failed to resolve import/i,
  /No matching export/i,
  /SyntaxError/i,
  /Pre-transform error/i,
  /Internal server error/i,
]

// @ts-ignore -- sandboxBridge's real type lives in the preload script
// (src/preload/sandboxWebview.ts), a separate TypeScript compilation
// scope from this renderer file, the same reason every window.api call
// elsewhere in this codebase is ts-ignored rather than globally typed.
const bridge = window.sandboxBridge

// NEW: real, immediate diagnostic -- reports whether this page is
// actually cross-origin-isolated (the hard prerequisite WebContainer
// needs, since it depends on SharedArrayBuffer) the moment the page
// loads, before any generation is even attempted. This is the fastest,
// most reliable way to confirm or rule out an isolation-header problem
// as the cause of a real hang -- checking this directly in Electron's
// own webview devtools is possible but fiddly and version-dependent;
// this puts the answer straight into the Container Output log instead,
// where it's already being watched.
bridge.reportLog(`[Diagnostic] crossOriginIsolated: ${typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undefined'}`)
bridge.reportLog(`[Diagnostic] SharedArrayBuffer available: ${typeof SharedArrayBuffer !== 'undefined'}`)

// NEW: confirmed real need, not speculative -- without this, a genuine
// WebContainer.boot() hang and normal (if slow) progress are
// completely indistinguishable to anyone watching the log, forever.
// 45 seconds is generous for a cold boot but still a real, finite
// bound -- if it fires, that's a clear, actionable signal (and feeds
// self-healing, via the normal reportError path) instead of silence.
const WEBCONTAINER_BOOT_TIMEOUT_MS = 45000

async function getWebContainerWithTimeout(): Promise<Awaited<ReturnType<typeof getWebContainer>>> {
  return Promise.race([
    getWebContainer(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`WebContainer did not finish booting within ${WEBCONTAINER_BOOT_TIMEOUT_MS / 1000}s -- this usually means the sandbox page isn't genuinely cross-origin-isolated (see the [Diagnostic] lines logged at page load) rather than it just being slow.`)), WEBCONTAINER_BOOT_TIMEOUT_MS)
    )
  ])
}

// Remembers what was actually installed last time -- same reasoning as
// the original component ref it replaces: the generated app changes
// almost every run, the scaffolder's dependency list almost never does.
let lastInstalledPackageJson: string | null = null

// NEW: reentrancy guard. The host deliberately keeps this page's
// <webview> alive and reuses it across every run (self-heal reruns
// included) instead of destroying and recreating it each time -- that's
// what lets the actual WebContainer boot, the expensive part, survive
// across self-heals the same way the original module-level singleton in
// lib/webcontainer.ts already did before this move. That means a new
// 'run' message can arrive while a previous run's async chain
// (mount/install/spawn) is still in flight. Each run captures the
// current token and checks it after every meaningful await -- if it's
// changed, a newer run has already superseded this one, and this run's
// remaining callbacks quietly stop instead of reporting stale status.
// Mirrors the currentRunId pattern SandboxPreview.tsx already used on
// the host side before this move, applied here for the same reason.
let currentRunToken = 0
let unsubscribeServerReady: (() => void) | null = null

function showPreview(url: string) {
  let iframe = document.getElementById('preview-frame') as HTMLIFrameElement | null
  if (!iframe) {
    iframe = document.createElement('iframe')
    iframe.id = 'preview-frame'
    iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;'
    document.body.appendChild(iframe)
  }
  iframe.src = url
}

// NEW: confirmed real gap this move would otherwise silently reintroduce
// -- the runtime-error-detection script injected into every scaffolded
// index.html (see injectFrontendBoilerplate in index.ts) does
// `window.parent.postMessage(...)`. Before this refactor, that iframe's
// parent WAS the host window directly, so SandboxPreview.tsx's own
// message listener caught it. Now the preview iframe's parent is THIS
// page, one level further from the host -- without this listener, every
// in-iframe runtime error (a bad import, a React exception) would once
// again become invisible to self-healing, exactly the gap that feature
// was originally built to close. Unconditional, not gated by
// currentRunToken -- it always reflects whatever the currently-visible
// preview iframe is doing, which is by definition the current run.
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'branch-hq-runtime-error') return
  bridge.reportError(`A runtime error occurred in the browser after the page loaded:\n${event.data.message}`)
})

async function installDependencies(
  wc: Awaited<ReturnType<typeof getWebContainer>>,
  files: Record<string, string>,
  runToken: number
): Promise<boolean> {
  const currentPackageJson = files['package.json'] || ''
  if (lastInstalledPackageJson === currentPackageJson) {
    bridge.reportLog('System: Dependencies unchanged since last run -- skipping npm install.')
    return true
  }

  bridge.reportLog('System: Running npm install (dependencies changed since last run)...')
  const installProcess = await wc.spawn('npm', ['install'])
  const installLogTail: string[] = []
  installProcess.output.pipeTo(new WritableStream({
    write(data) {
      if (runToken !== currentRunToken) return
      const line = data.trim()
      bridge.reportLog(line)
      installLogTail.push(line)
    }
  }))

  const installExitCode = await installProcess.exit
  if (runToken !== currentRunToken) return false

  if (installExitCode !== 0) {
    bridge.reportError(`npm install failed:\n${installLogTail.slice(-60).join('\n')}`)
    return false
  }
  lastInstalledPackageJson = currentPackageJson
  return true
}

async function bootWebApp(files: Record<string, string>, runToken: number) {
  try {
    bridge.reportLog('System: Booting WebAssembly Container...')
    const wc = await getWebContainerWithTimeout()
    if (runToken !== currentRunToken) return

    bridge.reportLog('System: Mounting virtual filesystem...')
    const tree = buildFileSystemTree(files)
    await wc.mount(tree)
    if (runToken !== currentRunToken) return

    const installedOk = await installDependencies(wc, files, runToken)
    if (!installedOk || runToken !== currentRunToken) return

    bridge.reportLog('System: Starting dev server...')
    const devProcess = await wc.spawn('npm', ['run', 'dev'])
    if (runToken !== currentRunToken) return

    const runLogTail: string[] = []
    let reportedReady = false
    devProcess.output.pipeTo(new WritableStream({
      write(data) {
        if (runToken !== currentRunToken) return
        const line = data.trim()
        bridge.reportLog(line)
        runLogTail.push(line)
        if (!reportedReady && FATAL_ERROR_PATTERNS.some(pattern => pattern.test(line))) {
          bridge.reportError(`The app failed to build/run with this error:\n${runLogTail.slice(-60).join('\n')}`)
        }
      }
    }))

    // NEW: unsubscribe any previous run's server-ready listener before
    // registering this one -- wc.on() accumulates listeners across
    // calls otherwise, since the WebContainer instance itself persists
    // across runs (see currentRunToken note above).
    unsubscribeServerReady?.()
    unsubscribeServerReady = wc.on('server-ready', (_port, url) => {
      if (runToken !== currentRunToken) return
      reportedReady = true
      showPreview(url)
      bridge.reportReady(url)
    })
  } catch (err: any) {
    if (runToken !== currentRunToken) return
    bridge.reportError(err.message || 'Execution failed')
  }
}

async function runDocumentScript(files: Record<string, string>, runToken: number) {
  try {
    bridge.reportLog('System: Booting WebAssembly Container...')
    const wc = await getWebContainerWithTimeout()
    if (runToken !== currentRunToken) return

    bridge.reportLog('System: Mounting virtual filesystem...')
    const tree = buildFileSystemTree(files)
    await wc.mount(tree)
    if (runToken !== currentRunToken) return

    const installedOk = await installDependencies(wc, files, runToken)
    if (!installedOk || runToken !== currentRunToken) return

    bridge.reportLog('System: Running the document script...')
    const runProcess = await wc.spawn('npm', ['run', 'dev'])
    if (runToken !== currentRunToken) return

    const runLogTail: string[] = []
    runProcess.output.pipeTo(new WritableStream({
      write(data) {
        if (runToken !== currentRunToken) return
        const line = data.trim()
        bridge.reportLog(line)
        runLogTail.push(line)
      }
    }))

    const runExitCode = await runProcess.exit
    if (runToken !== currentRunToken) return

    if (runExitCode !== 0) {
      bridge.reportError(`The document script exited with an error:\n${runLogTail.slice(-60).join('\n')}`)
      return
    }

    bridge.reportLog('System: Script finished. Looking for the output file...')
    const candidateNames = ['output.pdf', 'output.pptx', 'output.docx', 'output.xlsx', 'output.csv', 'output.md']
    for (const name of candidateNames) {
      try {
        const data = await wc.fs.readFile(name)
        if (runToken !== currentRunToken) return
        bridge.reportLog(`System: Found ${name} (${(data.byteLength / 1024).toFixed(1)} KB)`)
        bridge.reportDocumentReady(name, data)
        return
      } catch {
        // Not this one -- try the next candidate name.
      }
    }

    if (runToken !== currentRunToken) return
    bridge.reportError('The script finished successfully but produced no output.pdf or output.pptx file. The script must be missing the actual save/write step.')
  } catch (err: any) {
    if (runToken !== currentRunToken) return
    bridge.reportError(err.message || 'Execution failed')
  }
}

bridge.onRun(({ files, mode }) => {
  currentRunToken++
  const runToken = currentRunToken
  if (mode === 'document') {
    runDocumentScript(files, runToken)
  } else {
    bootWebApp(files, runToken)
  }
})