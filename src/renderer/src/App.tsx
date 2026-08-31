import { useState, useEffect } from 'react'
import ChatInterface from './components/ChatInterface'
import SandboxPreview from './components/SandboxPreview'
import SettingsModal from './components/SettingsModal'
import { LayoutGrid, Code2, FileCode, X, CheckCircle2, Play, HardDriveDownload, Loader2, AlertTriangle, Activity, ShieldCheck } from 'lucide-react'

const ACCENT = {
  text: 'text-[#c1554b]',
  bg: 'bg-[#a8443c]',
  bgHover: 'hover:bg-[#b84f45]',
  bgSoft: 'bg-[#a8443c]/10',
  border: 'border-[#a8443c]/30',
}

export default function App() {
  // NEW: no more agent picker. Michael himself decides, per message,
  // whether to just talk or bring in a specialist -- so there's nothing
  // left to pick a mode for. ChatInterface's own conversation list is now
  // the only sidebar.
  const [previewFiles, setPreviewFiles] = useState<Record<string, string> | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('preview')

  // NEW: context self-healing needs -- which conversation, which
  // specialist, and the original instructions -- so the sandbox can ask
  // for a real fix if the code fails when actually run, not just note
  // that it failed.
  const [healContext, setHealContext] = useState<{
    conversationId: string
    agentKey?: 'jim' | 'dwight' | 'riley'
    instructions?: string
  } | null>(null)

  const [targetDir, setTargetDir] = useState('/Users/ShresthaPandey/branch-hq-output')
  const [isPushing, setIsPushing] = useState(false)
  const [pushStatus, setPushStatus] = useState<string | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  // NEW: files that already exist at the target path -- shown as a
  // confirmation step instead of silently overwriting them.
  const [pendingConflicts, setPendingConflicts] = useState<string[] | null>(null)
  // NEW: rough model-call usage, so the cost of a session isn't invisible.
  const [usage, setUsage] = useState<{ callCount: number; charsIn: number; charsOut: number } | null>(null)
  // NEW: real Settings UI, and picking up whatever default folder was
  // configured there instead of only ever showing the hardcoded one.
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    // @ts-ignore
    window.api.getSettings().then((s: any) => {
      if (s.defaultTargetDir) setTargetDir(s.defaultTargetDir)
    }).catch(() => {})
  }, [])

  const handleCodeGenerated = (result: { files: Record<string, string>; conversationId: string; agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string }) => {
    if (result.files && Object.keys(result.files).length > 0) {
      setPreviewFiles(result.files)
      setHealContext({ conversationId: result.conversationId, agentKey: result.agentKey, instructions: result.instructions })
      const primary = Object.keys(result.files).find(f => f.includes('App.tsx')) || Object.keys(result.files)[0]
      if (primary) setSelectedFile(primary)
      setViewMode('preview')
      setPushStatus(null)
      refreshUsage()
    }
  }

  // Called by SandboxPreview once a self-heal round produces corrected
  // files -- updates what's staged so Code/Push to Local reflect the
  // fixed version, not the one that just failed.
  const handleFilesHealed = (files: Record<string, string>) => {
    setPreviewFiles(files)
  }

  // Called whenever the active conversation has nothing of its own staged
  // -- clears the panel entirely so it can't keep showing a PREVIOUS
  // conversation's sandbox. Setting previewFiles to null unmounts
  // SandboxPreview, whose own cleanup effect kills whatever process was
  // still running for it.
  const handleClearPreview = () => {
    setPreviewFiles(null)
    setSelectedFile(null)
    setHealContext(null)
    setPushStatus(null)
  }

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

  // NEW: two-step push. Checks for existing files FIRST and asks before
  // replacing them -- previously this silently overwrote whatever was
  // already there, which is fine for an empty output folder and
  // potentially destructive when pointed at a real project.
  const handlePushToLocal = async () => {
    if (!previewFiles || !targetDir) return

    setIsPushing(true)
    setPushStatus(null)
    setPendingConflicts(null)

    try {
      // @ts-ignore
      const check = await window.api.checkFileConflicts(targetDir, previewFiles)
      if (check.success && check.conflicts && check.conflicts.length > 0) {
        setPendingConflicts(check.conflicts)
        setIsPushing(false)
        return
      }
      await performWrite(false)
    } catch (err: any) {
      setPushStatus(`Error: ${err.message}`)
      setIsPushing(false)
    }
  }

  const performWrite = async (overwriteConfirmed: boolean) => {
    if (!previewFiles || !targetDir) return
    setIsPushing(true)
    setPendingConflicts(null)

    try {
      // @ts-ignore
      const res = await window.api.writeFiles(targetDir, previewFiles, overwriteConfirmed)
      if (res.success) {
        const skipped = res.skippedFiles?.length
          ? ` (${res.skippedFiles.length} left untouched)`
          : ''
        setPushStatus(`Wrote ${res.writtenFiles?.length} files to disk.${skipped}`)
      } else {
        setPushStatus(`Failed to write: ${res.error}`)
      }
    } catch (err: any) {
      setPushStatus(`Error: ${err.message}`)
    } finally {
      setIsPushing(false)
    }
  }

  const refreshUsage = async () => {
    try {
      // @ts-ignore
      const res = await window.api.getUsage()
      if (res.success) setUsage(res.session)
    } catch {
      // Usage display is informational only -- never block on it.
    }
  }

  // NEW: the actual differentiator -- exports the factual Gate1/Pam
  // record for this conversation as a plain text report, with an
  // integrity hash proving it wasn't edited after generation.
  const handleExportAudit = async () => {
    if (!healContext?.conversationId) return
    try {
      // @ts-ignore
      const res = await window.api.exportAuditReport(healContext.conversationId)
      if (res.success && res.report) {
        const blob = new Blob([res.report], { type: 'text/plain' })
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = `branch-hq-audit-${healContext.conversationId.slice(0, 8)}.txt`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(objectUrl)
        setPushStatus(`Audit report exported. Integrity hash: ${res.integrityHash?.slice(0, 16)}...`)
      } else {
        setPushStatus(`Failed to export audit report: ${res.error}`)
      }
    } catch (err: any) {
      setPushStatus(`Error: ${err.message}`)
    }
  }

  return (
    <div className="flex h-screen w-screen bg-[#141414] text-neutral-200 overflow-hidden">

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* Main Chat Area -- ChatInterface owns its own conversation list now;
          this is the only sidebar in the app. Settings now lives inside
          that sidebar's own header, next to "+ new chat" -- a
          conventional spot, matching how Claude/ChatGPT/Slack place it,
          instead of floating alone in the corner of the whole window. */}
      <main className={`flex flex-col h-full transition-all duration-300 ${previewFiles ? 'w-1/2 border-r border-white/[0.06]' : 'flex-1'}`}>
        <ChatInterface onCodeGenerated={handleCodeGenerated} onClearPreview={handleClearPreview} onOpenSettings={() => setShowSettings(true)} />
      </main>

      {/* Right Split-Pane */}
      {previewFiles && (
        <section className="w-1/2 h-full flex flex-col bg-[#101010]">

          <div className="flex items-center justify-between px-4 py-3 bg-[#191919] border-b border-white/[0.06] shrink-0">
            <div className="flex items-center gap-2 text-sm text-neutral-300">
              <Code2 size={16} className={ACCENT.text} />
              <span>Staged (Gate 1 passed)</span>
            </div>

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

          {viewMode === 'code' ? (
            <div className="flex flex-col flex-1 overflow-hidden">
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

              <div className="flex-1 p-4 overflow-auto">
                {selectedFile && previewFiles[selectedFile] && (
                  <pre className="bg-[#0a0a0a] p-4 rounded-xl border border-white/[0.06] text-xs font-mono text-neutral-300">
                    <code>{previewFiles[selectedFile]}</code>
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden relative">
              <SandboxPreview
                files={previewFiles}
                conversationId={healContext?.conversationId}
                agentKey={healContext?.agentKey}
                instructions={healContext?.instructions}
                onFilesHealed={handleFilesHealed}
              />
            </div>
          )}

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
                  onClick={handleExportAudit}
                  disabled={!healContext?.conversationId}
                  className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white text-xs font-medium rounded-md disabled:opacity-50 transition-colors"
                  title="Export the Gate 1 / Pam compliance record for this conversation"
                >
                  <ShieldCheck size={14} />
                  Export Audit
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

            {/* NEW: overwrite confirmation -- only appears when real files
                would actually be replaced. */}
            {pendingConflicts && pendingConflicts.length > 0 && (
              <div className="bg-amber-950/30 border border-amber-800/40 rounded-md p-3 flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                  <div className="text-xs text-amber-200/90 leading-relaxed">
                    <span className="font-medium">{pendingConflicts.length} file{pendingConflicts.length === 1 ? '' : 's'} already exist</span> at this location and would be replaced:
                    <div className="mt-1.5 font-mono text-[11px] text-amber-200/70 max-h-20 overflow-y-auto">
                      {pendingConflicts.map(f => <div key={f}>{f}</div>)}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setPendingConflicts(null); setPushStatus('Push cancelled.') }}
                    className="px-3 py-1.5 text-xs text-neutral-300 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => performWrite(false)}
                    className="px-3 py-1.5 text-xs bg-white/10 hover:bg-white/20 text-neutral-200 rounded-md transition-colors"
                  >
                    Skip existing
                  </button>
                  <button
                    onClick={() => performWrite(true)}
                    className="px-3 py-1.5 text-xs bg-amber-700/60 hover:bg-amber-700/80 text-white rounded-md transition-colors"
                  >
                    Overwrite all
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-3 text-neutral-500">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 size={13} className="text-emerald-500/70" />
                  {Object.keys(previewFiles).length} files ready
                </span>
                {usage && usage.callCount > 0 && (
                  <span className="flex items-center gap-1.5" title="Rough estimate based on character counts, not exact token billing">
                    <Activity size={13} className="text-neutral-600" />
                    {usage.callCount} model calls this session (~{Math.round((usage.charsIn + usage.charsOut) / 1000)}k chars)
                  </span>
                )}
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