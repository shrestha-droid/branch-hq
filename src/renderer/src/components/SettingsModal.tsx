import { useState, useEffect } from 'react'
import { X, Save } from 'lucide-react'

interface Settings {
  modelProvider: 'gemini' | 'local'
  geminiModel: string
  fallbackGeminiModel: string
  localModelBaseUrl: string
  localModelName: string
  localEmbeddingModelName: string
  defaultTargetDir: string
  strictVerification: boolean
}

const ACCENT = {
  bg: 'bg-[#a8443c]',
  bgHover: 'hover:bg-[#b84f45]',
  border: 'border-[#a8443c]/30',
}

interface SettingsModalProps {
  onClose: () => void
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  // NEW: kept deliberately separate from the regular settings object --
  // this goes through the secure credentials store, not the plain
  // settings JSON. hasGithubToken never returns the actual token, only
  // whether one is set.
  const [hasGithubToken, setHasGithubToken] = useState(false)
  const [githubTokenInput, setGithubTokenInput] = useState('')
  const [githubStatus, setGithubStatus] = useState<string | null>(null)

  useEffect(() => {
    // @ts-ignore
    window.api.getSettings().then(setSettings).catch(() => {})
    // @ts-ignore
    window.api.hasGithubToken().then((r: any) => setHasGithubToken(r.hasToken)).catch(() => {})
  }, [])

  const handleConnectGithub = async () => {
    if (!githubTokenInput.trim()) return
    setGithubStatus(null)
    try {
      // @ts-ignore
      const res = await window.api.setGithubToken(githubTokenInput.trim())
      if (res.success) {
        setHasGithubToken(true)
        setGithubTokenInput('')
        setGithubStatus('Connected.')
      } else {
        setGithubStatus(res.error || 'Could not save the token.')
      }
    } catch (err: any) {
      setGithubStatus(err.message)
    }
  }

  const handleDisconnectGithub = async () => {
    // @ts-ignore
    await window.api.clearGithubToken()
    setHasGithubToken(false)
    setGithubStatus('Disconnected.')
  }

