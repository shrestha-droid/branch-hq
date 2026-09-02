import { useEffect, useState, useRef } from 'react'
import { getWebContainer, buildFileSystemTree } from '../lib/webcontainer'
import { Loader2, TerminalSquare, Globe, FileText, Download, Wrench, ChevronDown, ChevronUp } from 'lucide-react'

interface SandboxPreviewProps {
  files: Record<string, string>
  // NEW: needed for self-healing. Without all three, self-healing simply
  // can't fire (e.g. when reopening an older result card, which doesn't
  // carry the original instructions) -- the sandbox just behaves as it
  // did before in that case, no auto-fix attempted.
  conversationId?: string
  agentKey?: 'jim' | 'dwight' | 'riley'
  instructions?: string
  onFilesHealed?: (files: Record<string, string>) => void
  // NEW: the real audit record id for this generation, and whether
  // strict verification is on. When a run genuinely succeeds, this
  // component reports back so the audit record can be upgraded from
  // "Pam approved" to "confirmed running" -- the actual point of this
  // whole feature. onVerificationOutcome fires on both real success and
  // real (post-self-heal) failure; the parent decides what's worth
  // surfacing visibly based on whether strict mode is on.
  auditId?: string | null
  onVerificationOutcome?: (success: boolean, message?: string) => void
}

const ACCENT = {
  text: 'text-[#409cff]',
  bg: 'bg-[#0a84ff]',
  bgHover: 'hover:bg-[#3395ff]',
}

interface DocumentResult {
  name: string
  data: Uint8Array
}

// Mirrors MAX_SELF_HEAL_ROUNDS in index.ts -- the main process enforces
// the real cap; this is just so the UI doesn't keep retrying past it
// client-side either.
const MAX_SELF_HEAL_ROUNDS = 2

// Known-fatal build/runtime error signatures actually seen this session.
// A match here means the run is not going to recover on its own -- these
// are build-breaking, not transient warnings.
const FATAL_ERROR_PATTERNS = [
  /Failed to resolve import/i,
  /No matching export/i,
  /SyntaxError/i,
  /Pre-transform error/i,
  /Internal server error/i,
]

