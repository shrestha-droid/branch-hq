import { useState } from 'react'
import { useOfficeStore } from './store/officeStore'
import ChatInterface from './components/ChatInterface'
import SandboxPreview from './components/SandboxPreview'
import { LayoutGrid, MessageSquare, Code2, FileCode, X, CheckCircle2, Play, HardDriveDownload, Loader2 } from 'lucide-react'

// Same small note as ChatInterface.tsx: one place to change the accent color.
const ACCENT = {
  text: 'text-[#c1554b]',
  bg: 'bg-[#a8443c]',
  bgHover: 'hover:bg-[#b84f45]',
  bgSoft: 'bg-[#a8443c]/10',
  border: 'border-[#a8443c]/30',
}

export default function App() {
  const { activeAgent, setActiveAgent } = useOfficeStore()
  const agents = ['Michael', 'Jim', 'Dwight', 'Pam'] as const
  const [previewFiles, setPreviewFiles] = useState<Record<string, string> | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('preview')

  // Phase 4: File System Sync State
  const [targetDir, setTargetDir] = useState('/Users/ShresthaPandey/branch-hq-output')
  const [isPushing, setIsPushing] = useState(false)
  const [pushStatus, setPushStatus] = useState<string | null>(null)
  
  // Phase 3: RAG File Scanner State
  const [isIndexing, setIsIndexing] = useState(false)

  const handleCodeGenerated = (files: Record<string, string>) => {
    if (files && Object.keys(files).length > 0) {
      setPreviewFiles(files)
      const primary = Object.keys(files).find(f => f.includes('App.tsx')) || Object.keys(files)[0]
      if (primary) setSelectedFile(primary)
      setViewMode('preview') // Automatically switch to the live preview when code arrives
      setPushStatus(null)
    }
  }

  // Phase 3: Index Workspace Handler
  const handleIndexWorkspace = async () => {
    if (!targetDir) return
    setIsIndexing(true)
    setPushStatus('Scanning workspace...')
    
    try {
      // @ts-ignore
      const res = await window.api.indexWorkspace(targetDir)
      if (res.success) {
        setPushStatus(`Indexed ${res.indexedFiles} files into AI memory.`)
      } else {
        setPushStatus(`Failed to index: ${res.error}`)
      }
    } catch (err: any) {
      setPushStatus(`Index error: ${err.message}`)
    } finally {
      setIsIndexing(false)
    }
  }

  // Phase 4: Write to Disk Handler
  const handlePushToLocal = async () => {
    if (!previewFiles || !targetDir) return

    setIsPushing(true)
    setPushStatus(null)

    try {
      // @ts-ignore
      // Note: Assuming your ipc renderer for fs:write is exposed as window.api.writeFiles
      const res = await window.api.writeFiles(targetDir, previewFiles)
      if (res.success) {
        setPushStatus(`Wrote ${res.writtenFiles?.length} files to disk.`)
      } else {
        setPushStatus(`Failed to write: ${res.error}`)
      }
    } catch (err: any) {
      setPushStatus(`Error: ${err.message}`)
    } finally {
      setIsPushing(false)
    }
  }

  return (
    <div className="flex h-screen w-screen bg-[#141414] text-neutral-200 overflow-hidden">

      {/* Sidebar */}
      <aside className="w-[240px] bg-[#191919] p-3 flex flex-col border-r border-white/[0.06] z-30">
        <div className={`flex items-center gap-2 mb-6 px-3 pt-2 ${ACCENT.text}`}>
          <LayoutGrid size={20} />
          <h1 className="text-sm font-medium text-neutral-100">Branch HQ</h1>
        </div>
        <nav className="flex flex-col gap-1">
          {agents.map((agent) => (
            <button
              key={agent} onClick={() => setActiveAgent(agent)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                activeAgent === agent
                  ? `${ACCENT.bgSoft} ${ACCENT.text}`
                  : 'text-neutral-400 hover:bg-white/[0.04]'
              }`}
            >
              <MessageSquare size={15} />
              {agent}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Chat Area */}
      <main className={`flex flex-col h-full transition-all duration-300 ${previewFiles ? 'w-1/2 border-r border-white/[0.06]' : 'flex-1'}`}>
        <ChatInterface activeAgent={activeAgent} onCodeGenerated={handleCodeGenerated} />
      </main>

      {/* Right Split-Pane */}
      {previewFiles && (
        <section className="w-1/2 h-full flex flex-col bg-[#101010]">

          {/* Panel Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-[#191919] border-b border-white/[0.06] shrink-0">
            <div className="flex items-center gap-2 text-sm text-neutral-300">
              <Code2 size={16} className={ACCENT.text} />
              <span>Staged (Gate 1 passed)</span>
            </div>

            {/* View Mode Toggle */}
            <div className="flex bg-black/30 rounded-lg p-0.5 border border-white/[0.06]">
              <button
                onClick={() => setViewMode('code')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${viewMode === 'code' ? 'bg-white/10 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                Code
              </button>
              <button
                onClick={() => setViewMode('preview')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${viewMode === 'preview' ? `${ACCENT.bg} text-white` : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                <Play size={12} className={viewMode === 'preview' ? 'fill-white' : ''} />
                Preview
              </button>
            </div>

            <button onClick={() => { setPreviewFiles(null); setSelectedFile(null); }} className="text-neutral-500 hover:text-white" title="Close">
              <X size={16} />
            </button>
          </div>

          {/* Panel Content */}
          {viewMode === 'code' ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              {/* File Tabs */}
              <div className="flex gap-1.5 px-3 py-2 bg-[#141414] border-b border-white/[0.05] overflow-x-auto shrink-0">
                {Object.keys(previewFiles).map((filename) => (
                  <button
                    key={filename} onClick={() => setSelectedFile(filename)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono whitespace-nowrap transition-colors ${selectedFile === filename ? 'bg-white/10 text-neutral-100' : 'text-neutral-500 hover:bg-white/5'}`}
                  >
                    <FileCode size={13} /> {filename}
                  </button>
                ))}
              </div>

              {/* Code Viewer */}
              <div className="flex-1 p-4 overflow-auto">
                {selectedFile && previewFiles[selectedFile] && (
                  <pre className="bg-[#0a0a0a] p-4 rounded-xl border border-white/[0.06] text-xs font-mono text-neutral-300">
                    <code>{previewFiles[selectedFile]}</code>
                  </pre>
                )}
              </div>
            </div>
          ) : (
            /* Live Execution Sandbox */
            <div className="flex-1 overflow-hidden relative">
              <SandboxPreview files={previewFiles} />
            </div>
          )}

          {/* Phase 4 & Phase 3: Universal Sync Footer */}
          <div className="p-4 bg-[#191919] border-t border-white/[0.06] flex flex-col gap-3 shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 flex flex-col gap-1.5">
                <label className="text-xs font-medium text-neutral-500">
                  Target folder
                </label>
                <input
                  type="text"
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder="/Users/username/Projects/my-app"
                  className={`w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:${ACCENT.border} outline-none transition-colors`}
                />
              </div>
              <div className="flex gap-2 mt-5">
                <button
                  onClick={handleIndexWorkspace}
                  disabled={isIndexing || !targetDir.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-xs font-medium rounded-md disabled:opacity-50 transition-colors"
                  title="Scan this folder into AI memory"
                >
                  {isIndexing ? <Loader2 size={14} className="animate-spin" /> : <Code2 size={14} />}
                  Scan Workspace
                </button>
                <button
                  onClick={handlePushToLocal}
                  disabled={isPushing || !targetDir.trim()}
                  className={`flex items-center gap-2 px-4 py-2 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-xs font-medium rounded-md disabled:opacity-50 transition-colors`}
                >
                  {isPushing ? <Loader2 size={14} className="animate-spin" /> : <HardDriveDownload size={14} />}
                  Push to Local
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 text-neutral-500">
                <CheckCircle2 size={13} className="text-emerald-500/70" />
                <span>{Object.keys(previewFiles).length} files ready</span>
              </div>
              {pushStatus && (
                <span className={pushStatus.includes('error') || pushStatus.includes('Failed') ? 'text-red-400' : 'text-emerald-400'}>
                  {pushStatus}
                </span>
              )}
            </div>
          </div>

        </section>
      )}
    </div>
  )
}