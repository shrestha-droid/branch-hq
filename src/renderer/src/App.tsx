import { useState, useEffect, useRef } from 'react'
import ChatInterface from './components/ChatInterface'
import SandboxPreview from './components/SandboxPreview'
import SettingsModal from './components/SettingsModal'
import { Code2, FileCode, X, CheckCircle2, Play, HardDriveDownload, Loader2, AlertTriangle, Activity, ShieldCheck, Maximize2, Minimize2, Download, GitBranch, BookOpen, Laptop, Wifi, Check, Trash2, UserCircle, Link, Globe, Cpu } from 'lucide-react'
import ModelSelect from './components/ModelSelect'

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
  // NEW: which conversation is currently open in ChatInterface's own
  // sidebar -- known from the moment a conversation is created or
  // selected, well before any build happens. Distinct from
  // healContext.conversationId, which only ever gets set AFTER a
  // successful generation -- this is what lets Project Knowledge (and
  // anything else that should be usable "up front," the way Claude
  // Projects' own project knowledge works) actually be usable before
  // the first message, not gated behind a build having already
  // happened.
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
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
  // NEW: client facts modal state -- verified real facts about this
  // project's actual client, so specialists stop inventing plausible-
  // sounding business specifics (a price, hours, a policy) when they
  // don't actually know them. See clientFactsStore.ts for the full
  // reasoning.
  const [clientFactsModalOpen, setClientFactsModalOpen] = useState(false)
  const [clientFactsText, setClientFactsText] = useState('')
  const [isLoadingClientFacts, setIsLoadingClientFacts] = useState(false)
  const [isSavingClientFacts, setIsSavingClientFacts] = useState(false)
  const [clientFactsSaveStatus, setClientFactsSaveStatus] = useState<string | null>(null)

  // NEW: per-chat model overrides -- the narrower layer that beats the
  // global per-agent settings (Settings modal) for one specific
  // conversation only. Same conversation-scoped pattern as Client
  // Facts, since it's the same shape of problem: something true for one
  // project, not everywhere.
  const [modelOverridesModalOpen, setModelOverridesModalOpen] = useState(false)
  const [modelOverridesValues, setModelOverridesValues] = useState<Record<string, string>>({})
  const [isLoadingModelOverrides, setIsLoadingModelOverrides] = useState(false)
  const [isSavingModelOverrides, setIsSavingModelOverrides] = useState(false)
  const [modelOverridesSaveStatus, setModelOverridesSaveStatus] = useState<string | null>(null)

  // NEW: multi-device pairing (Phase 1 -- discovery + secure pairing
  // only, no task handoff yet). See the main-process deviceIdentity.ts/
  // devicePairing.ts for the actual protocol and its security reasoning.
  const [devicesModalOpen, setDevicesModalOpen] = useState(false)
  const [myDeviceIdentity, setMyDeviceIdentity] = useState<{ deviceId: string; deviceName: string } | null>(null)
  const [deviceNameDraft, setDeviceNameDraft] = useState('')
  const [discoveredDevices, setDiscoveredDevices] = useState<Array<{ deviceId: string; deviceName: string; host: string; port: number; isTrusted: boolean }>>([])
  const [trustedDevices, setTrustedDevices] = useState<Array<{ deviceId: string; deviceName: string; pairedAt: number }>>([])
  // Incoming requests are tracked at the top level (not just while the
  // modal is open) -- a request can arrive at any time, and the human
  // on the OTHER end is actively waiting on a response, so it shouldn't
  // silently go unnoticed just because the Devices panel isn't open.
  const [incomingPairingRequests, setIncomingPairingRequests] = useState<Array<{ requestId: string; fromDeviceId: string; fromDeviceName: string; verificationCode: string }>>([])
  const [outgoingPairing, setOutgoingPairing] = useState<{
    targetDeviceId: string
    targetDeviceName: string
    verificationCode: string
    status: 'awaiting_peer' | 'awaiting_local_confirmation'
    peerRequestId?: string
  } | null>(null)
  const [devicesStatusMessage, setDevicesStatusMessage] = useState<string | null>(null)

  // NEW: "Your Profile" -- global standing context about who's actually
  // running Branch HQ, unlike Project Knowledge which is scoped per
  // conversation. No conversationId dependency at all, so unlike
  // Project Knowledge this is genuinely usable the instant the app
  // opens -- see settingsStore.ts's masterProfile field.
  const [masterProfileModalOpen, setMasterProfileModalOpen] = useState(false)
  const [masterProfileText, setMasterProfileText] = useState('')
  const [isSavingMasterProfile, setIsSavingMasterProfile] = useState(false)
  const [masterProfileSaveStatus, setMasterProfileSaveStatus] = useState<string | null>(null)
  const [isPairingInFlight, setIsPairingInFlight] = useState(false)
  // NEW: invite-based pairing state -- see devicePairing.ts for the
  // simpler flow this drives, distinct from the discovery-based one
  // above.
  const [generatedInvite, setGeneratedInvite] = useState<string | null>(null)
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false)
  const [inviteInputText, setInviteInputText] = useState('')
  const [isRedeemingInvite, setIsRedeemingInvite] = useState(false)
  // NEW: worldwide (non-LAN) pairing state -- see index.ts's
  // devices:generateWorldwideInvite/redeemWorldwideInvite for the
  // relay-mediated flow this drives.
  const [relayServerUrl, setRelayServerUrl] = useState('')
  const [isSavingRelayUrl, setIsSavingRelayUrl] = useState(false)
  const [generatedWorldwideInvite, setGeneratedWorldwideInvite] = useState<string | null>(null)
  const [isGeneratingWorldwideInvite, setIsGeneratingWorldwideInvite] = useState(false)
  const [worldwideInviteInputText, setWorldwideInviteInputText] = useState('')
  const [isRedeemingWorldwideInvite, setIsRedeemingWorldwideInvite] = useState(false)
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

  // NEW: this device's own identity, fetched once -- shown in the
  // Devices panel so the person pairing on the OTHER device can confirm
  // they're looking at the right one.
  useEffect(() => {
    // @ts-ignore
    window.api.getDeviceIdentity().then((identity: any) => {
      setMyDeviceIdentity({ deviceId: identity.deviceId, deviceName: identity.deviceName })
      setDeviceNameDraft(identity.deviceName)
    }).catch(() => {})
  }, [])

  // NEW: pairing push-events, registered once at mount -- these can
  // arrive at any time (a colleague's device sending a pairing request
  // doesn't wait for this panel to be open), not just while
  // devicesModalOpen is true.
  useEffect(() => {
    // @ts-ignore
    const unsubIncoming = window.api.onIncomingPairingRequest((data: any) => {
      setIncomingPairingRequests(prev => [...prev.filter(r => r.requestId !== data.requestId), data])
    })
    // @ts-ignore
    const unsubPeerConfirmed = window.api.onPeerConfirmedPairing((data: any) => {
      setOutgoingPairing({
        targetDeviceId: data.targetDeviceId,
        targetDeviceName: data.targetDeviceName,
        verificationCode: data.verificationCode,
        status: 'awaiting_local_confirmation',
        peerRequestId: data.peerRequestId
      })
    })
    // @ts-ignore
    const unsubCompleted = window.api.onPairingCompleted((data: any) => {
      setTrustedDevices(prev => [...prev.filter(p => p.deviceId !== data.deviceId), { deviceId: data.deviceId, deviceName: data.deviceName, pairedAt: Date.now() }])
      setDevicesStatusMessage(`Paired with ${data.deviceName}.`)
    })
    // @ts-ignore
    const unsubCancelled = window.api.onPairingCancelledByPeer((data: any) => {
      setOutgoingPairing(null)
      setDevicesStatusMessage(`${data.deviceName} cancelled the pairing.`)
    })
    // NEW: fires on the INVITE-GENERATING device once someone redeems
    // it -- purely informational, nothing to click or confirm, since
    // sharing the invite already was this device's consent.
    // @ts-ignore
    const unsubInviteCompleted = window.api.onPairingInviteCompleted((data: any) => {
      setTrustedDevices(prev => [...prev.filter(p => p.deviceId !== data.deviceId), { deviceId: data.deviceId, deviceName: data.deviceName, pairedAt: Date.now() }])
      setGeneratedInvite(null)
      setDevicesStatusMessage(`${data.deviceName} used your invite -- paired.`)
    })
    return () => {
      unsubIncoming?.()
      unsubPeerConfirmed?.()
      unsubCompleted?.()
      unsubCancelled?.()
      unsubInviteCompleted?.()
    }
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

  // NEW: the plain-language sibling to handleExportAudit -- same
  // underlying records, translated into something a non-technical
  // client can actually read. A separate button/download rather than a
  // toggle on the existing one, since a developer reaching for "Export
  // Audit" and a client-facing "here's what we checked" document are
  // genuinely different asks, not two views of the same request.
  const handleExportClientSummary = async () => {
    if (!healContext?.conversationId) return
    try {
      // @ts-ignore
      const res = await window.api.exportClientSummary(healContext.conversationId)
      if (res.success && res.summary) {
        const blob = new Blob([res.summary], { type: 'text/plain' })
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = `project-summary-${healContext.conversationId.slice(0, 8)}.txt`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(objectUrl)
        setPushStatus('Client summary exported.')
      } else {
        setPushStatus(`Failed to export client summary: ${res.error}`)
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

  const handleOpenModelOverridesModal = async () => {
    setModelOverridesModalOpen(true)
    setModelOverridesSaveStatus(null)
    if (!activeConversationId) return
    setIsLoadingModelOverrides(true)
    try {
      // @ts-ignore
      const res = await window.api.getModelOverrides(activeConversationId)
      if (res.success) setModelOverridesValues(res.overrides || {})
    } catch {
      // Best-effort load -- empty fields just mean nothing's overridden
      // for this chat yet, which is the normal, common case.
    } finally {
      setIsLoadingModelOverrides(false)
    }
  }

  const handleSaveModelOverrides = async () => {
    if (!activeConversationId) return
    setIsSavingModelOverrides(true)
    setModelOverridesSaveStatus(null)
    try {
      // @ts-ignore
      const res = await window.api.setModelOverrides(activeConversationId, modelOverridesValues)
      if (res.success) {
        setModelOverridesSaveStatus('Saved -- future messages in this chat use these, everything else keeps using your global settings.')
      } else {
        setModelOverridesSaveStatus(`Failed to save: ${res.error}`)
      }
    } catch (err: any) {
      setModelOverridesSaveStatus(`Error: ${err.message}`)
    } finally {
      setIsSavingModelOverrides(false)
    }
  }

  const handleOpenClientFactsModal = async () => {
    // NEW: now genuinely almost always populated -- activeConversationId
    // is set the instant ChatInterface has created or selected a
    // conversation, which happens automatically on mount. The empty
    // state below is still worth keeping for the brief real window
    // before that initial load resolves, not just for show.
    setClientFactsModalOpen(true)
    setClientFactsSaveStatus(null)
    if (!activeConversationId) return
    setIsLoadingClientFacts(true)
    try {
      // @ts-ignore
      const res = await window.api.getClientFacts(activeConversationId)
      if (res.success) setClientFactsText(res.facts || '')
    } catch {
      // Best-effort load -- an empty textarea just means starting fresh.
    } finally {
      setIsLoadingClientFacts(false)
    }
  }

  const handleSaveClientFacts = async () => {
    if (!activeConversationId) return
    setIsSavingClientFacts(true)
    setClientFactsSaveStatus(null)
    try {
      // @ts-ignore
      const res = await window.api.setClientFacts(activeConversationId, clientFactsText)
      if (res.success) {
        setClientFactsSaveStatus('Saved -- future generations for this project will use these facts.')
      } else {
        setClientFactsSaveStatus(`Failed to save: ${res.error}`)
      }
    } catch (err: any) {
      setClientFactsSaveStatus(`Error: ${err.message}`)
    } finally {
      setIsSavingClientFacts(false)
    }
  }

  // NEW: loaded once on mount -- global, so there's no "which
  // conversation" question the way Project Knowledge has.
  useEffect(() => {
    // @ts-ignore
    window.api.getSettings().then((s: any) => {
      setMasterProfileText(s.masterProfile || '')
      setRelayServerUrl(s.relayServerUrl || '')
    }).catch(() => {})
  }, [])

  const handleSaveMasterProfile = async () => {
    setIsSavingMasterProfile(true)
    setMasterProfileSaveStatus(null)
    try {
      // @ts-ignore
      await window.api.updateSettings({ masterProfile: masterProfileText })
      setMasterProfileSaveStatus('Saved -- every project will use this from now on.')
    } catch (err: any) {
      setMasterProfileSaveStatus(`Error: ${err.message}`)
    } finally {
      setIsSavingMasterProfile(false)
    }
  }

  const refreshDiscoveredDevices = async () => {
    try {
      // @ts-ignore
      const list = await window.api.listDiscoveredDevices()
      setDiscoveredDevices(list)
    } catch {
      // Best-effort -- the list just doesn't update this tick.
    }
  }

  const handleOpenDevicesModal = async () => {
    setDevicesModalOpen(true)
    setDevicesStatusMessage(null)
    try {
      // @ts-ignore
      const trusted = await window.api.listTrustedDevices()
      setTrustedDevices(trusted)
    } catch {
      // Best-effort.
    }
    await refreshDiscoveredDevices()
  }

  // NEW: polls the discovered-devices list while the panel is open --
  // mDNS discovery is inherently a live, changing picture (a device can
  // appear or disappear at any moment), and a static one-time fetch
  // would show a stale snapshot the whole time the panel stays open.
  useEffect(() => {
    if (!devicesModalOpen) return
    const interval = setInterval(refreshDiscoveredDevices, 4000)
    return () => clearInterval(interval)
  }, [devicesModalOpen])

  const handleSaveDeviceName = async () => {
    if (!deviceNameDraft.trim()) return
    try {
      // @ts-ignore
      const res = await window.api.setDeviceName(deviceNameDraft.trim())
      if (res.success) {
        setMyDeviceIdentity(prev => prev ? { ...prev, deviceName: res.deviceName } : prev)
        setDevicesStatusMessage('Device name updated.')
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    }
  }

  const handleSaveRelayUrl = async () => {
    setIsSavingRelayUrl(true)
    setDevicesStatusMessage(null)
    try {
      // @ts-ignore
      await window.api.updateSettings({ relayServerUrl: relayServerUrl.trim() })
      setDevicesStatusMessage(relayServerUrl.trim() ? 'Relay server saved -- worldwide pairing is now available.' : 'Relay server cleared -- worldwide pairing is unavailable until one is set again.')
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    } finally {
      setIsSavingRelayUrl(false)
    }
  }

  const handleGenerateWorldwideInvite = async () => {
    setIsGeneratingWorldwideInvite(true)
    setDevicesStatusMessage(null)
    try {
      // @ts-ignore
      const res = await window.api.generateWorldwideInvite()
      if (res.success) {
        setGeneratedWorldwideInvite(res.inviteString || null)
      } else {
        setDevicesStatusMessage(res.error || 'Could not generate a worldwide invite.')
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    } finally {
      setIsGeneratingWorldwideInvite(false)
    }
  }

  const handleCopyWorldwideInvite = () => {
    if (!generatedWorldwideInvite) return
    navigator.clipboard?.writeText(generatedWorldwideInvite)
    setDevicesStatusMessage('Copied -- send it to the other device through anywhere you already trust.')
  }

  const handleRedeemWorldwideInvite = async () => {
    if (!worldwideInviteInputText.trim()) return
    setIsRedeemingWorldwideInvite(true)
    setDevicesStatusMessage(null)
    try {
      // @ts-ignore
      const res = await window.api.redeemWorldwideInvite(worldwideInviteInputText.trim())
      if (res.success) {
        setWorldwideInviteInputText('')
        setDevicesStatusMessage(`Paired with ${res.deviceName}.`)
        // @ts-ignore
        const trusted = await window.api.listTrustedDevices()
        setTrustedDevices(trusted)
      } else {
        setDevicesStatusMessage(res.error || 'Could not pair using that invite.')
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    } finally {
      setIsRedeemingWorldwideInvite(false)
    }
  }

  const handleGenerateInvite = async () => {
    setIsGeneratingInvite(true)
    setDevicesStatusMessage(null)
    try {
      // @ts-ignore
      const res = await window.api.generateInvite()
      if (res.success) {
        setGeneratedInvite(res.inviteString || null)
      } else {
        setDevicesStatusMessage(res.error || 'Could not generate an invite.')
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    } finally {
      setIsGeneratingInvite(false)
    }
  }

  const handleCopyInvite = () => {
    if (!generatedInvite) return
    navigator.clipboard?.writeText(generatedInvite)
    setDevicesStatusMessage('Copied -- send it to the other device through anywhere you already trust (text, Slack, etc).')
  }

  const handleRedeemInvite = async () => {
    if (!inviteInputText.trim()) return
    setIsRedeemingInvite(true)
    setDevicesStatusMessage(null)
    try {
      // @ts-ignore
      const res = await window.api.pairViaInvite(inviteInputText.trim())
      if (res.success) {
        setInviteInputText('')
        setDevicesStatusMessage(`Paired with ${res.deviceName}.`)
        // @ts-ignore
        const trusted = await window.api.listTrustedDevices()
        setTrustedDevices(trusted)
      } else {
        setDevicesStatusMessage(res.error || 'Could not pair using that invite.')
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    } finally {
      setIsRedeemingInvite(false)
    }
  }

  const handlePairWithDevice = async (deviceId: string) => {
    setIsPairingInFlight(true)
    setDevicesStatusMessage(null)
    try {
      // @ts-ignore
      const res = await window.api.initiatePairing(deviceId)
      if (res.success) {
        setOutgoingPairing({
          targetDeviceId: deviceId,
          targetDeviceName: res.targetDeviceName,
          verificationCode: res.verificationCode,
          status: 'awaiting_peer'
        })
      } else {
        setDevicesStatusMessage(res.error || 'Could not start pairing.')
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    } finally {
      setIsPairingInFlight(false)
    }
  }

  const handleRespondToIncoming = async (requestId: string, accept: boolean) => {
    setIncomingPairingRequests(prev => prev.filter(r => r.requestId !== requestId))
    try {
      // @ts-ignore
      const res = await window.api.respondToIncomingPairingRequest(requestId, accept)
      if (!res.success) {
        setDevicesStatusMessage(res.error || 'Could not respond to that pairing request.')
      } else if (accept) {
        setDevicesStatusMessage('Confirmation sent -- waiting for the other device to finish pairing.')
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    }
  }

  const handleFinalizeOutgoing = async (confirmed: boolean) => {
    if (!outgoingPairing) return
    const { targetDeviceId, peerRequestId, targetDeviceName } = outgoingPairing
    setOutgoingPairing(null)
    try {
      // @ts-ignore
      const res = await window.api.finalizeOutgoingPairing(targetDeviceId, peerRequestId || '', confirmed)
      if (res.success && confirmed) {
        setTrustedDevices(prev => [...prev.filter(p => p.deviceId !== targetDeviceId), { deviceId: targetDeviceId, deviceName: targetDeviceName, pairedAt: Date.now() }])
        setDevicesStatusMessage(`Paired with ${targetDeviceName}.`)
      } else if (!confirmed) {
        setDevicesStatusMessage('Pairing cancelled.')
      } else if (res.error) {
        setDevicesStatusMessage(res.error)
      }
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
    }
  }

  const handleRemoveTrustedDevice = async (deviceId: string) => {
    try {
      // @ts-ignore
      await window.api.removeTrustedDevice(deviceId)
      setTrustedDevices(prev => prev.filter(p => p.deviceId !== deviceId))
    } catch (err: any) {
      setDevicesStatusMessage(`Error: ${err.message}`)
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
        {/* NEW: "Project Knowledge" -- always visible and genuinely
            usable from the moment a conversation exists, independent of
            whether a build has happened yet -- matching how Claude
            Projects' own "Project knowledge" or Gemini's custom
            instructions work. Sits as its own thin bar above the whole
            ChatInterface (sidebar + chat column both) rather than
            inside it, so it's reachable immediately without needing to
            modify ChatInterface.tsx's own internal layout. Renamed from
            "Client Facts" -- the person reading this button might BE
            the client in some contexts, so a name that only makes
            sense from the agency's own point of view was worth
            avoiding.
            Keyed to activeConversationId (from ChatInterface's new
            onActiveConversationChange callback), NOT healContext --
            activeConversationId is known the instant a conversation is
            created or selected, well before any build; healContext only
            updates after a successful generation. That's what actually
            makes this usable before your first message, not just
            visible before it. */}
        <div className="flex items-center justify-end gap-1 px-3 py-2 border-b border-white/[0.04] shrink-0">
          <button
            onClick={handleOpenClientFactsModal}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-neutral-500 hover:text-white hover:bg-white/[0.06] text-xs font-medium rounded-md transition-colors"
            title="Real facts about this project's business -- so builds stop guessing at prices, hours, policies"
          >
            <BookOpen size={13} />
            Project Knowledge
          </button>
          <button
            onClick={handleOpenModelOverridesModal}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-neutral-500 hover:text-white hover:bg-white/[0.06] text-xs font-medium rounded-md transition-colors"
            title="Use a different model for one or more agents in this chat only -- everything else keeps your global settings"
          >
            <Cpu size={13} />
            Model
          </button>
          <button
            onClick={() => { setMasterProfileModalOpen(true); setMasterProfileSaveStatus(null) }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-neutral-500 hover:text-white hover:bg-white/[0.06] text-xs font-medium rounded-md transition-colors"
            title="Standing info about who's running Branch HQ -- applies to every project, not just this one"
          >
            <UserCircle size={13} />
            Your Profile
          </button>
          <button
            onClick={handleOpenDevicesModal}
            className="relative flex items-center gap-1.5 px-2.5 py-1.5 text-neutral-500 hover:text-white hover:bg-white/[0.06] text-xs font-medium rounded-md transition-colors"
            title="Pair with other Branch HQ devices on this network"
          >
            <Laptop size={13} />
            Devices
            {incomingPairingRequests.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#0a84ff] animate-pulse" />
            )}
          </button>
        </div>
        <ChatInterface onCodeGenerated={handleCodeGenerated} onClearPreview={handleClearPreview} onOpenSettings={() => setShowSettings(true)} onActiveConversationChange={setActiveConversationId} />
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
                  onClick={handleExportClientSummary}
                  disabled={!healContext?.conversationId}
                  className="flex items-center gap-2 px-4 py-2 bg-white/[0.08] hover:bg-white/[0.14] text-[#f5f5f7] text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
                  title="Export a plain-language summary of what was checked -- for sharing with a non-technical client"
                >
                  <ShieldCheck size={14} />
                  Client Summary
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

      {modelOverridesModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="bg-[#2c2c2e] border border-white/[0.08] rounded-2xl w-full max-w-lg p-5 backdrop-blur-2xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Cpu size={16} className="text-white" />
                <h3 className="text-sm font-medium text-white">Model -- this chat only</h3>
              </div>
              <button onClick={() => setModelOverridesModalOpen(false)} className="text-neutral-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            {!activeConversationId ? (
              <div className="py-6 text-center">
                <p className="text-sm text-neutral-300">Loading your conversation...</p>
                <p className="text-xs text-neutral-500 mt-1.5 leading-relaxed">Use a different model for one or more agents in just this chat.</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-neutral-400 mb-3 leading-relaxed">
                  Overrides for this conversation only -- everything else keeps using your global settings. Leave any field blank to use the global setting (Settings &rarr; Per-Agent Overrides) for that agent here too.
                </p>

                <div className="flex flex-col gap-2.5">
                  {([
                    ['michael', 'Michael (routing)'],
                    ['jim', 'Jim (frontend)'],
                    ['dwight', 'Dwight (backend)'],
                    ['pam', 'Pam (QA review)'],
                    ['riley', 'Riley (documents)']
                  ] as const).map(([field, label]) => (
                    <div key={field}>
                      <span className="text-[11px] text-neutral-400 block mb-1">{label}</span>
                      <ModelSelect
                        value={modelOverridesValues[field] || ''}
                        onChange={(v) => setModelOverridesValues({ ...modelOverridesValues, [field]: v })}
                        disabled={isLoadingModelOverrides}
                        inheritLabel="Use global setting"
                      />
                    </div>
                  ))}
                </div>

                {modelOverridesSaveStatus && (
                  <p className={`text-xs mt-2 ${modelOverridesSaveStatus.startsWith('Saved') ? 'text-emerald-400' : 'text-red-400'}`}>
                    {modelOverridesSaveStatus}
                  </p>
                )}

                <div className="flex justify-end gap-2 mt-4">
                  <button
                    onClick={() => setModelOverridesModalOpen(false)}
                    className="px-3 py-1.5 text-xs text-neutral-300 hover:text-white transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={handleSaveModelOverrides}
                    disabled={isSavingModelOverrides}
                    className={`flex items-center justify-center gap-2 px-4 py-2 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors`}
                  >
                    {isSavingModelOverrides ? <Loader2 size={14} className="animate-spin" /> : null}
                    {isSavingModelOverrides ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {clientFactsModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="bg-[#2c2c2e] border border-white/[0.08] rounded-2xl w-full max-w-lg p-5 backdrop-blur-2xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <BookOpen size={16} className="text-white" />
                <h3 className="text-sm font-medium text-white">Project Knowledge</h3>
              </div>
              <button onClick={() => setClientFactsModalOpen(false)} className="text-neutral-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            {!activeConversationId ? (
              // NEW: now a real, brief loading state -- not a permanent
              // limitation. ChatInterface creates or selects a
              // conversation automatically on mount, so this only shows
              // in the short window before that initial load resolves.
              <div className="py-6 text-center">
                <p className="text-sm text-neutral-300">Loading your conversation...</p>
                <p className="text-xs text-neutral-500 mt-1.5 leading-relaxed">Add real facts about this project's business -- prices, hours, policies -- so builds use them instead of guessing.</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-neutral-400 mb-3 leading-relaxed">
                  Real, verified details about this project's business -- services, pricing, hours, policies, anything specific. Builds will use exactly what's here instead of guessing, and will use an obvious placeholder (not an invented value) for anything not covered.
                </p>

                <textarea
                  value={clientFactsText}
                  onChange={(e) => setClientFactsText(e.target.value)}
                  disabled={isLoadingClientFacts}
                  placeholder={'e.g.\nBusiness name: Riverside Dental\nHours: Mon-Fri 9am-5pm, closed weekends\nServices: cleanings ($120), whitening ($350)\nPolicy: 24-hour cancellation notice required'}
                  rows={10}
                  className="w-full bg-black/30 border border-white/[0.06] rounded-lg px-3 py-2.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-white/20 resize-none font-mono disabled:opacity-50"
                />

                {clientFactsSaveStatus && (
                  <p className={`text-xs mt-2 ${clientFactsSaveStatus.startsWith('Saved') ? 'text-emerald-400' : 'text-red-400'}`}>
                    {clientFactsSaveStatus}
                  </p>
                )}
              </>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setClientFactsModalOpen(false)}
                className="px-3 py-1.5 text-xs text-neutral-300 hover:text-white transition-colors"
              >
                Close
              </button>
              {activeConversationId && (
                <button
                  onClick={handleSaveClientFacts}
                  disabled={isSavingClientFacts || isLoadingClientFacts}
                  className={`flex items-center justify-center gap-2 px-4 py-2 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors`}
                >
                  {isSavingClientFacts ? <Loader2 size={14} className="animate-spin" /> : null}
                  {isSavingClientFacts ? 'Saving...' : 'Save'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {masterProfileModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-[#2c2c2e] border border-white/[0.08] rounded-2xl w-full max-w-lg p-5 backdrop-blur-2xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <UserCircle size={16} className="text-white" />
                <h3 className="text-sm font-medium text-white">Your Profile</h3>
              </div>
              <button onClick={() => setMasterProfileModalOpen(false)} className="text-neutral-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            <p className="text-xs text-neutral-400 mb-3 leading-relaxed">
              Who's actually running Branch HQ -- you or your agency. Applies to every project, not just the current one (unlike Project Knowledge, which is scoped to one project's client). Useful for standing conventions, tone, or defaults you always want -- if this ever conflicts with a specific project's own Client Facts, the project's facts win.
            </p>

            <textarea
              value={masterProfileText}
              onChange={(e) => setMasterProfileText(e.target.value)}
              placeholder={'e.g.\nRunning a freelance/agency web development business\nPrefer clean, minimal UI over dense/busy layouts by default\nBased in [location] -- default to that timezone/locale unless a project says otherwise'}
              rows={10}
              className="w-full bg-black/30 border border-white/[0.06] rounded-lg px-3 py-2.5 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-white/20 resize-none font-mono"
            />

            {masterProfileSaveStatus && (
              <p className={`text-xs mt-2 ${masterProfileSaveStatus.startsWith('Saved') ? 'text-emerald-400' : 'text-red-400'}`}>
                {masterProfileSaveStatus}
              </p>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setMasterProfileModalOpen(false)}
                className="px-3 py-1.5 text-xs text-neutral-300 hover:text-white transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleSaveMasterProfile}
                disabled={isSavingMasterProfile}
                className={`flex items-center justify-center gap-2 px-4 py-2 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors`}
              >
                {isSavingMasterProfile ? <Loader2 size={14} className="animate-spin" /> : null}
                {isSavingMasterProfile ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {devicesModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-[#2c2c2e] border border-white/[0.08] rounded-2xl w-full max-w-lg p-5 backdrop-blur-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Laptop size={16} className="text-white" />
                <h3 className="text-sm font-medium text-white">Devices</h3>
              </div>
              <button onClick={() => setDevicesModalOpen(false)} className="text-neutral-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            <p className="text-xs text-neutral-400 mb-4 leading-relaxed">
              Pair with other Branch HQ installations on this network. Nothing is shared until both devices confirm a matching code -- see this device's own identity below, shown so whoever's pairing with you can verify it's really you.
            </p>

            {/* This device's own identity */}
            <div className="bg-black/20 border border-white/[0.06] rounded-lg p-3 mb-4">
              <label className="text-[11px] font-medium text-neutral-500 uppercase tracking-wide block mb-1.5">This Device</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={deviceNameDraft}
                  onChange={(e) => setDeviceNameDraft(e.target.value)}
                  className="flex-1 bg-black/30 border border-white/[0.06] rounded-md px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-white/20"
                />
                <button
                  onClick={handleSaveDeviceName}
                  disabled={!deviceNameDraft.trim() || deviceNameDraft === myDeviceIdentity?.deviceName}
                  className="px-2.5 py-1.5 text-xs bg-white/10 hover:bg-white/20 disabled:opacity-30 text-neutral-200 rounded-md transition-colors"
                >
                  Save
                </button>
              </div>
              {myDeviceIdentity && (
                <p className="text-[10px] text-neutral-600 font-mono mt-1.5">ID: {myDeviceIdentity.deviceId}</p>
              )}
            </div>

            {/* Incoming pairing requests -- someone else wants to pair with THIS device */}
            {incomingPairingRequests.map(req => (
              <div key={req.requestId} className="bg-[#0a84ff]/10 border border-[#0a84ff]/30 rounded-lg p-3 mb-3">
                <p className="text-xs text-neutral-200 mb-1">
                  <span className="font-medium">{req.fromDeviceName}</span> wants to pair with this device.
                </p>
                <p className="text-xs text-neutral-400 mb-2">
                  Confirm this code matches what's shown on their screen:
                </p>
                <p className="text-lg font-mono font-bold text-white tracking-widest mb-3 text-center">{req.verificationCode}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRespondToIncoming(req.requestId, false)}
                    className="flex-1 px-3 py-1.5 text-xs bg-white/10 hover:bg-white/20 text-neutral-200 rounded-md transition-colors"
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => handleRespondToIncoming(req.requestId, true)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs ${ACCENT.bg} ${ACCENT.bgHover} text-white rounded-md transition-colors`}
                  >
                    <Check size={13} />
                    Codes Match -- Accept
                  </button>
                </div>
              </div>
            ))}

            {/* Outgoing pairing awaiting THIS device's final confirmation */}
            {outgoingPairing && (
              <div className="bg-[#0a84ff]/10 border border-[#0a84ff]/30 rounded-lg p-3 mb-3">
                {outgoingPairing.status === 'awaiting_peer' ? (
                  <>
                    <p className="text-xs text-neutral-200 mb-1">
                      Waiting for <span className="font-medium">{outgoingPairing.targetDeviceName}</span> to confirm...
                    </p>
                    <p className="text-xs text-neutral-400 mb-2">Your code (should match their screen):</p>
                    <p className="text-lg font-mono font-bold text-white tracking-widest text-center flex items-center justify-center gap-2">
                      <Loader2 size={16} className="animate-spin" />
                      {outgoingPairing.verificationCode}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-neutral-200 mb-1">
                      <span className="font-medium">{outgoingPairing.targetDeviceName}</span> confirmed. Does this code match their screen?
                    </p>
                    <p className="text-lg font-mono font-bold text-white tracking-widest mb-3 text-center">{outgoingPairing.verificationCode}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleFinalizeOutgoing(false)}
                        className="flex-1 px-3 py-1.5 text-xs bg-white/10 hover:bg-white/20 text-neutral-200 rounded-md transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleFinalizeOutgoing(true)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs ${ACCENT.bg} ${ACCENT.bgHover} text-white rounded-md transition-colors`}
                      >
                        <Check size={13} />
                        Codes Match -- Confirm Pairing
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {devicesStatusMessage && (
              <p className="text-xs text-neutral-400 mb-3">{devicesStatusMessage}</p>
            )}

            {/* NEW: invite-based pairing -- simpler than discovery,
                works even when mDNS isn't cooperating, and doesn't
                need both devices' panels open at the same time. See
                devicePairing.ts for the security reasoning. */}
            <div className="bg-black/20 border border-white/[0.06] rounded-lg p-3 mb-4">
              <label className="text-[11px] font-medium text-neutral-500 uppercase tracking-wide flex items-center gap-1.5 mb-2">
                <Link size={11} />
                Invite (easier -- no discovery needed)
              </label>

              {generatedInvite ? (
                <>
                  <p className="text-[10px] text-neutral-500 mb-1.5">Send this to the other device however you already trust (text, Slack, read aloud) -- valid 10 minutes, works once:</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-black/30 border border-white/[0.06] rounded-md px-2.5 py-1.5 text-[10px] text-neutral-300 font-mono truncate">{generatedInvite}</code>
                    <button
                      onClick={handleCopyInvite}
                      className="px-2.5 py-1.5 text-[11px] bg-white/10 hover:bg-white/20 text-neutral-200 rounded-md transition-colors shrink-0"
                    >
                      Copy
                    </button>
                  </div>
                </>
              ) : (
                <button
                  onClick={handleGenerateInvite}
                  disabled={isGeneratingInvite}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 text-neutral-200 rounded-md transition-colors"
                >
                  {isGeneratingInvite ? <Loader2 size={13} className="animate-spin" /> : <Link size={13} />}
                  Generate an invite for this device
                </button>
              )}

              <div className="flex items-center gap-2 mt-2.5">
                <input
                  type="text"
                  value={inviteInputText}
                  onChange={(e) => setInviteInputText(e.target.value)}
                  placeholder="Paste an invite from another device..."
                  className="flex-1 bg-black/30 border border-white/[0.06] rounded-md px-2.5 py-1.5 text-[11px] text-neutral-200 placeholder-neutral-600 font-mono focus:outline-none focus:border-white/20"
                />
                <button
                  onClick={handleRedeemInvite}
                  disabled={isRedeemingInvite || !inviteInputText.trim()}
                  className="px-2.5 py-1.5 text-[11px] bg-white/10 hover:bg-white/20 disabled:opacity-30 text-neutral-200 rounded-md transition-colors shrink-0"
                >
                  {isRedeemingInvite ? <Loader2 size={12} className="animate-spin" /> : 'Pair'}
                </button>
              </div>
            </div>

            {/* NEW: worldwide pairing -- entirely opt-in, gated behind
                a relay server the person explicitly configures
                themselves. See relay-server/README.md for what
                running one involves and what it can/can't see. */}
            <div className="bg-black/20 border border-white/[0.06] rounded-lg p-3 mb-4">
              <label className="text-[11px] font-medium text-neutral-500 uppercase tracking-wide flex items-center gap-1.5 mb-2">
                <Globe size={11} />
                Worldwide (opt-in -- needs a relay server)
              </label>

              <p className="text-[10px] text-neutral-500 mb-2 leading-relaxed">
                Pair with a device that isn't on this network. Needs a relay server you (or whoever you're pairing with) points both devices at -- the relay only ever sees pairing codes and signatures, never your actual project work. See relay-server/README.md.
              </p>

              <div className="flex items-center gap-2 mb-2.5">
                <input
                  type="text"
                  value={relayServerUrl}
                  onChange={(e) => setRelayServerUrl(e.target.value)}
                  placeholder="wss://your-relay.example.com"
                  className="flex-1 bg-black/30 border border-white/[0.06] rounded-md px-2.5 py-1.5 text-[11px] text-neutral-200 placeholder-neutral-600 font-mono focus:outline-none focus:border-white/20"
                />
                <button
                  onClick={handleSaveRelayUrl}
                  disabled={isSavingRelayUrl}
                  className="px-2.5 py-1.5 text-[11px] bg-white/10 hover:bg-white/20 disabled:opacity-50 text-neutral-200 rounded-md transition-colors shrink-0"
                >
                  {isSavingRelayUrl ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                </button>
              </div>

              {!relayServerUrl.trim() ? (
                <p className="text-[10px] text-neutral-600 italic">Set a relay server above to enable worldwide invites.</p>
              ) : (
                <>
                  {generatedWorldwideInvite ? (
                    <div className="flex items-center gap-2 mb-2.5">
                      <code className="flex-1 bg-black/30 border border-white/[0.06] rounded-md px-2.5 py-1.5 text-[10px] text-neutral-300 font-mono truncate">{generatedWorldwideInvite}</code>
                      <button
                        onClick={handleCopyWorldwideInvite}
                        className="px-2.5 py-1.5 text-[11px] bg-white/10 hover:bg-white/20 text-neutral-200 rounded-md transition-colors shrink-0"
                      >
                        Copy
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleGenerateWorldwideInvite}
                      disabled={isGeneratingWorldwideInvite}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 text-neutral-200 rounded-md transition-colors mb-2.5"
                    >
                      {isGeneratingWorldwideInvite ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
                      Generate a worldwide invite
                    </button>
                  )}

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={worldwideInviteInputText}
                      onChange={(e) => setWorldwideInviteInputText(e.target.value)}
                      placeholder="Paste a worldwide invite..."
                      className="flex-1 bg-black/30 border border-white/[0.06] rounded-md px-2.5 py-1.5 text-[11px] text-neutral-200 placeholder-neutral-600 font-mono focus:outline-none focus:border-white/20"
                    />
                    <button
                      onClick={handleRedeemWorldwideInvite}
                      disabled={isRedeemingWorldwideInvite || !worldwideInviteInputText.trim()}
                      className="px-2.5 py-1.5 text-[11px] bg-white/10 hover:bg-white/20 disabled:opacity-30 text-neutral-200 rounded-md transition-colors shrink-0"
                    >
                      {isRedeemingWorldwideInvite ? <Loader2 size={12} className="animate-spin" /> : 'Pair'}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Discovered, unpaired devices on the network */}
            <label className="text-[11px] font-medium text-neutral-500 uppercase tracking-wide flex items-center gap-1.5 mb-1.5">
              <Wifi size={11} />
              Nearby Devices
            </label>
            <div className="space-y-1.5 mb-4">
              {discoveredDevices.filter(d => !d.isTrusted).length === 0 ? (
                <p className="text-xs text-neutral-600 py-2">No unpaired Branch HQ devices found on this network yet.</p>
              ) : (
                discoveredDevices.filter(d => !d.isTrusted).map(device => (
                  <div key={device.deviceId} className="flex items-center justify-between bg-black/20 border border-white/[0.06] rounded-lg px-3 py-2">
                    <span className="text-xs text-neutral-300">{device.deviceName}</span>
                    <button
                      onClick={() => handlePairWithDevice(device.deviceId)}
                      disabled={isPairingInFlight || !!outgoingPairing}
                      className="px-2.5 py-1 text-[11px] bg-white/10 hover:bg-white/20 disabled:opacity-30 text-neutral-200 rounded-md transition-colors"
                    >
                      Pair
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Trusted, already-paired devices */}
            <label className="text-[11px] font-medium text-neutral-500 uppercase tracking-wide flex items-center gap-1.5 mb-1.5">
              <Check size={11} />
              Paired Devices
            </label>
            <div className="space-y-1.5">
              {trustedDevices.length === 0 ? (
                <p className="text-xs text-neutral-600 py-2">No paired devices yet.</p>
              ) : (
                trustedDevices.map(peer => (
                  <div key={peer.deviceId} className="flex items-center justify-between bg-black/20 border border-white/[0.06] rounded-lg px-3 py-2">
                    <span className="text-xs text-neutral-300">{peer.deviceName}</span>
                    <button
                      onClick={() => handleRemoveTrustedDevice(peer.deviceId)}
                      className="p-1 text-neutral-500 hover:text-red-400 transition-colors"
                      title="Remove pairing"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
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