export default function SandboxPreview({ files, conversationId, agentKey, instructions, onFilesHealed, auditId, onVerificationOutcome }: SandboxPreviewProps) {
  const [status, setStatus] = useState<'booting' | 'installing' | 'starting' | 'ready' | 'error' | 'healing'>('booting')
  // NEW: the log panel used to permanently occupy a large, fixed chunk
  // of vertical space, squeezing the actual preview into a small strip
  // -- useful while something is booting or failing, much less useful
  // once it's already working. Starts open (useful during boot), then
  // auto-collapses the first time a run actually succeeds, freeing that
  // space for the thing you actually want to look at. Always
  // re-openable by hand regardless.
  const [logsCollapsed, setLogsCollapsed] = useState(false)
  const hasAutoCollapsedRef = useRef(false)
  const [logs, setLogs] = useState<string[]>([])
  const [url, setUrl] = useState<string | null>(null)
  const [documentResult, setDocumentResult] = useState<DocumentResult | null>(null)
  const [healAttempt, setHealAttempt] = useState(0)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const runIdRef = useRef<number>(0)

  const devProcessRef = useRef<any>(null)
  const installProcessRef = useRef<any>(null)
  const unsubscribeServerReadyRef = useRef<(() => void) | null>(null)
  const healingRef = useRef(false)
  const justHealedRef = useRef(false)
  const hasTriggeredHealForThisRunRef = useRef(false)
  // NEW: whether a real Node/npm runtime is available on this machine.
  // Detected once, on mount -- a real answer, not assumed. null means
  // "still checking," which briefly favors WebContainers until it
  // resolves, since that path is already proven to work everywhere.
  const [nativeAvailable, setNativeAvailable] = useState<boolean | null>(null)
  const nativeRunIdRef = useRef<string | null>(null)
  const nativeUnsubscribersRef = useRef<(() => void)[]>([])
  // Which mode actually rendered this run -- shown in the UI so this is
  // never a hidden implementation detail. Distinct from nativeAvailable:
  // that's the capability, this is what actually happened this run.
  const [activeMode, setActiveMode] = useState<'webcontainer' | 'native' | null>(null)
  // NEW: confirmed real pattern -- the frontend can report ready
  // (Vite boots in well under a second) while the backend is still
  // running its own separate npm install, which real logs tonight have
  // shown taking several real seconds. Without tracking this
  // separately, "ready" looked identical whether the backend was
  // actually up or not -- someone trying to log in the instant the app
  // appeared would hit a real, confusing "backend not detected" even
  // though it was only ever a matter of a few more seconds.
  const [backendExpected, setBackendExpected] = useState(false)
  const [backendReady, setBackendReady] = useState(false)

  useEffect(() => {
    // @ts-ignore
    window.api.detectRuntime().then((r: any) => setNativeAvailable(r.available)).catch(() => setNativeAvailable(false))
  }, [])

  // NEW: remembers what was actually installed last time. The generated
  // application code changes on almost every run, but the dependency
  // list (hardcoded by the scaffolder) almost never does -- reinstalling
  // identical packages from scratch every single time is very likely the
  // single biggest cost in how long a run takes to start.
  const lastInstalledPackageJsonRef = useRef<string | null>(null)

  // FIXED: confirmed real misrouting -- relying only on parsing
  // package.json's content meant a Riley generation could, for reasons
  // not fully pinned down, fail this check and get dispatched through
  // bootNative() instead of runDocumentScript() -- trying to npm
  // install document-generation dependencies (pdfkit, docx) as if they
  // were a Vite frontend, which is exactly what a real failure showed.
  // agentKey is a second, independent signal already available as a
  // prop -- checking both means this can't misfire on package.json
  // parsing alone.
  const isDocumentOutput = (files['package.json']?.includes('"branch-hq-preview-docs"') ?? false) || agentKey === 'riley'
  const canSelfHeal = Boolean(conversationId && agentKey && instructions)

  const addLog = (msg: string) => setLogs(prev => [...prev.slice(-99), msg])

  // NEW: the actual point of the whole execution-verification feature.
  // Called only when the sandbox has genuinely run this generation
  // successfully -- upgrades its audit record from "Pam approved" to
  // "confirmed running." Best-effort: if auditId is missing (e.g. an
  // older reopened result with no healing context) this just no-ops,
  // same as self-healing already does in that situation.
  const reportExecutionSuccess = async () => {
    onVerificationOutcome?.(true)
    if (!auditId) return
    try {
      // @ts-ignore
      await window.api.markAuditExecuted(auditId)
    } catch {
      // Best-effort reporting -- never let this affect the actual run.
    }
  }

  // Called when a generation could NOT be confirmed as running, even
  // after self-healing exhausted its attempts. Always reported up;
  // whether it's shown to the user depends on strict mode, decided by
  // the parent, not here.
  const reportExecutionFailure = (message: string) => {
    onVerificationOutcome?.(false, message)
  }

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  useEffect(() => {
    if (status === 'ready' && !hasAutoCollapsedRef.current) {
      hasAutoCollapsedRef.current = true
      setLogsCollapsed(true)
    }
    // A fresh run (new files) should show its own boot log by default --
    // reset so the next run isn't silently pre-collapsed before anyone's
    // seen it succeed once.
    if (status === 'booting') {
      hasAutoCollapsedRef.current = false
    }
  }, [status])

  const teardownPrevious = async () => {
    unsubscribeServerReadyRef.current?.()
    unsubscribeServerReadyRef.current = null

    try { await devProcessRef.current?.kill?.() } catch { /* already gone, fine */ }
    devProcessRef.current = null

    try { await installProcessRef.current?.kill?.() } catch { /* already gone, fine */ }
    installProcessRef.current = null
  }

  // Real processes need real teardown too -- otherwise switching
  // conversations or generating something new would leave old servers
  // running in the background indefinitely, quietly holding their ports.
  const teardownNative = async () => {
    for (const unsubscribe of nativeUnsubscribersRef.current) unsubscribe()
    nativeUnsubscribersRef.current = []
    if (nativeRunIdRef.current) {
      try {
        // @ts-ignore
        await window.api.stopNativeSandbox(nativeRunIdRef.current)
      } catch { /* best-effort -- nothing more useful to do if this fails */ }
      nativeRunIdRef.current = null
    }
  }

  // NEW: the actual self-heal call. Feeds the real failure text back to
  // the same specialist that wrote this code, through the main process,
  // and -- on success -- hands the corrected files up to App.tsx, which
  // flows back down as a new `files` prop and re-triggers a normal run.
  // NEW: tracks every error self-healing has seen this run, so the final
  // exhausted-attempts message can show real, complete diagnostic
  // history -- confirmed real gap: previously the actual error text was
  // silently discarded the moment healing gave up, leaving only "we
  // stopped trying" with no way to know what was actually wrong.
  const errorHistoryRef = useRef<string[]>([])

  const attemptSelfHeal = async (errorContext: string) => {
    errorHistoryRef.current.push(errorContext)

    if (!canSelfHeal) {
      addLog('System: Cannot self-heal -- missing conversation/agent context for this result.')
      addLog(`System: The actual error was:\n${errorContext}`)
      setStatus('error')
      reportExecutionFailure('This result could not be verified as running -- no healing context was available to attempt a fix.')
      return
    }
    if (healingRef.current || hasTriggeredHealForThisRunRef.current) return
    if (healAttempt >= MAX_SELF_HEAL_ROUNDS) {
      addLog(`System: Already used ${MAX_SELF_HEAL_ROUNDS} self-heal attempts -- stopping rather than guessing again.`)
      // NEW: actually show what happened at each attempt, not just that
      // attempts were used up. If the same error repeats verbatim across
      // attempts, that's real, useful information too (the fix genuinely
      // isn't landing) -- shown explicitly rather than left to guess at.
      const history = errorHistoryRef.current
      const allSame = history.length > 1 && history.every(e => e === history[0])
      addLog(`System: ${allSame ? 'The SAME error persisted across every attempt:' : 'Error history across all attempts:'}`)
      history.forEach((err, i) => addLog(`--- Attempt ${i + 1} ---\n${err}`))
      setStatus('error')
      reportExecutionFailure(`This build could not be verified as actually running, even after ${MAX_SELF_HEAL_ROUNDS} automatic repair attempts. It passed review but never ran successfully. Final error: ${history[history.length - 1]?.slice(0, 500)}`)
      return
    }

    hasTriggeredHealForThisRunRef.current = true
    healingRef.current = true
    const nextAttempt = healAttempt + 1
    setHealAttempt(nextAttempt)
    setStatus('healing')
    addLog(`System: Detected a real failure after passing review. Attempting automatic self-heal (attempt ${nextAttempt} of ${MAX_SELF_HEAL_ROUNDS})...`)

    try {
      // @ts-ignore
      const result = await window.api.healPipeline({
        conversationId,
        agentKey,
        previousInstructions: instructions,
        errorLog: errorContext,
        attempt: nextAttempt
      })

      if (result.success && result.files) {
        addLog('System: Self-healing produced a fix. Reloading with the corrected version...')
        justHealedRef.current = true
        onFilesHealed?.(result.files)
      } else {
        addLog(`System: Self-healing did not succeed: ${result.error || 'unknown error'}`)
        setStatus('error')
      }
    } catch (err: any) {
      addLog(`System: Self-healing request failed: ${err.message}`)
      setStatus('error')
    } finally {
      healingRef.current = false
    }
  }

  useEffect(() => {
    let mounted = true
    const currentRunId = ++runIdRef.current

    // Only reset the attempt counter for a genuinely new generation, not
    // for the re-run that happens right after a successful heal.
    if (justHealedRef.current) {
      justHealedRef.current = false
    } else {
      setHealAttempt(0)
    }
    hasTriggeredHealForThisRunRef.current = false
    errorHistoryRef.current = []

    // NEW: confirmed real gap -- catches errors reported by the
    // injected script in the scaffolded index.html (see
    // injectFrontendBoilerplate), the only way to know about a runtime
    // error happening inside the iframe after the page loads. Covers
    // both native and WebContainer modes, since both load an iframe
    // pointing at real content. A fresh closure over attemptSelfHeal
    // each time this effect runs (a new generation) avoids a stale
    // reference to state that changes between runs, like healAttempt.
    const handleRuntimeErrorMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'branch-hq-runtime-error') return
      if (!mounted || currentRunId !== runIdRef.current) return
      addLog(`Error [frontend runtime]: ${event.data.message}`)
      attemptSelfHeal(`A runtime error occurred in the browser after the page loaded:\n${event.data.message}`)
    }
    window.addEventListener('message', handleRuntimeErrorMessage)

    async function bootWebApp() {
      try {
        await teardownPrevious()
        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('booting')
        setUrl(null)
        addLog('System: Booting WebAssembly Container...')
        const wc = await getWebContainer()

        if (!mounted || currentRunId !== runIdRef.current) return

        addLog('System: Mounting virtual filesystem...')
        const tree = buildFileSystemTree(files)
        await wc.mount(tree)

        // NEW: only reinstall if the actual dependency list changed.
        // Mounting doesn't touch node_modules (the tree never includes
        // it), so a prior install genuinely survives across runs in the
        // same WebContainer session -- this just stops paying for a
        // reinstall of packages that are already sitting there.
        const currentPackageJson = files['package.json'] || ''
        const depsUnchanged = lastInstalledPackageJsonRef.current === currentPackageJson

        if (depsUnchanged) {
          addLog('System: Dependencies unchanged since last run -- skipping npm install.')
        } else {
          setStatus('installing')
          addLog('System: Running npm install (dependencies changed since last run)...')
          const installProcess = await wc.spawn('npm', ['install'])
          installProcessRef.current = installProcess

          const installLogTail: string[] = []
          installProcess.output.pipeTo(new WritableStream({
            write(data) {
              if (mounted) {
                const line = data.trim()
                addLog(line)
                installLogTail.push(line)
              }
            }
          }))

          const installExitCode = await installProcess.exit
          if (installExitCode !== 0) {
            if (!mounted || currentRunId !== runIdRef.current) return
            return attemptSelfHeal(`npm install failed:\n${installLogTail.slice(-60).join('\n')}`)
          }
          lastInstalledPackageJsonRef.current = currentPackageJson
        }

        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('starting')
        addLog('System: Starting dev server...')
        const devProcess = await wc.spawn('npm', ['run', 'dev'])
        devProcessRef.current = devProcess

        const runLogTail: string[] = []
        devProcess.output.pipeTo(new WritableStream({
          write(data) {
            if (!mounted) return
            const line = data.trim()
            addLog(line)
            runLogTail.push(line)

            // NEW: watch the live output for known-fatal build errors.
            // Vite keeps the process running even after logging one of
            // these, so there's no exit code to check here -- pattern
            // matching on the stream is the only signal available.
            if (currentRunId === runIdRef.current && !hasTriggeredHealForThisRunRef.current) {
              const isFatal = FATAL_ERROR_PATTERNS.some(pattern => pattern.test(line))
              if (isFatal) {
                attemptSelfHeal(`The app failed to build/run with this error:\n${runLogTail.slice(-60).join('\n')}`)
              }
            }
          }
        }))

        const unsubscribe = wc.on('server-ready', (port: number, previewUrl: string) => {
          if (mounted && currentRunId === runIdRef.current && !hasTriggeredHealForThisRunRef.current) {
            addLog(`System: Server ready on port ${port}`)
            setUrl(previewUrl)
            setStatus('ready')
            reportExecutionSuccess()
          }
        })
        unsubscribeServerReadyRef.current = unsubscribe

      } catch (err: any) {
        if (mounted) {
          setStatus('error')
          addLog(`Error: ${err.message || 'Execution failed'}`)
        }
      }
    }

    async function runDocumentScript() {
      try {
        await teardownPrevious()
        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('booting')
        setDocumentResult(null)
        addLog('System: Booting WebAssembly Container...')
        const wc = await getWebContainer()

        if (!mounted || currentRunId !== runIdRef.current) return

        addLog('System: Mounting virtual filesystem...')
        const tree = buildFileSystemTree(files)
        await wc.mount(tree)

        const currentPackageJson = files['package.json'] || ''
        const depsUnchanged = lastInstalledPackageJsonRef.current === currentPackageJson

        if (depsUnchanged) {
          addLog('System: Dependencies unchanged since last run -- skipping npm install.')
        } else {
          setStatus('installing')
          addLog('System: Running npm install (dependencies changed since last run)...')
          const installProcess = await wc.spawn('npm', ['install'])
          installProcessRef.current = installProcess

          const installLogTail: string[] = []
          installProcess.output.pipeTo(new WritableStream({
            write(data) {
              if (mounted) {
                const line = data.trim()
                addLog(line)
                installLogTail.push(line)
              }
            }
          }))

          const installExitCode = await installProcess.exit
          if (installExitCode !== 0) {
            if (!mounted || currentRunId !== runIdRef.current) return
            return attemptSelfHeal(`npm install failed:\n${installLogTail.slice(-60).join('\n')}`)
          }
          lastInstalledPackageJsonRef.current = currentPackageJson
        }

        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('starting')
        addLog('System: Running the document script...')
        const runProcess = await wc.spawn('npm', ['run', 'dev'])
        devProcessRef.current = runProcess

        const runLogTail: string[] = []
        runProcess.output.pipeTo(new WritableStream({
          write(data) {
            if (mounted) {
              const line = data.trim()
              addLog(line)
              runLogTail.push(line)
            }
          }
        }))

        // The document path's failure signal is clean: a non-zero exit
        // code, unlike the web app path which has no such signal.
        const runExitCode = await runProcess.exit
        if (!mounted || currentRunId !== runIdRef.current) return

        if (runExitCode !== 0) {
          // NEW: widened from 30 to 60 lines. A crash deep inside a
          // library's own code (like pptxgenjs) can print a long stack
          // trace -- the actual useful error message can end up further
          // back than 30 lines caught, meaning self-healing was
          // sometimes asked to fix something without ever actually
          // seeing what broke.
          return attemptSelfHeal(`The document script exited with an error:\n${runLogTail.slice(-60).join('\n')}`)
        }

        addLog('System: Script finished. Looking for the output file...')
        const candidateNames = ['output.pdf', 'output.pptx', 'output.docx', 'output.xlsx', 'output.csv', 'output.md']
        let found: DocumentResult | null = null

        for (const name of candidateNames) {
          try {
            const data = await wc.fs.readFile(name)
            found = { name, data }
            break
          } catch {
            // Not this one -- try the next candidate name.
          }
        }

        if (!found) {
          return attemptSelfHeal('The script finished successfully but produced no output.pdf or output.pptx file. The script must be missing the actual save/write step.')
        }

        addLog(`System: Found ${found.name} (${(found.data.byteLength / 1024).toFixed(1)} KB)`)
        if (mounted && currentRunId === runIdRef.current) {
          setDocumentResult(found)
          setStatus('ready')
          reportExecutionSuccess()
        }

      } catch (err: any) {
        if (mounted) {
          setStatus('error')
          addLog(`Error: ${err.message || 'Execution failed'}`)
        }
      }
    }

    // NEW: the actual automatic-backend fix. When a real Node/npm runtime
    // is available, this runs the frontend AND (if one was built
    // alongside it) the backend as real, separate, coordinated
    // processes -- no manual "cd server && npm run dev" needed. Falls
    // back to WebContainers below whenever a native runtime isn't
    // available, so nothing breaks on a machine without Node installed.
    async function bootNative() {
      try {
        await teardownPrevious()
        await teardownNative()
        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('booting')
        setUrl(null)
        setActiveMode('native')
        addLog('System: Starting native runtime (real Node process, both frontend and backend if present)...')

        const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        nativeRunIdRef.current = runId
        let frontendReadyReceived = false
        // A backend is expected whenever the merged files include a
        // server/ subfolder -- same check the main process itself uses
        // to decide whether to spawn one at all.
        const hasBackendThisRun = Object.keys(files).some(f => f.startsWith('server/'))
        setBackendExpected(hasBackendThisRun)
        setBackendReady(!hasBackendThisRun)

        // @ts-ignore
        const unsubLog = window.api.onSandboxLog((data: any) => {
          if (data.runId !== runId || !mounted) return
          addLog(`[${data.source}] ${data.line}`)
        })
        // @ts-ignore
        const unsubFrontendReady = window.api.onSandboxFrontendReady((data: any) => {
          if (data.runId !== runId || !mounted || currentRunId !== runIdRef.current) return
          frontendReadyReceived = true
          setUrl(data.url)
          setStatus('ready')
          reportExecutionSuccess()
        })
        // @ts-ignore
        const unsubBackendReady = window.api.onSandboxBackendReady((data: any) => {
          if (data.runId !== runId || !mounted) return
          addLog(`System: Backend confirmed running at ${data.url}`)
          setBackendReady(true)
        })
        // @ts-ignore
        const unsubError = window.api.onSandboxError((data: any) => {
          if (data.runId !== runId || !mounted || currentRunId !== runIdRef.current) return
          addLog(`Error [${data.source}]: ${data.message}`)
          // A backend-only failure doesn't fail the whole run -- the
          // frontend may still work on its own, same as the WebContainer
          // path only ever running one process today. A frontend/system
          // failure is fatal to the actual preview, so that's what
          // triggers self-healing.
          if (data.source === 'frontend' || data.source === 'system') {
            attemptSelfHeal(`Native process failed (${data.source}): ${data.message}`)
          }
        })

        nativeUnsubscribersRef.current = [unsubLog, unsubFrontendReady, unsubBackendReady, unsubError]

        // @ts-ignore
        const result = await window.api.startNativeSandbox(runId, files)
        if (!mounted || currentRunId !== runIdRef.current) return
        if (!result.success && !frontendReadyReceived) {
          return attemptSelfHeal(`Native sandbox failed to start: ${result.error}`)
        }
      } catch (err: any) {
        if (mounted) {
          setStatus('error')
          addLog(`Error: ${err.message || 'Native execution failed'}`)
        }
      }
    }

    if (isDocumentOutput) {
      // Documents are quick, one-shot scripts with no server/port
      // involved -- no benefit to native here, and WebContainers already
      // handle this path without hitting any of the service-worker
      // fragility that only affects the live-preview web-app path.
      runDocumentScript()
    } else if (nativeAvailable === null) {
      addLog('System: Checking for a native runtime...')
      // Effect re-runs once detection resolves, since nativeAvailable is
      // in the dependency list below -- nothing to boot yet.
    } else if (nativeAvailable) {
      setActiveMode('native')
      bootNative()
    } else {
      setActiveMode('webcontainer')
      bootWebApp()
    }

    return () => {
      mounted = false
      window.removeEventListener('message', handleRuntimeErrorMessage)
      teardownPrevious()
      teardownNative()
    }
  }, [files, nativeAvailable])

  const handleDownload = () => {
    if (!documentResult) return
    // FIXED: was a binary PDF-or-PPTX check that labeled everything else
    // (docx, xlsx, csv, md) with the PowerPoint MIME type -- harmless for
    // the file's actual content, but wrong for how some browsers/OS
    // combinations decide how to handle or preview the download.
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv',
      '.md': 'text/markdown'
    }
    const ext = '.' + documentResult.name.split('.').pop()
    const mimeType = mimeTypes[ext] || 'application/octet-stream'
    const buffer = new ArrayBuffer(documentResult.data.byteLength)
    new Uint8Array(buffer).set(documentResult.data)
    const blob = new Blob([buffer], { type: mimeType })
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = documentResult.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(objectUrl)
  }

  const statusLabel = () => {
    if (status === 'healing') return `Self-Healing (attempt ${healAttempt} of ${MAX_SELF_HEAL_ROUNDS})...`
    if (isDocumentOutput && status === 'ready') return 'Document Ready'
    return `${status} Environment...`
  }

  return (
    <div className="flex flex-col h-full bg-[#141414] border-t border-white/[0.06]">

      <div className="flex items-center justify-between px-4 py-2 bg-[#191919] border-b border-white/[0.06] text-xs">
        <div className="flex items-center gap-2">
          {status === 'healing' && <Wrench size={14} className={`animate-pulse ${ACCENT.text}`} />}
          {status !== 'ready' && status !== 'error' && status !== 'healing' && <Loader2 size={14} className={`animate-spin ${ACCENT.text}`} />}
          {status === 'ready' && <Globe size={14} className="text-emerald-400" />}
          <span className="font-medium text-neutral-300 capitalize">{statusLabel()}</span>
          {activeMode && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide ${activeMode === 'native' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/10 text-neutral-400'}`}>
              {activeMode === 'native' ? 'Native' : 'WebContainer'}
            </span>
          )}
          {status === 'ready' && backendExpected && !backendReady && (
            <span className="flex items-center gap-1.5 text-[11px] text-amber-400" title="The frontend is up, but the backend is still finishing its own install -- give it a few more seconds before trying to log in or submit anything">
              <Loader2 size={11} className="animate-spin" />
              Backend still starting...
            </span>
          )}
        </div>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className={`${ACCENT.text} hover:underline`}>
            Open Externally &#8599;
          </a>
        )}
      </div>

      <div className="flex flex-col flex-1 overflow-hidden">

        <div className="flex-1 bg-white relative">
          {status === 'healing' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#101010] text-center px-8">
              <Wrench size={32} className={`animate-pulse ${ACCENT.text}`} />
              <p className="text-neutral-300 text-sm">Fixing a real failure automatically -- attempt {healAttempt} of {MAX_SELF_HEAL_ROUNDS}</p>
            </div>
          ) : isDocumentOutput ? (
            status === 'ready' && documentResult ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#101010]">
                <FileText size={40} className="text-emerald-400" />
                <div className="text-center">
                  <p className="text-neutral-200 font-medium">{documentResult.name} is ready</p>
                  <p className="text-neutral-500 text-xs mt-1">{(documentResult.data.byteLength / 1024).toFixed(1)} KB</p>
                </div>
                <button
                  onClick={handleDownload}
                  className={`flex items-center gap-2 px-4 py-2 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-sm font-medium rounded-md transition-colors`}
                >
                  <Download size={16} />
                  Download {documentResult.name}
                </button>
              </div>
            ) : status === 'error' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-red-400 text-sm px-8 text-center">
                Failed to generate the document{canSelfHeal ? ' (self-healing already tried)' : ''} -- check the log below.
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-neutral-600 text-sm">
                Running the document script...
              </div>
            )
          ) : url ? (
            <iframe
              src={url}
              className="w-full h-full border-none"
              title="Sandbox Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
          ) : status === 'error' ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-red-400 text-sm px-8 text-center">
              Failed to start{canSelfHeal ? ' (self-healing already tried)' : ''} -- check the log below.
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-neutral-600">
              Awaiting server URL...
            </div>
          )}
        </div>

        <div className={`bg-[#0f0f0f] border-t border-white/[0.06] flex flex-col transition-all duration-200 ${logsCollapsed ? 'h-9' : 'h-48'}`}>
          <button
            onClick={() => setLogsCollapsed(!logsCollapsed)}
            className="px-3 py-1.5 border-b border-white/[0.05] bg-[#191919] flex items-center justify-between gap-2 text-[10px] text-neutral-500 font-mono uppercase tracking-wider shrink-0 hover:text-neutral-300 transition-colors"
          >
            <span className="flex items-center gap-2">
              <TerminalSquare size={12} />
              Container Output
              {logsCollapsed && status === 'ready' && <span className="text-emerald-500 normal-case">-- running clean, tap to view log</span>}
            </span>
            {logsCollapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {!logsCollapsed && (
            <div className="flex-1 p-3 overflow-y-auto font-mono text-[11px] text-neutral-400 leading-relaxed">
              {logs.map((log, i) => (
                <div key={i} className={log.includes('Error') || log.toLowerCase().includes('error') ? 'text-red-400' : ''}>{log}</div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>

    </div>
  )
}