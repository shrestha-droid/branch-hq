import { useEffect, useState, useRef } from 'react'
import { getWebContainer, buildFileSystemTree } from '../lib/webcontainer'
import { Loader2, TerminalSquare, Globe } from 'lucide-react'

interface SandboxPreviewProps {
  files: Record<string, string>
}

export default function SandboxPreview({ files }: SandboxPreviewProps) {
  const [status, setStatus] = useState<'booting' | 'installing' | 'starting' | 'ready' | 'error'>('booting')
  const [logs, setLogs] = useState<string[]>([])
  const [url, setUrl] = useState<string | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const runIdRef = useRef<number>(0) // Prevents race conditions on rapid regenerations

  const addLog = (msg: string) => setLogs(prev => [...prev.slice(-99), msg]) // Keep last 100 logs

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  useEffect(() => {
    let mounted = true
    const currentRunId = ++runIdRef.current
    
    async function bootSandbox() {
      try {
        setStatus('booting')
        addLog('System: Booting WebAssembly Container...')
        const wc = await getWebContainer()
        
        if (!mounted || currentRunId !== runIdRef.current) return

        // 1. Mount the files
        addLog('System: Mounting virtual filesystem...')
        const tree = buildFileSystemTree(files)
        await wc.mount(tree)

        // 2. Install dependencies
        setStatus('installing')
        addLog('System: Running npm install (this takes a moment on first run)...')
        const installProcess = await wc.spawn('npm', ['install'])
        
        installProcess.output.pipeTo(new WritableStream({
          write(data) { if (mounted) addLog(data.trim()) }
        }))

        const installExitCode = await installProcess.exit
        if (installExitCode !== 0) {
          throw new Error('npm install failed')
        }

        if (!mounted || currentRunId !== runIdRef.current) return

        // 3. Start the dev server
        setStatus('starting')
        addLog('System: Starting Vite dev server...')
        const devProcess = await wc.spawn('npm', ['run', 'dev'])
        
        devProcess.output.pipeTo(new WritableStream({
          write(data) { if (mounted) addLog(data.trim()) }
        }))

        // 4. Capture the preview URL
        wc.on('server-ready', (port, previewUrl) => {
          if (mounted && currentRunId === runIdRef.current) {
            addLog(`System: Server ready on port ${port}`)
            setUrl(previewUrl)
            setStatus('ready')
          }
        })

      } catch (err: any) {
        if (mounted) {
          setStatus('error')
          addLog(`Error: ${err.message || 'Execution failed'}`)
        }
      }
    }

    bootSandbox()

    return () => { mounted = false }
  }, [files])

  return (
    <div className="flex flex-col h-full bg-[#1e1e1f] border-t border-neutral-800">
      
      {/* Top Status Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#121213] border-b border-neutral-800 text-xs">
        <div className="flex items-center gap-2">
          {status !== 'ready' && status !== 'error' && <Loader2 size={14} className="animate-spin text-blue-400" />}
          {status === 'ready' && <Globe size={14} className="text-emerald-400" />}
          <span className="font-medium text-neutral-300 capitalize">{status} Environment...</span>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline">
            Open Externally ↗
          </a>
        )}
      </div>

      {/* Split View: Iframe (Top) / Terminal (Bottom) */}
      <div className="flex flex-col flex-1 overflow-hidden">
        
        {/* Iframe Preview */}
        <div className="flex-1 bg-white relative">
          {url ? (
            <iframe 
              src={url} 
              className="w-full h-full border-none"
              title="Sandbox Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[#131314] text-neutral-600">
              Awaiting server URL...
            </div>
          )}
        </div>

        {/* Terminal Logs */}
        <div className="h-48 bg-[#0a0a0a] border-t border-neutral-800 flex flex-col">
          <div className="px-3 py-1.5 border-b border-neutral-800/60 bg-[#121213] flex items-center gap-2 text-[10px] text-neutral-500 font-mono uppercase tracking-wider">
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