  const handleSave = async () => {
    if (!settings) return
    setIsSaving(true)
    setSaveStatus(null)
    try {
      // @ts-ignore
      await window.api.updateSettings(settings)
      setSaveStatus('Saved -- takes effect on your next message, no restart needed.')
    } catch (err: any) {
      setSaveStatus(`Failed to save: ${err.message}`)
    } finally {
      setIsSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="bg-[#191919] rounded-2xl p-6 text-neutral-400 text-sm">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[#191919] border border-white/[0.08] rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-medium text-neutral-200">Settings</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-2">Model Provider</label>
            <div className="flex gap-2">
              <button
                onClick={() => setSettings({ ...settings, modelProvider: 'gemini' })}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${settings.modelProvider === 'gemini' ? `${ACCENT.bg} text-white` : 'bg-black/30 text-neutral-400'}`}
              >
                Gemini (cloud)
              </button>
              <button
                onClick={() => setSettings({ ...settings, modelProvider: 'local' })}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${settings.modelProvider === 'local' ? `${ACCENT.bg} text-white` : 'bg-black/30 text-neutral-400'}`}
              >
                Local / Private
              </button>
            </div>
            <p className="text-[11px] text-neutral-500 mt-1.5 leading-relaxed">
              {settings.modelProvider === 'local'
                ? "Nothing leaves this machine -- routes to whatever is running at the base URL below (Ollama, vLLM, a private Azure OpenAI tenant)."
                : "Uses Google's Gemini API. Simple and cheap, but project content is sent to Google -- not suitable if that's a dealbreaker for your use case."}
            </p>
          </div>

          {settings.modelProvider === 'gemini' ? (
            <>
              <div>
                <label className="text-xs font-medium text-neutral-400 block mb-1.5">Gemini Model</label>
                <input
                  type="text"
                  value={settings.geminiModel}
                  onChange={(e) => setSettings({ ...settings, geminiModel: e.target.value })}
                  className={`w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:${ACCENT.border} outline-none transition-colors`}
                />
                <p className="text-[11px] text-neutral-500 mt-1.5">
                  Pick based on what you're about to build -- a faster/cheaper model for simple changes, a stronger one for a complex or high-stakes build.
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-400 block mb-1.5">Fallback Model (optional)</label>
                <input
                  type="text"
                  value={settings.fallbackGeminiModel}
                  onChange={(e) => setSettings({ ...settings, fallbackGeminiModel: e.target.value })}
                  placeholder="e.g. a different Gemini model"
                  className={`w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:${ACCENT.border} outline-none transition-colors`}
                />
                <p className="text-[11px] text-neutral-500 mt-1.5">
                  If the model above is genuinely down (not just a bad response -- a real outage), this one is tried automatically before giving up. Leave blank to disable.
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium text-neutral-400 block mb-1.5">Local Base URL</label>
                <input
                  type="text"
                  value={settings.localModelBaseUrl}
                  onChange={(e) => setSettings({ ...settings, localModelBaseUrl: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                  className={`w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:${ACCENT.border} outline-none transition-colors`}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-400 block mb-1.5">Local Model Name</label>
                <input
                  type="text"
                  value={settings.localModelName}
                  onChange={(e) => setSettings({ ...settings, localModelName: e.target.value })}
                  placeholder="llama3.1"
                  className={`w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:${ACCENT.border} outline-none transition-colors`}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-400 block mb-1.5">Local Embedding Model</label>
                <input
                  type="text"
                  value={settings.localEmbeddingModelName}
                  onChange={(e) => setSettings({ ...settings, localEmbeddingModelName: e.target.value })}
                  placeholder="nomic-embed-text"
                  className={`w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:${ACCENT.border} outline-none transition-colors`}
                />
              </div>
            </>
          )}

          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1.5">Default Target Folder</label>
            <input
              type="text"
              value={settings.defaultTargetDir}
              onChange={(e) => setSettings({ ...settings, defaultTargetDir: e.target.value })}
              placeholder="/Users/you/Projects/my-app"
              className={`w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:${ACCENT.border} outline-none transition-colors`}
            />
            <p className="text-[11px] text-neutral-500 mt-1.5">Pre-fills the target folder box on startup -- still yours to change per push.</p>
          </div>

          <div className="pt-1 border-t border-white/[0.06]">
            <div className="flex items-center justify-between pt-4">
              <div className="pr-4">
                <label className="text-xs font-medium text-neutral-300 block">Strict Verification</label>
                <p className="text-[11px] text-neutral-500 mt-1 leading-relaxed">
                  Nothing counts as finished until the sandbox actually confirms it runs -- Pam's review alone won't be enough. Real cost: every generation waits on a full sandbox run before it's shown as done, even a one-line change. Off by default for everyday speed; worth turning on for anything headed into a real audit report.
                </p>
              </div>
              <button
                onClick={() => setSettings({ ...settings, strictVerification: !settings.strictVerification })}
                className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${settings.strictVerification ? ACCENT.bg : 'bg-white/10'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${settings.strictVerification ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
            </div>
          </div>

          <div className="pt-4 border-t border-white/[0.06]">
            <label className="text-xs font-medium text-neutral-300 block mb-1.5">GitHub</label>
            <p className="text-[11px] text-neutral-500 mb-2.5 leading-relaxed">
              Stored securely through your OS's own keychain, not in a plain settings file -- and never sent back to this app once saved, only whether one is set. Generate a token at github.com &rarr; Settings &rarr; Developer settings &rarr; Personal access tokens (the "repo" scope is enough).
            </p>
            {hasGithubToken ? (
              <div className="flex items-center justify-between bg-black/30 rounded-lg px-3 py-2.5 border border-white/[0.06]">
                <span className="text-xs text-emerald-400 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Connected
                </span>
                <button onClick={handleDisconnectGithub} className="text-xs text-neutral-400 hover:text-white">
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={githubTokenInput}
                  onChange={(e) => setGithubTokenInput(e.target.value)}
                  placeholder="ghp_..."
                  className="flex-1 bg-black/30 border border-white/[0.06] rounded-lg px-3 py-2 text-xs text-white placeholder:text-neutral-600 focus:outline-none focus:border-white/20"
                />
                <button
                  onClick={handleConnectGithub}
                  disabled={!githubTokenInput.trim()}
                  className={`px-4 py-2 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-xs font-medium rounded-lg disabled:opacity-40 transition-colors`}
                >
                  Connect
                </button>
              </div>
            )}
            {githubStatus && <p className="text-[11px] text-neutral-400 mt-1.5">{githubStatus}</p>}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-white/[0.06]">
          <span className="text-xs text-neutral-500">{saveStatus}</span>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`flex items-center gap-2 px-4 py-2 ${ACCENT.bg} ${ACCENT.bgHover} text-white text-xs font-medium rounded-md disabled:opacity-50 transition-colors`}
          >
            <Save size={14} />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}