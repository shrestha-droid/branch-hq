import { useEffect, useState, useRef } from 'react'
import { getWebContainer, buildFileSystemTree } from '../lib/webcontainer'
import { Loader2, TerminalSquare, Globe, FileText, Download } from 'lucide-react'

interface SandboxPreviewProps {
  files: Record<string, string>
}

// Same accent convention as ChatInterface.tsx / App.tsx -- one place to
// change the brand color later.
const ACCENT = {
  text: 'text-[#c1554b]',
  bg: 'bg-[#a8443c]',
  bgHover: 'hover:bg-[#b84f45]',
}

interface DocumentResult {
  name: string
  data: Uint8Array
}

export default function SandboxPreview({ files }: SandboxPreviewProps) {
  const [status, setStatus] = useState<'booting' | 'installing' | 'starting' | 'ready' | 'error'>('booting')
  const [logs, setLogs] = useState<string[]>([])
  const [url, setUrl] = useState<string | null>(null)
  const [documentResult, setDocumentResult] = useState<DocumentResult | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const runIdRef = useRef<number>(0) // Prevents race conditions on rapid regenerations

  const devProcessRef = useRef<any>(null)
  const installProcessRef = useRef<any>(null)
  const unsubscribeServerReadyRef = useRef<(() => void) | null>(null)

  // NEW: same marker App.tsx uses to tell a document script apart from a
  // real webpage/server -- injectDocumentBoilerplate always sets this
  // exact package name.
  const isDocumentOutput = files['package.json']?.includes('"branch-hq-preview-docs"') ?? false

  const addLog = (msg: string) => setLogs(prev => [...prev.slice(-99), msg]) // Keep last 100 logs

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  const teardownPrevious = async () => {
    unsubscribeServerReadyRef.current?.()
    unsubscribeServerReadyRef.current = null

    try { await devProcessRef.current?.kill?.() } catch { /* already gone, fine */ }
    devProcessRef.current = null

    try { await installProcessRef.current?.kill?.() } catch { /* already gone, fine */ }
    installProcessRef.current = null
  }

  useEffect(() => {
    let mounted = true
    const currentRunId = ++runIdRef.current

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

        setStatus('installing')
        addLog('System: Running npm install (this takes a moment on first run)...')
        const installProcess = await wc.spawn('npm', ['install'])
        installProcessRef.current = installProcess

        installProcess.output.pipeTo(new WritableStream({
          write(data) { if (mounted) addLog(data.trim()) }
        }))

        const installExitCode = await installProcess.exit
        if (installExitCode !== 0) {
          throw new Error('npm install failed')
        }

        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('starting')
        addLog('System: Starting dev server...')
        const devProcess = await wc.spawn('npm', ['run', 'dev'])
        devProcessRef.current = devProcess

        devProcess.output.pipeTo(new WritableStream({
          write(data) { if (mounted) addLog(data.trim()) }
        }))

        const unsubscribe = wc.on('server-ready', (port: number, previewUrl: string) => {
          if (mounted && currentRunId === runIdRef.current) {
            addLog(`System: Server ready on port ${port}`)
            setUrl(previewUrl)
            setStatus('ready')
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

    // NEW: a document script has no server to wait on -- it runs once,
    // writes a file, and exits. Waiting for a 'server-ready' event here
    // would wait forever, which is exactly the stuck panel this replaces.
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

        setStatus('installing')
        addLog('System: Running npm install (this takes a moment on first run)...')
        const installProcess = await wc.spawn('npm', ['install'])
        installProcessRef.current = installProcess

        installProcess.output.pipeTo(new WritableStream({
          write(data) { if (mounted) addLog(data.trim()) }
        }))

        const installExitCode = await installProcess.exit
        if (installExitCode !== 0) {
          throw new Error('npm install failed')
        }

        if (!mounted || currentRunId !== runIdRef.current) return

        setStatus('starting')
        addLog('System: Running the document script...')
        const runProcess = await wc.spawn('npm', ['run', 'dev'])
        devProcessRef.current = runProcess

        runProcess.output.pipeTo(new WritableStream({
          write(data) { if (mounted) addLog(data.trim()) }
        }))

        // The real difference from the webapp path: wait for the process
        // to actually EXIT, not for a server event that will never fire.
        const runExitCode = await runProcess.exit
        if (!mounted || currentRunId !== runIdRef.current) return

        if (runExitCode !== 0) {
          throw new Error('The document script did not finish successfully -- check the log below.')
        }

        addLog('System: Script finished. Looking for the output file...')
        const candidateNames = ['output.pdf', 'output.pptx']
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
          throw new Error('The script finished, but no output.pdf or output.pptx was found in the project.')
        }

        addLog(`System: Found ${found.name} (${(found.data.byteLength / 1024).toFixed(1)} KB)`)
        if (mounted && currentRunId === runIdRef.current) {
          setDocumentResult(found)
          setStatus('ready')
        }

      } catch (err: any) {
        if (mounted) {
          setStatus('error')
          addLog(`Error: ${err.message || 'Execution failed'}`)
        }
      }
    }

    if (isDocumentOutput) {
      runDocumentScript()
    } else {
      bootWebApp()
    }

    return () => {
      mounted = false
      teardownPrevious()
    }
  }, [files])

  // NEW: triggers a real browser download of the file pulled out of the
  // sandbox. Blob/URL.createObjectURL are plain DOM APIs, available in
  // Electron's renderer the same as in any browser.
  const handleDownload = () => {
    if (!documentResult) return
    const mimeType = documentResult.name.endsWith('.pdf')
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    // FIXED: documentResult.data comes back from the sandbox typed as
    // Uint8Array<ArrayBufferLike> (which could technically be backed by a
    // SharedArrayBuffer), but Blob's constructor wants a plain ArrayBuffer
    // specifically. Copying the bytes into a fresh, definite ArrayBuffer
    // sidesteps the mismatch entirely instead of fighting the types.
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

  return (
    <div className="flex flex-col h-full bg-[#141414] border-t border-white/[0.06]">

      {/* Top Status Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#191919] border-b border-white/[0.06] text-xs">
        <div className="flex items-center gap-2">
          {status !== 'ready' && status !== 'error' && <Loader2 size={14} className={`animate-spin ${ACCENT.text}`} />}
          {status === 'ready' && <Globe size={14} className="text-emerald-400" />}
          <span className="font-medium text-neutral-300 capitalize">
            {isDocumentOutput && status === 'ready' ? 'Document Ready' : `${status} Environment...`}
          </span>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className={`${ACCENT.text} hover:underline`}>
            Open Externally ↗
          </a>
        )}
      </div>

      {/* Split View: Preview (Top) / Terminal (Bottom) */}
      <div className="flex flex-col flex-1 overflow-hidden">

        <div className="flex-1 bg-white relative">
          {isDocumentOutput ? (
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
                Failed to generate the document -- check the log below.
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
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[#101010] text-neutral-600">
              Awaiting server URL...
            </div>
          )}
        </div>

        {/* Terminal Logs */}
        <div className="h-48 bg-[#0f0f0f] border-t border-white/[0.06] flex flex-col">
          <div className="px-3 py-1.5 border-b border-white/[0.05] bg-[#191919] flex items-center gap-2 text-[10px] text-neutral-500 font-mono uppercase tracking-wider">
            <TerminalSquare size={12} />
            Container Output
          </div>
          <div className="flex-1 p-3 overflow-y-auto font-mono text-[11px] text-neutral-400 leading-relaxed">
            {logs.map((log, i) => (
              <div key={i} className={log.includes('Error') ? 'text-red-400' : ''}>{log}</div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>

    </div>
  )
}