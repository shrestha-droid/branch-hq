import { useState, useEffect, useRef } from 'react'
import ChatInterface from './components/ChatInterface'
import SandboxPreview from './components/SandboxPreview'
import SettingsModal from './components/SettingsModal'
import { Code2, FileCode, X, CheckCircle2, Play, HardDriveDownload, Loader2, AlertTriangle, Activity, ShieldCheck, Maximize2, Minimize2, Download, GitBranch } from 'lucide-react'

const ACCENT = {
  text: 'text-[#409cff]',
  bg: 'bg-[#0a84ff]',
  bgHover: 'hover:bg-[#3395ff]',
  bgSoft: 'bg-[#0a84ff]/10',
  border: 'border-[#0a84ff]/30',
}

export default function App() {
  // NEW: no more agent picker. Michael himself decides, per message,
  // whether to just talk or bring in a specialist -- so there's nothing
  // left to pick a mode for. ChatInterface's own conversation list is now
  // the only sidebar.
  const [previewFiles, setPreviewFiles] = useState<Record<string, string> | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('preview')
  // NEW: expands the preview to fill nearly the whole window instead of
  // sharing the split with chat -- a real, guaranteed-to-work way to see
  // it bigger, since a genuinely external browser window can't be
  // promised to render a WebContainer preview correctly every time.
  const [isPreviewMaximized, setIsPreviewMaximized] = useState(false)

  // NEW: context self-healing needs -- which conversation, which
  // specialist, and the original instructions -- so the sandbox can ask
  // for a real fix if the code fails when actually run, not just note
  // that it failed.
  const [healContext, setHealContext] = useState<{
    conversationId: string
    agentKey?: 'jim' | 'dwight' | 'riley'
    instructions?: string
    auditId?: string | null
  } | null>(null)
  // NEW: whether "nothing counts as done until the sandbox actually
  // confirms it runs" is on. Off by default -- see settingsStore.ts for
  // the real tradeoff this makes.
  const [strictVerification, setStrictVerification] = useState(false)
  // NEW: visible only when strict mode is on and a generation ultimately
  // could not be confirmed as actually running, even after self-healing
  // exhausted its attempts -- surfaces that honestly instead of leaving
  // it buried in the sandbox's own log panel.
  const [verificationFailedNotice, setVerificationFailedNotice] = useState<string | null>(null)

  // FIXED: was a hardcoded absolute path containing one specific
  // user's home directory -- meaning Push to Local, Scan Workspace, and
  // the existing-project check all silently pointed at a folder that
  // does not exist on any other machine. Starts empty now and is filled
  // from settings, which resolves a real per-user path on startup.
  const [targetDir, setTargetDir] = useState('')
  const [isPushing, setIsPushing] = useState(false)
  // NEW: GitHub push modal state -- kept separate from the plain
  // Push to Local state since this is a real external action with its
  // own confirmation step (repo name, public/private), not a one-click.
  const [githubModalOpen, setGithubModalOpen] = useState(false)
  const [githubRepoName, setGithubRepoName] = useState('')
  const [githubIsPrivate, setGithubIsPrivate] = useState(true)
  const [isPushingGithub, setIsPushingGithub] = useState(false)
  const [githubPushStatus, setGithubPushStatus] = useState<string | null>(null)
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
  // NEW: the configured BASE folder, kept separate from targetDir (which
  // the user can freely edit per push) -- each new project's suggested
  // folder is computed as a subfolder of this base.
  const [baseTargetDir, setBaseTargetDir] = useState('')
  // NEW: which conversation we last auto-suggested a folder for -- only
  // suggest once per conversation becoming newly active, so a second
  // generation in the same chat doesn't stomp on a manual edit.
  const lastAutoNamedConvoIdRef = useRef<string | null>(null)

  useEffect(() => {
    // @ts-ignore
    window.api.getSettings().then((s: any) => {
      if (s.defaultTargetDir) {
        setTargetDir(s.defaultTargetDir)
        setBaseTargetDir(s.defaultTargetDir)
      }
      setStrictVerification(!!s.strictVerification)
    }).catch(() => {})
  }, [])

  const handleCodeGenerated = (result: { files: Record<string, string>; conversationId: string; agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string; suggestedFolderName?: string; auditId?: string | null }) => {
    if (result.files && Object.keys(result.files).length > 0) {
      setPreviewFiles(result.files)
      setHealContext({ conversationId: result.conversationId, agentKey: result.agentKey, instructions: result.instructions, auditId: result.auditId })
      const primary = Object.keys(result.files).find(f => f.includes('App.tsx')) || Object.keys(result.files)[0]
      if (primary) setSelectedFile(primary)
      setViewMode('preview')
      setPushStatus(null)
      setVerificationFailedNotice(null)
      refreshUsage()

      // NEW: give each new project its own folder automatically, rather
      // than every push landing in the same static target and colliding.
      // Only applied the first time THIS conversation is seen -- a
      // second build in an already-open chat won't override a folder
      // the user already edited by hand.
      if (result.suggestedFolderName && lastAutoNamedConvoIdRef.current !== result.conversationId) {
        lastAutoNamedConvoIdRef.current = result.conversationId
        const base = baseTargetDir.replace(/\/+$/, '')
        setTargetDir(`${base}/${result.suggestedFolderName}`)
      }
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
    setVerificationFailedNotice(null)
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

  // NEW: a real ZIP of the currently staged files, for anyone who wants
  // to take the code elsewhere and deploy it themselves rather than
  // using Push to Local. Suggests a filename derived from the target
  // folder's own name, so it isn't just "branch-hq-project" every time.
  const handleDownloadZip = async () => {
    if (!previewFiles) return
    try {
      const folderName = targetDir.split('/').filter(Boolean).pop() || 'branch-hq-project'
      // @ts-ignore
      const res = await window.api.downloadZip(previewFiles, folderName)
      if (res.success) {
        setPushStatus(`Downloaded ZIP to ${res.savedTo}`)
      } else if (!res.canceled) {
        setPushStatus(`Failed to download ZIP: ${res.error}`)
      }
    } catch (err: any) {
      setPushStatus(`Error: ${err.message}`)
    }
  }

  const handleOpenGithubModal = () => {
    if (!previewFiles) return
    const suggested = targetDir.split('/').filter(Boolean).pop() || 'branch-hq-project'
    setGithubRepoName(suggested)
    setGithubPushStatus(null)
    setGithubModalOpen(true)
  }

  const handleGithubPush = async () => {
    if (!previewFiles || !githubRepoName.trim()) return
    setIsPushingGithub(true)
    setGithubPushStatus(null)
    try {
      // @ts-ignore
      const res = await window.api.pushToGithub(previewFiles, githubRepoName.trim(), githubIsPrivate)
      if (res.success) {
        setGithubPushStatus(`Pushed successfully: ${res.repoUrl}`)
      } else {
        setGithubPushStatus(res.error || 'Push failed.')
      }
    } catch (err: any) {
      setGithubPushStatus(err.message)
    } finally {
      setIsPushingGithub(false)
    }
  }

  return (
    <div className="flex h-screen w-screen bg-[#1c1c1e] text-[#f5f5f7] overflow-hidden" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif' }}>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* Main Chat Area -- ChatInterface owns its own conversation list now;
          this is the only sidebar in the app. Settings now lives inside
          that sidebar's own header, next to "+ new chat" -- a
          conventional spot, matching how Claude/ChatGPT/Slack place it,
          instead of floating alone in the corner of the whole window. */}
      <main className={`flex flex-col h-full transition-all duration-300 ${previewFiles ? (isPreviewMaximized ? 'w-0 overflow-hidden' : 'w-1/2 border-r border-white/[0.06]') : 'flex-1'}`}>
        <ChatInterface onCodeGenerated={handleCodeGenerated} onClearPreview={handleClearPreview} onOpenSettings={() => setShowSettings(true)} />
      </main>

      {/* Right Split-Pane */}
      {previewFiles && (
        <section className={`h-full flex flex-col bg-[#101010] transition-all duration-300 ${isPreviewMaximized ? 'w-full' : 'w-1/2'}`}>

          <div className="flex items-center justify-between px-4 py-3 bg-[#1c1c1e]/80 backdrop-blur-xl border-b border-white/[0.08] shrink-0">
            <div className="flex items-center gap-2 text-sm text-neutral-300">
              <Code2 size={16} className={ACCENT.text} />
              <span>Staged (Gate 1 passed)</span>
            </div>

            <div className="flex items-center gap-2">
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

              <button
                onClick={() => setIsPreviewMaximized(!isPreviewMaximized)}
                className="p-1.5 text-neutral-500 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors"
                title={isPreviewMaximized ? 'Restore split view' : 'Maximize -- easier to actually look at'}
              >
                {isPreviewMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </div>

            <button onClick={() => { setPreviewFiles(null); setSelectedFile(null); setIsPreviewMaximized(false); }} className="text-neutral-500 hover:text-white" title="Close">
              <X size={16} />
            </button>
          </div>

          {viewMode === 'code' ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="flex gap-1.5 px-3 py-2 bg-black/20 border-b border-white/[0.06] overflow-x-auto shrink-0">
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
            <div className="flex-1 overflow-hidden relative flex flex-col">
              {verificationFailedNotice && (
                <div className="px-4 py-2.5 bg-red-950/40 border-b border-red-900/50 text-xs text-red-300 flex items-start gap-2 shrink-0">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span>{verificationFailedNotice}</span>
                </div>
              )}
              <div className="flex-1 overflow-hidden relative">
                <SandboxPreview
                  files={previewFiles}
                  conversationId={healContext?.conversationId}
                  agentKey={healContext?.agentKey}
                  instructions={healContext?.instructions}
                  auditId={healContext?.auditId}
                  onFilesHealed={handleFilesHealed}
                  onVerificationOutcome={(success, message) => {
                    if (success) {
                      setVerificationFailedNotice(null)
                    } else if (strictVerification && message) {
                      setVerificationFailedNotice(message)
                    }
                  }}
                />
              </div>
            </div>
          )}

          <div className="p-4 bg-[#1c1c1e]/80 backdrop-blur-xl border-t border-white/[0.08] flex flex-col gap-3 shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 flex flex-col gap-1.5">
                <label className="text-xs font-medium text-neutral-500">
                  Target folder <span className="font-normal text-neutral-600">(auto-named per project -- edit freely)</span>
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
                  className="flex items-center gap-2 px-4 py-2 bg-white/[0.08] hover:bg-white/[0.14] text-[#f5f5f7] text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
                  title="Scan this folder into AI memory"
                >
                  {isIndexing ? <Loader2 size={14} className="animate-spin" /> : <Code2 size={14} />}
                  Scan Workspace
                </button>
                <button
                  onClick={handleExportAudit}
                  disabled={!healContext?.conversationId}
                  className="flex items-center gap-2 px-4 py-2 bg-white/[0.08] hover:bg-white/[0.14] text-[#f5f5f7] text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
                  title="Export the Gate 1 / Pam compliance record for this conversation"
                >
                  <ShieldCheck size={14} />
                  Export Audit
                </button>
                <button
                  onClick={handleDownloadZip}
                  disabled={!previewFiles}
                  className="flex items-center gap-2 px-4 py-2 bg-white/[0.08] hover:bg-white/[0.14] text-[#f5f5f7] text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
                  title="Download everything as a single .zip -- for taking the code elsewhere and deploying it yourself"
                >
                  <Download size={14} />
                  Download ZIP
                </button>
                <button
                  onClick={handleOpenGithubModal}
                  disabled={!previewFiles}
                  className="flex items-center gap-2 px-4 py-2 bg-white/[0.08] hover:bg-white/[0.14] text-[#f5f5f7] text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
                  title="Push to a new GitHub repo"
                >
                  <GitBranch size={14} />
                  Push to GitHub
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

      {githubModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="bg-[#2c2c2e] border border-white/[0.08] rounded-2xl w-full max-w-md p-5 backdrop-blur-2xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <GitBranch size={16} className="text-white" />
                <h3 className="text-sm font-medium text-white">Push to GitHub</h3>
              </div>
              <button onClick={() => setGithubModalOpen(false)} className="text-neutral-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            <label className="text-xs font-medium text-neutral-400 block mb-1.5">Repository name</label>
            <input
              type="text"
              value={githubRepoName}
              onChange={(e) => setGithubRepoName(e.target.value)}
              className="w-full bg-black/30 border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-white mb-3 focus:outline-none focus:border-white/20"
            />

            <div className="flex items-center justify-between mb-4">
              <span className="text-xs text-neutral-400">Private repository</span>
              <button
                onClick={() => setGithubIsPrivate(!githubIsPrivate)}
                className={`relative w-10 h-6 rounded-full transition-colors ${githubIsPrivate ? ACCENT.bg : 'bg-white/10'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${githubIsPrivate ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>

            {githubPushStatus && (
              <p className={`text-xs mb-3 ${githubPushStatus.startsWith('Pushed') ? 'text-emerald-400' : 'text-red-400'}`}>
                {githubPushStatus}
              </p>
            )}

            <button
              onClick={handleGithubPush}
              disabled={isPushingGithub || !githubRepoName.trim()}
              className={`w-full flex items-center justify-center gap-2 py-2.5 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors`}
            >
              {isPushingGithub ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
              {isPushingGithub ? 'Pushing...' : 'Create Repo & Push'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}