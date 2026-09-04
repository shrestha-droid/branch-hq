import { useEffect, useState, useRef } from 'react'
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

interface SandboxWebviewConfig {
  preloadPath: string
  src: string
  partition: string
}

// Mirrors MAX_SELF_HEAL_ROUNDS in index.ts -- the main process enforces
// the real cap; this is just so the UI doesn't keep retrying past it
// client-side either.
const MAX_SELF_HEAL_ROUNDS = 2

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
  // NEW: mirrors backendReady state -- needed because the frontend-ready
  // event handler is created once per run and would otherwise only ever
  // see whatever backendReady was AT THAT MOMENT (React closure
  // staleness), not any update backend-ready makes afterward. A ref
  // always reflects the current value regardless of when it's read.
  const backendReadyRef = useRef(false)

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
  // NEW: confirmed real, long-standing bug -- the frontend iframe used
  // to show up and start running its own JS the moment Vite was ready,
  // completely independent of whether a backend it needs was actually
  // up yet. Whether the frontend's first real request succeeded was
  // then entirely down to whatever retry logic the specialist happened
  // to write that specific build -- not a guarantee, since it's
  // generated fresh every time, not fixed infrastructure. This holds
  // a frontend URL that arrived before the backend did, so it can be
  // shown only once both are actually ready, instead of racing.
  const [pendingFrontendUrl, setPendingFrontendUrl] = useState<string | null>(null)
  // NEW: set only for a backend-only native run (direct-chat-to-Dwight-
  // alone) -- distinct from `url`, which drives the actual iframe.
  // There's no visual preview for a backend-only response, so this is
  // used purely to render an honest "confirmed running, nothing to
  // show" message instead of either an iframe or an infinite
  // "Awaiting server URL..." wait.
  const [backendOnlyUrl, setBackendOnlyUrl] = useState<string | null>(null)

  // NEW: the renderer-side half of the COOP/COEP architectural fix.
  // getWebContainer()/buildFileSystemTree() no longer run in this
  // component at all -- they moved to sandbox-webview-entry.ts, which
  // runs inside an isolated <webview> pointed at its own session
  // partition (sandboxSession in index.ts). This component's job now is
  // just to mount that webview, hand it files/mode to run, and relay
  // its log/ready/error/document-ready reports back into the same UI
  // state this component already used to manage directly. Native mode
  // (below) is completely untouched by this -- it never needed
  // WebContainers or this isolation in the first place.
  const [sandboxConfig, setSandboxConfig] = useState<SandboxWebviewConfig | null>(null)
  const webviewContainerRef = useRef<HTMLDivElement>(null)
  const webviewElRef = useRef<any>(null)
  const webviewDomReadyRef = useRef(false)
  const pendingRunRef = useRef<{ files: Record<string, string>; mode: 'webapp' | 'document' } | null>(null)
  // NEW: cleanup for the CURRENT run's ipc-message listener specifically
  // -- distinct from the webview element itself, which persists across
  // runs (self-heal reruns included) so the actual WebContainer boot
  // inside it doesn't have to restart from scratch every time. The
  // listener still needs fresh closures every run (it reads
  // conversationId/agentKey/instructions/healAttempt via
  // attemptSelfHeal, all of which can change between runs), so it's
  // torn down and reattached each run even though the webview it's
  // attached to is not -- the same pattern native mode already uses for
  // its own per-run listeners via nativeUnsubscribersRef, applied here.
  const webviewListenerCleanupRef = useRef<(() => void) | null>(null)
  // NEW: true component-lifetime mount status, distinct from the `let
  // mounted` local declared fresh inside the per-run effect below.
  // Needed because the persistent webview's dom-ready listener survives
  // across multiple effect invocations (multiple runs), so it can't
  // rely on any single run's local `mounted` closure -- that would go
  // stale and permanently false the moment the SECOND run's effect
  // cleanup fired, even though the component itself never actually
  // unmounted.
  const isComponentMountedRef = useRef(true)

  useEffect(() => {
    isComponentMountedRef.current = true
    return () => { isComponentMountedRef.current = false }
  }, [])

  useEffect(() => {
    // @ts-ignore
    window.api.detectRuntime().then((r: any) => setNativeAvailable(r.available)).catch(() => setNativeAvailable(false))
    // @ts-ignore
    window.api.getSandboxWebviewConfig().then(setSandboxConfig).catch(() => setSandboxConfig(null))
  }, [])

  // FIXED: confirmed real misrouting -- relying only on parsing
  // package.json's content meant a Riley generation could, for reasons
  // not fully pinned down, fail this check and get dispatched through
  // bootNative() instead of the sandbox webview -- trying to npm
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

  // NEW: replaces the old teardownPrevious, which killed direct
  // WebContainer process handles this component used to hold
  // (devProcessRef/installProcessRef) before that logic moved into the
  // isolated sandbox webview. This tears down the webview ELEMENT
  // itself -- called when truly switching away from webcontainer mode
  // (into native mode, or on real component unmount), not on every
  // single run within webcontainer mode, since the whole point of the
  // persistent webview is letting the WebContainer boot inside it
  // survive across self-heal reruns.
  const teardownSandboxWebview = () => {
    webviewListenerCleanupRef.current?.()
    webviewListenerCleanupRef.current = null
    pendingRunRef.current = null
    webviewDomReadyRef.current = false
    if (webviewElRef.current) {
      try { webviewElRef.current.remove() } catch { /* already gone, fine */ }
      webviewElRef.current = null
    }
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

    // NEW: catches errors reported by the injected script in the
    // scaffolded index.html (see injectFrontendBoilerplate) for NATIVE
    // mode specifically -- native's preview iframe is still a direct
    // child of this window, so window.parent.postMessage(...) from it
    // still lands here exactly as before. The WebContainer path's
    // equivalent now happens one level further away (inside the
    // sandbox webview's own page, whose iframe's parent is THAT page,
    // not this one) -- sandbox-webview-entry.ts has its own copy of
    // this exact listener for that reason, relaying onward via
    // bridge.reportError instead.
    const handleRuntimeErrorMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'branch-hq-runtime-error') return
      if (!mounted || currentRunId !== runIdRef.current) return
      addLog(`Error [frontend runtime]: ${event.data.message}`)
      attemptSelfHeal(`A runtime error occurred in the browser after the page loaded:\n${event.data.message}`)
    }
    window.addEventListener('message', handleRuntimeErrorMessage)

    // NEW: replaces the old bootWebApp()/runDocumentScript(), which
    // called getWebContainer()/buildFileSystemTree() directly in this
    // component. That logic now lives entirely in
    // sandbox-webview-entry.ts, running inside its own isolated
    // <webview> -- this function's only job is mounting that webview
    // (once, reused across runs) and handing it this run's files/mode.
    // No WebContainer calls happen here anymore, so unlike the function
    // it replaces, this doesn't need to be async at all.
    function bootSandboxWebview(mode: 'webapp' | 'document') {
      if (!mounted || currentRunId !== runIdRef.current) return
      if (!sandboxConfig) {
        addLog('Error: Sandbox runtime configuration was not available.')
        setStatus('error')
        return
      }

      setStatus('booting')
      setUrl(null)
      setDocumentResult(null)
      addLog('System: Booting WebAssembly Container (isolated sandbox)...')

      const runPayload = { files, mode }

      // NEW: fresh listener every run (closures need this run's
      // attemptSelfHeal/healAttempt/etc.), even though the webview
      // element itself is reused across runs -- see
      // webviewListenerCleanupRef's own note above for why.
      webviewListenerCleanupRef.current?.()

      if (!webviewElRef.current) {
        const container = webviewContainerRef.current
        if (!container) return

        // @ts-ignore -- WebviewTag isn't part of the default DOM/React
        // typings this project has configured; matches the existing
        // convention here of ts-ignoring the untyped window.api surface.
        const webview = document.createElement('webview') as any
        webview.src = sandboxConfig.src
        webview.partition = sandboxConfig.partition
        webview.preload = sandboxConfig.preloadPath
        webview.style.cssText = 'width:100%;height:100%;border:none;'
        webview.setAttribute('allowpopups', 'true')

        // Fires exactly once, the first time this webview's guest page
        // finishes loading -- forwards whatever run is pending at that
        // moment. Doesn't touch attemptSelfHeal/etc., so it's safe to
        // leave attached for the webview's whole lifetime without going
        // stale, unlike the ipc-message listener below.
        webview.addEventListener('dom-ready', () => {
          webviewDomReadyRef.current = true
          if (pendingRunRef.current) {
            webview.send('sandbox-webview:run', pendingRunRef.current)
            pendingRunRef.current = null
          }
        })

        webviewElRef.current = webview
        container.appendChild(webview)
      }

      const handleIpcMessage = (event: any) => {
        // Uses isComponentMountedRef, not the per-run `mounted` local --
        // this listener is torn down and replaced every run anyway (see
        // above), so staleness across runs isn't a concern here; this
        // check only needs to catch true component unmount.
        if (!isComponentMountedRef.current) return
        switch (event.channel) {
          case 'sandbox-webview:log':
            addLog(event.args[0])
            break
          case 'sandbox-webview:ready':
            setUrl(event.args[0])
            setStatus('ready')
            reportExecutionSuccess()
            break
          case 'sandbox-webview:error':
            addLog(`Error: ${event.args[0]}`)
            attemptSelfHeal(event.args[0])
            break
          case 'sandbox-webview:document-ready': {
            const { name, data } = event.args[0]
            setDocumentResult({ name, data })
            setStatus('ready')
            reportExecutionSuccess()
            break
          }
        }
      }
      webviewElRef.current.addEventListener('ipc-message', handleIpcMessage)
      webviewListenerCleanupRef.current = () => {
        webviewElRef.current?.removeEventListener('ipc-message', handleIpcMessage)
      }

      if (webviewDomReadyRef.current) {
        webviewElRef.current.send('sandbox-webview:run', runPayload)
      } else {
        pendingRunRef.current = runPayload
      }
    }

    // NEW: the actual automatic-backend fix. When a real Node/npm runtime
    // is available, this runs the frontend AND (if one was built
    // alongside it) the backend as real, separate, coordinated
    // processes -- no manual "cd server && npm run dev" needed. Falls
    // back to the sandbox webview below whenever a native runtime isn't
    // available, so nothing breaks on a machine without Node installed.
    // Entirely untouched by the COOP/COEP fix -- native mode never
    // needed WebContainers or session isolation in the first place.
    async function bootNative() {
      try {
        teardownSandboxWebview()
        await teardownNative()
        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('booting')
        setUrl(null)
        setBackendOnlyUrl(null)
        setPendingFrontendUrl(null)
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
        backendReadyRef.current = !hasBackendThisRun

        // @ts-ignore
        const unsubLog = window.api.onSandboxLog((data: any) => {
          if (data.runId !== runId || !mounted) return
          addLog(`[${data.source}] ${data.line}`)
        })
        // @ts-ignore
        const unsubFrontendReady = window.api.onSandboxFrontendReady((data: any) => {
          if (data.runId !== runId || !mounted || currentRunId !== runIdRef.current) return
          frontendReadyReceived = true
          // FIXED: confirmed real, long-standing bug -- this used to
          // show the iframe unconditionally the moment Vite was ready,
          // with zero regard for whether a backend it needs was
          // actually up yet. The frontend's own first request (its
          // useEffect firing the instant the page loads) would then
          // race the backend's own startup, and whether that first
          // request succeeded was entirely down to whatever retry logic
          // the specialist happened to generate that specific build --
          // not a guarantee, since it's written fresh every time, not
          // fixed infrastructure. Holding the URL here until the
          // backend is actually confirmed closes the race at the
          // source, regardless of what the generated retry code does.
          if (hasBackendThisRun && !backendReadyRef.current) {
            setPendingFrontendUrl(data.url)
            addLog('System: Frontend is ready -- waiting for the backend to finish starting before showing the preview, so its first real request doesn\'t race the backend\'s own startup.')
            return
          }
          setUrl(data.url)
          setStatus('ready')
          reportExecutionSuccess()
        })
        // @ts-ignore
        const unsubBackendReady = window.api.onSandboxBackendReady((data: any) => {
          if (data.runId !== runId || !mounted) return
          addLog(`System: Backend confirmed running at ${data.url}`)
          setBackendReady(true)
          backendReadyRef.current = true
          // If the frontend was already ready and held back waiting on
          // this, show it now -- both are genuinely up together, not
          // one racing ahead of the other.
          setPendingFrontendUrl((pending) => {
            if (pending) {
              setUrl(pending)
              setStatus('ready')
              reportExecutionSuccess()
            }
            return null
          })
        })
        // NEW: fires only for a backend-only run (a direct-chat-to-
        // Dwight-alone response, correctly identified as backend-only
        // now that it's properly prefixed) -- there's no frontend-ready
        // event ever coming to mark the run complete, so this is what
        // actually does it. Deliberately does NOT set `url` (there's no
        // visual preview to show) -- see the render logic below for how
        // this is displayed honestly instead of just reusing the
        // iframe-based "ready" state.
        // @ts-ignore
        const unsubBackendOnlyComplete = window.api.onSandboxBackendOnlyComplete((data: any) => {
          if (data.runId !== runId || !mounted || currentRunId !== runIdRef.current) return
          setBackendOnlyUrl(data.url)
          setStatus('ready')
          reportExecutionSuccess()
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
          // FIXED: confirmed real gap in the backend-readiness gating
          // above -- if the backend fails outright rather than just
          // being slow, a frontend held back waiting for it would
          // otherwise wait forever for a backend that's already
          // confirmed dead, which is worse than the race this fix was
          // meant to close. Show it anyway; a backend-dependent frontend
          // failing its own requests is a real, visible, honest state
          // -- an indefinite blank "Awaiting server URL..." is not.
          if (data.source === 'backend') {
            setPendingFrontendUrl((pending) => {
              if (pending) {
                setUrl(pending)
                setStatus('ready')
                reportExecutionSuccess()
              }
              return null
            })
          }
        })

        nativeUnsubscribersRef.current = [unsubLog, unsubFrontendReady, unsubBackendReady, unsubBackendOnlyComplete, unsubError]

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
      // involved -- always the sandbox webview path, regardless of
      // native availability, same as before.
      // FIXED: confirmed real bug -- this branch previously called
      // bootSandboxWebview('document') unconditionally, without
      // checking whether sandboxConfig (fetched async on mount) had
      // actually resolved yet. The webapp-fallback branch below always
      // had this guard correctly; this one didn't. Confirmed via a
      // real first test: "Error: Sandbox runtime configuration was not
      // available" fired exactly when this ran before the config
      // arrived, then the effect re-ran once it did and started
      // booting for real -- a genuine race, not a WebContainer problem.
      if (!sandboxConfig) {
        addLog('System: Waiting for the sandbox runtime configuration...')
      } else {
        setActiveMode('webcontainer')
        bootSandboxWebview('document')
      }
    } else if (nativeAvailable === null) {
      addLog('System: Checking for a native runtime...')
      // Effect re-runs once detection resolves, since nativeAvailable is
      // in the dependency list below -- nothing to boot yet.
    } else if (nativeAvailable) {
      setActiveMode('native')
      bootNative()
    } else if (!sandboxConfig) {
      addLog('System: Waiting for the sandbox runtime configuration...')
      // Effect re-runs once sandboxConfig resolves, since it's in the
      // dependency list below.
    } else {
      setActiveMode('webcontainer')
      bootSandboxWebview('webapp')
    }

    return () => {
      mounted = false
      window.removeEventListener('message', handleRuntimeErrorMessage)
      teardownNative()
    }
  }, [files, nativeAvailable, sandboxConfig])

  // Real, full teardown of the sandbox webview on actual component
  // unmount -- distinct from the per-run effect above, which
  // deliberately does NOT tear the webview down between runs.
  useEffect(() => {
    return () => { teardownSandboxWebview() }
  }, [])

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
          {/* NEW: persistent host for the WebContainer sandbox <webview>.
              Always mounted (as a base layer, positioned behind whatever
              status overlay is showing) whenever this run is in
              webcontainer mode and isn't a document -- unlike the old
              direct-iframe approach, this element must stay in the DOM
              continuously across booting/installing/ready, since the
              running WebContainer instance now lives inside its own
              guest process, not just in this component's JS memory.
              Status overlays below fully cover it with an opaque
              background until status === 'ready', at which point no
              overlay renders and it shows through untouched. */}
          {activeMode === 'webcontainer' && !isDocumentOutput && (
            <div ref={webviewContainerRef} className="absolute inset-0" />
          )}

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
          ) : activeMode === 'native' ? (
            url ? (
              <iframe
                src={url}
                className="w-full h-full border-none"
                title="Sandbox Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              />
            ) : backendOnlyUrl ? (
              // NEW: a backend-only response (direct-chat-to-Dwight-
              // alone) has no frontend to show -- shown honestly here
              // instead of either forcing a fake iframe or leaving the
              // "Awaiting server URL..." placeholder showing forever
              // even though the run genuinely succeeded.
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#101010] text-center px-8">
                <Globe size={28} className="text-emerald-400 mb-1" />
                <p className="text-neutral-200 text-sm font-medium">Backend confirmed running at {backendOnlyUrl}</p>
                <p className="text-neutral-500 text-xs max-w-sm">This response was backend-only -- no frontend was generated, so there's nothing to visually preview. The server is real and reviewed; check the Code tab to see it.</p>
              </div>
            ) : status === 'error' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-red-400 text-sm px-8 text-center">
                Failed to start{canSelfHeal ? ' (self-healing already tried)' : ''} -- check the log below.
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-neutral-600">
                Awaiting server URL...
              </div>
            )
          ) : activeMode === 'webcontainer' ? (
            status === 'ready' ? null : status === 'error' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-red-400 text-sm px-8 text-center">
                Failed to start{canSelfHeal ? ' (self-healing already tried)' : ''} -- check the log below.
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-neutral-600">
                Awaiting server URL...
              </div>
            )
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