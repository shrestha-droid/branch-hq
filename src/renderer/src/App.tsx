import { useState } from 'react'
import { useOfficeStore } from './store/officeStore'
import ChatInterface from './components/ChatInterface'
import SandboxPreview from './components/SandboxPreview'
import { LayoutGrid, MessageSquare, Code2, FileCode, X, CheckCircle2, Play, HardDriveDownload, Loader2 } from 'lucide-react'

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

  const handleCodeGenerated = (files: Record<string, string>) => {
    if (files && Object.keys(files).length > 0) {
      setPreviewFiles(files)
      const primary = Object.keys(files).find(f => f.includes('App.tsx')) || Object.keys(files)[0]
      if (primary) setSelectedFile(primary)
      setViewMode('preview') // Automatically switch to the live preview when code arrives
      setPushStatus(null)
    }
  }

  // Phase 4: Write to Disk Handler
  const handlePushToLocal = async () => {
    if (!previewFiles || !targetDir) return

    setIsPushing(true)
    setPushStatus(null)

    try {
      // @ts-ignore
      const res = await window.api.writeFiles(targetDir, previewFiles)
      if (res.success) {
        setPushStatus(`✅ Successfully wrote ${res.writtenFiles?.length} files to disk!`)
      } else {
        setPushStatus(`❌ Failed to write: ${res.error}`)
      }
    } catch (err: any) {
      setPushStatus(`❌ Fatal Error: ${err.message}`)
    } finally {
      setIsPushing(false)
    }
  }

  return (
    <div className="flex h-screen w-screen bg-[#131314] text-neutral-200 overflow-hidden">
      
      {/* Sidebar */}
      <aside className="w-[240px] bg-[#1a1a1b] p-3 flex flex-col border-r border-neutral-800/60 z-30">
        <div className="flex items-center gap-2 mb-6 px-3 pt-2 text-blue-400">
          <LayoutGrid size={20} />
          <h1 className="text-sm font-semibold uppercase text-neutral-100">Branch HQ</h1>
        </div>
        <nav className="flex flex-col gap-1">
          {agents.map((agent) => (
            <button
              key={agent} onClick={() => setActiveAgent(agent)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${activeAgent === agent ? 'bg-blue-600/15 text-blue-400 border border-blue-500/20' : 'text-neutral-400 hover:bg-neutral-800/40'}`}
            >
              <MessageSquare size={15} />
              {agent}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Chat Area (Expands to flex-1 when preview is closed, splits to w-1/2 when preview is open) */}
      <main className={`flex flex-col h-full transition-all duration-300 ${previewFiles ? 'w-1/2 border-r border-neutral-800/60' : 'flex-1'}`}>
        <ChatInterface activeAgent={activeAgent} onCodeGenerated={handleCodeGenerated} />
      </main>

      {/* Right Split-Pane (Appears dynamically only when code files are staged) */}
      {previewFiles && (
        <section className="w-1/2 h-full flex flex-col bg-[#0f0f10] animate-in slide-in-from-right duration-300">
          
          {/* Panel Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-[#171718] border-b border-neutral-800/60 shrink-0">
            <div className="flex items-center gap-2 text-xs font-medium text-neutral-200">
              <Code2 size={16} className="text-blue-400" />
              <span>Staged Environment (Gate 1 Passed)</span>
            </div>
            
            {/* View Mode Toggle */}
            <div className="flex bg-[#0a0a0a] rounded-lg p-0.5 border border-neutral-800">
              <button 
                onClick={() => setViewMode('code')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${viewMode === 'code' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                Code
              </button>
              <button 
                onClick={() => setViewMode('preview')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all ${viewMode === 'preview' ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                <Play size={12} className={viewMode === 'preview' ? 'fill-white' : ''} />
                Live Preview
              </button>
            </div>
            
            <button onClick={() => { setPreviewFiles(null); setSelectedFile(null); }} className="text-neutral-500 hover:text-white" title="Close Preview">
              <X size={16} />
            </button>
          </div>

          {/* Panel Content (Conditional) */}
          {viewMode === 'code' ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              {/* File Tabs */}
              <div className="flex gap-1.5 px-3 py-2 bg-[#121213] border-b border-neutral-800/40 overflow-x-auto shrink-0">
                {Object.keys(previewFiles).map((filename) => (
                  <button
                    key={filename} onClick={() => setSelectedFile(filename)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono whitespace-nowrap ${selectedFile === filename ? 'bg-neutral-800 text-blue-300 border border-neutral-700' : 'text-neutral-500 hover:bg-neutral-900'}`}
                  >
                    <FileCode size={13} /> {filename}
                  </button>
                ))}
              </div>

              {/* Code Viewer */}
              <div className="flex-1 p-4 overflow-auto">
                {selectedFile && previewFiles[selectedFile] && (
                  <pre className="bg-[#050505] p-4 rounded-xl border border-neutral-800/80 text-xs font-mono text-neutral-300">
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
          
          {/* Phase 4: Universal Sync Footer */}
          <div className="p-4 bg-[#121213] border-t border-neutral-800/60 flex flex-col gap-3 shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 flex flex-col gap-1.5">
                <label className="text-[10px] font-semibold text-blue-400/80 uppercase tracking-wider">
                  Target Sync Directory
                </label>
                <input
                  type="text"
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder="/Users/username/Projects/my-app"
                  className="w-full bg-[#0a0a0a] border border-neutral-800 rounded-md px-3 py-2 text-xs text-neutral-200 focus:border-blue-500 outline-none transition-colors"
                />
              </div>
              <button
                onClick={handlePushToLocal}
                disabled={isPushing || !targetDir.trim()}
                className="mt-5 flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-md disabled:opacity-50 transition-colors shadow-lg shadow-blue-900/20"
              >
                {isPushing ? <Loader2 size={14} className="animate-spin" /> : <HardDriveDownload size={14} />}
                Push to Local
              </button>
            </div>
            
            <div className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-1.5 text-neutral-500">
                <CheckCircle2 size={13} className="text-emerald-500/70" />
                <span>{Object.keys(previewFiles).length} files scaffolded and ready</span>
              </div>
              {pushStatus && (
                <span className={pushStatus.includes('✅') ? 'text-emerald-400' : 'text-rose-400'}>
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