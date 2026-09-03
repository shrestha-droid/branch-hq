import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { Send, Bot, AlertCircle, MessageSquarePlus, Trash2, Menu, X, FileCode, Search, Settings as SettingsIcon, Paperclip, Loader2 } from 'lucide-react'
import OfficeScene from './OfficeScene'

interface Message {
  id?: string
  role: 'user' | 'michael' | 'jim' | 'dwight' | 'pam' | 'riley' | 'chat' | 'error'
  content: string
  files?: Record<string, string>
}

// Shared between the static and animated renderers so they never drift
// out of sync with each other.
const markdownComponents = {
  p: ({ node, ...props }: any) => <p className="mb-4 last:mb-0" {...props} />,
  code: ({ node, inline, ...props }: any) =>
    inline
      ? <code className="bg-white/10 px-1.5 py-0.5 rounded text-[#5eb3ff] font-mono text-[13px]" {...props} />
      : <code {...props} />,
  pre: ({ node, ...props }: any) => (
    <div className="my-4 rounded-xl overflow-hidden border border-white/[0.08] bg-[#151517]">
      <pre className="p-4 overflow-x-auto text-[13px] font-mono" {...props} />
    </div>
  )
}

// NEW: reveals text progressively instead of pasting the whole response
// at once. Duration is bounded (0.3s-1.8s) regardless of message length,
// so a short reply doesn't feel instant and a long one doesn't take
// forever -- only used on messages that just arrived, never on history
// being reopened.
function TypewriterMarkdown({ text }: { text: string }) {
  const [shown, setShown] = useState('')

  useEffect(() => {
    setShown('')
    if (!text) return
    const totalDurationMs = Math.min(1800, Math.max(300, text.length * 6))
    const tickMs = 16
    const totalTicks = Math.max(1, Math.round(totalDurationMs / tickMs))
    const charsPerTick = Math.max(1, Math.ceil(text.length / totalTicks))
    let i = 0
    const interval = setInterval(() => {
      i += charsPerTick
      if (i >= text.length) {
        setShown(text)
        clearInterval(interval)
      } else {
        setShown(text.slice(0, i))
      }
    }, tickMs)
    return () => clearInterval(interval)
  }, [text])

  return <ReactMarkdown components={markdownComponents}>{shown}</ReactMarkdown>
}

interface Conversation {
  id: string
  title: string
  mode: string
  updatedAt: number
}

interface GeneratedResult {
  files: Record<string, string>
  conversationId: string
  agentKey?: 'jim' | 'dwight' | 'riley'
  instructions?: string
  // NEW: a suggested, filesystem-safe per-project folder name, derived
  // from the conversation's own title -- lets each project land in its
  // own folder automatically instead of everything colliding into the
  // same static target folder every time.
  suggestedFolderName?: string
  // NEW: the audit record's real id for this generation, so the
  // sandbox can report back "this actually ran successfully" once it
  // genuinely happens, upgrading the record from Pam's opinion to
  // confirmed execution.
  auditId?: string | null
}

function slugifyForFolder(title: string, conversationId: string): string {
  const slug = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  // A short id suffix keeps two similarly-titled conversations (two
  // different "hello"s, say) from landing in the exact same folder --
  // practical uniqueness without needing a perfect one.
  const suffix = conversationId.replace(/-/g, '').slice(0, 6)
  return (slug || 'project') + '-' + suffix
}

interface ChatInterfaceProps {
  onCodeGenerated?: (result: GeneratedResult) => void
  // NEW: called whenever the active conversation has nothing staged of
  // its own -- switching to it (or starting a new one) must not leave a
  // PREVIOUS conversation's sandbox sitting open, showing content that
  // no longer belongs to what's on screen.
  onClearPreview?: () => void
  // NEW: Settings now lives here, in the sidebar's own header, instead
  // of floating alone in the corner of the whole window.
  onOpenSettings?: () => void
  // NEW: surfaces which conversation is currently open the moment it
  // changes -- created, selected, or deleted-and-fallen-back-to. This is
  // genuinely known here well before any message is ever sent (the
  // instant a conversation exists in the sidebar), unlike App.tsx's own
  // healContext, which previously only ever learned a conversation id
  // AFTER a successful generation. Lets a parent feature (like Project
  // Knowledge) be usable from the moment a conversation is open, the
  // same way Claude Projects' own project-level context works, instead
  // of being gated behind a build having already happened.
  onActiveConversationChange?: (conversationId: string | null) => void
}

// Plain-word note: this is the only place the "brand red" lives, as one
// small set of values, so it's easy to find and change later without
// hunting through every className.
const ACCENT = {
  text: 'text-[#409cff]',
  bg: 'bg-[#0a84ff]',
  bgHover: 'hover:bg-[#3395ff]',
  bgSoft: 'bg-[#0a84ff]/10',
  border: 'border-[#0a84ff]/30',
}

// NEW: real macOS system-gray values (systemGray6/5 dark-mode
// equivalents), not arbitrary dark grays -- the same layered surface
// levels Apple's own apps use, so panels read as genuinely elevated
// rather than just a different flat shade. -apple-system renders real
// San Francisco on macOS directly from the OS's own installed font,
// with no font files embedded here at all -- falls back cleanly
// everywhere else.
const SURFACE = {
  base: '#1c1c1e',
  sidebar: 'backdrop-blur-2xl bg-[#1c1c1e]/70',
  elevated: 'bg-[#2c2c2e]',
  elevatedHover: 'hover:bg-[#323234]',
  hairline: 'border-white/[0.08]',
  textPrimary: 'text-[#f5f5f7]',
  textSecondary: 'text-[#98989d]',
  fontStack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'
}

export default function ChatInterface({ onCodeGenerated, onClearPreview, onOpenSettings, onActiveConversationChange }: ChatInterfaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  // NEW: real file upload -- scoped to genuinely text-extractable
  // documents (PDF, plain text/markdown/csv/json). Image upload would
  // need real vision-model support, a separate, larger piece of work.
  const [attachedFile, setAttachedFile] = useState<{ name: string; text: string; truncated: boolean } | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isTyping, setIsTyping] = useState(false)
  // NEW: real status per agent, driven by actual pipeline activity --
  // not randomized or purely decorative. Honest about its own
  // resolution: Michael is marked working the moment a message is sent
  // (he genuinely always processes first), and whichever specialists
  // actually appear in the response are marked working, then briefly
  // done, once it arrives. This is real participation data, not a
  // granular live step-by-step feed of every internal pipeline stage --
  // that would need the backend to stream progress events, a separate,
  // bigger piece not built here.
  const [agentStatuses, setAgentStatuses] = useState<Record<string, 'idle' | 'working' | 'done'>>({})
  // NEW: which agent (if any) is the current direct-chat target,
  // selected by clicking their character. null means normal mode --
  // Michael routes as he always has.
  const [directTarget, setDirectTarget] = useState<'jim' | 'dwight' | 'pam' | 'riley' | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // NEW: the conversation list is already long enough from testing alone
  // that scanning it by eye is a real annoyance -- this filters by title.
  const [searchQuery, setSearchQuery] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // NEW: needed to measure actual scroll position -- the old effect had
  // no way to tell "user scrolled up to read something" from "brand new
  // message just arrived," so it force-scrolled to bottom every single
  // time either changed, overriding anyone reading earlier messages.
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  // NEW: index boundary for the typewriter effect -- only messages at or
  // past this index (the ones that just arrived) animate in; reopening
  // or switching conversations never re-types old history.
  const [animateFromIndex, setAnimateFromIndex] = useState<number | null>(null)

  useEffect(() => {
    loadConversations()
  }, [])

  // NEW: fires whenever activeConvoId actually changes, regardless of
  // which code path changed it (initial load, manual selection, a new
  // conversation being created, or falling back after a delete) -- a
  // single effect here is more robust than calling the callback
  // manually at each of those separate call sites, since it can't drift
  // out of sync if another one is added later.
  useEffect(() => {
    onActiveConversationChange?.(activeConvoId)
  }, [activeConvoId])

  const loadConversations = async () => {
    try {
      // @ts-ignore
      const convos = await window.api.listConversations()
      setConversations(convos)
      if (convos.length > 0 && !activeConvoId) {
        selectConversation(convos[0].id)
      } else if (convos.length === 0) {
        createNewConversation()
      }
    } catch (err) {
      console.error('Failed to load conversations:', err)
    }
  }

  const createNewConversation = async () => {
    try {
      // One conversation type now -- Michael himself decides per message
      // whether to chat or build something, so there's no mode to choose
      // when starting a new one.
      // @ts-ignore
      const newConvo = await window.api.createConversation('pipeline')
      setConversations(prev => [newConvo, ...prev])
      setActiveConvoId(newConvo.id)
      setMessages([])
      setAnimateFromIndex(null)
      // A brand new conversation never has anything staged -- don't leave
      // whatever was open from wherever the user just was.
      onClearPreview?.()
    } catch (err) {
      console.error('Failed to create conversation:', err)
    }
  }

  const selectConversation = async (id: string) => {
    setActiveConvoId(id)
    setAnimateFromIndex(null)
    try {
      // @ts-ignore
      const data = await window.api.getConversation(id)
      if (data && data.messages) {
        setMessages(data.messages)
        const lastMsgWithFiles = [...data.messages].reverse().find(m => m.files && Object.keys(m.files).length > 0)
        if (lastMsgWithFiles?.files && onCodeGenerated) {
          onCodeGenerated({
            files: lastMsgWithFiles.files,
            conversationId: id,
            suggestedFolderName: slugifyForFolder(data.conversation?.title || '', id)
          })
        } else {
          // This conversation has nothing staged -- if a PREVIOUS
          // conversation's sandbox is still sitting open in the panel,
          // it needs to close now rather than keep showing content that
          // has nothing to do with what's on screen.
          onClearPreview?.()
        }
      } else {
        setMessages([])
        onClearPreview?.()
      }
    } catch (err) {
      console.error('Failed to fetch conversation messages:', err)
    }
  }

  const deleteConvo = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    try {
      // @ts-ignore
      await window.api.deleteConversation(id)
      const remaining = conversations.filter(c => c.id !== id)
      setConversations(remaining)
      if (activeConvoId === id) {
        if (remaining.length > 0) {
          selectConversation(remaining[0].id)
        } else {
          createNewConversation()
        }
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  }

  useEffect(() => {
    // FIXED: previously scrolled to bottom unconditionally on every
    // change, which meant scrolling up to read an earlier message got
    // silently undone the instant anything else updated. Now it only
    // follows along if the user was already near the bottom.
    const container = messagesContainerRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const wasNearBottom = distanceFromBottom < 150
    if (wasNearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isTyping])

  // NEW: reads the picked file's real bytes in the renderer (a plain
  // browser API, no Node needed for this part) and sends them to the
  // main process for actual text extraction.
  // NEW: shared between the large empty-state office and the compact
  // strip shown once a conversation is active, so both behave
  // identically. Michael isn't a direct-chat target himself -- there's
  // no real "bypass Michael's routing to talk to Michael" concept,
  // since he IS the router. Clicking him is how you explicitly return
  // to normal mode. Every other character toggles the same way as
  // before: click again to deselect.
  const handleCharacterClick = (agentId: string) => {
    if (agentId === 'michael') {
      setDirectTarget(null)
      return
    }
    setDirectTarget(prev => (prev === agentId ? null : agentId as 'jim' | 'dwight' | 'pam' | 'riley'))
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAttachError(null)
    setIsExtracting(true)
    try {
      const bytes = await file.arrayBuffer()
      // @ts-ignore
      const result = await window.api.extractFileText(file.name, bytes)
      if (result.success && result.text) {
        setAttachedFile({ name: file.name, text: result.text, truncated: !!result.truncated })
      } else {
        setAttachError(result.error || 'Could not read that file.')
      }
    } catch (err: any) {
      setAttachError(err.message || 'Could not read that file.')
    } finally {
      setIsExtracting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSend = async () => {
    if (!input.trim() || isTyping || !activeConvoId) return
    const promptText = input.trim()
    // NEW: the displayed chat bubble stays clean (just what the user
    // typed, plus a small visible marker) -- the FULL extracted document
    // text goes into a separate string used only for the actual API
    // call, so a long PDF's contents never clutter the visible
    // transcript the way the raw prompt would.
    const attachmentForApi = attachedFile
      ? `[Attached file: ${attachedFile.name}${attachedFile.truncated ? ' -- truncated' : ''}]\n${attachedFile.text}\n\n`
      : ''
    const displayText = attachedFile ? `📎 ${attachedFile.name}\n${promptText}` : promptText
    const apiPromptText = attachmentForApi + promptText
    setInput('')
    setAttachedFile(null)
    setAttachError(null)
    setIsTyping(true)
    setAgentStatuses({ [directTarget || 'michael']: 'working' })

    // NEW: captured before the optimistic append below, so this marks
    // exactly where the newly-arriving messages will start once the
    // response replaces the array -- the boundary the typewriter effect
    // uses to know what's new vs. old history.
    const startLen = messages.length
    setMessages(prev => [...prev, { role: 'user', content: displayText }])

    // Kept only so any conversation created before this change (back when
    // "Chat" was picked as a separate mode) still works correctly. Every
    // new conversation is 'pipeline' now, and goes through Michael, who
    // decides for himself whether to just talk or delegate.
    const activeConversation = conversations.find(c => c.id === activeConvoId)
    const isChatMode = activeConversation?.mode === 'chat'

    try {
      // NEW: a selected character takes priority over normal routing --
      // this is the actual point of clicking one.
      const response = directTarget
        // @ts-ignore
        ? await window.api.invokeAgent(activeConvoId, directTarget, apiPromptText)
        : isChatMode
        // @ts-ignore
        ? await window.api.invokeAgent(activeConvoId, 'chat', apiPromptText)
        // @ts-ignore
        : await window.api.invokeAI(activeConvoId, apiPromptText)

      if (response.success && response.messages) {
        setMessages(response.messages)
        setAnimateFromIndex(startLen + 1)

        // NEW: real participation, not decoration -- whichever agents
        // actually posted a message in this response are the ones shown
        // as having worked. A brief "done" pulse, then back to idle.
        const involvedAgents = new Set(
          response.messages.slice(startLen)
            .map((m: any) => m.role)
            .filter((role: string) => ['michael', 'jim', 'dwight', 'pam', 'riley'].includes(role))
        )
        setAgentStatuses(Object.fromEntries([...involvedAgents].map(id => [id, 'working'])))
        setTimeout(() => {
          setAgentStatuses(Object.fromEntries([...involvedAgents].map(id => [id, 'done'])))
        }, 1200)
        setTimeout(() => setAgentStatuses({}), 3200)

        // CRITICAL: Pass generated files up to App.tsx to trigger the sandbox split-pane
        if (response.files && Object.keys(response.files).length > 0 && onCodeGenerated) {
          const activeTitle = conversations.find(c => c.id === activeConvoId)?.title || promptText
          onCodeGenerated({
            files: response.files,
            conversationId: activeConvoId,
            agentKey: response.agentKey,
            instructions: response.instructions,
            suggestedFolderName: slugifyForFolder(activeTitle, activeConvoId),
            auditId: response.auditId
          })
        }
      } else if (response.messages) {
        setMessages(response.messages)
        setAnimateFromIndex(startLen + 1)
      }
      loadConversations()
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'error', content: `IPC Bridge Error: ${err.message}` }])
      setAgentStatuses({})
    } finally {
      setIsTyping(false)
    }
  }

  const filteredConversations = searchQuery.trim()
    ? conversations.filter(c => c.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : conversations

  return (
    <div className="flex h-full relative bg-[#1c1c1e] text-[#f5f5f7] overflow-hidden" style={{ fontFamily: SURFACE.fontStack }}>
      {/* Sidebar -- real vibrancy, translucent and blurred, the way
          Finder or Messages actually render their sidebar, not a flat
          panel with a different shade. */}
      <div className={`${sidebarOpen ? 'w-64' : 'w-0'} transition-all duration-300 ${SURFACE.sidebar} border-r ${SURFACE.hairline} flex flex-col shrink-0 overflow-hidden z-20`}>
        <div className={`p-4 border-b ${SURFACE.hairline} flex items-center justify-between`}>
          <span className={`text-sm font-medium ${SURFACE.textSecondary}`}>Chats</span>
          <div className="flex items-center gap-1.5">
            <button onClick={createNewConversation} className={`p-1.5 ${ACCENT.bgSoft} ${ACCENT.text} rounded-lg transition-colors hover:bg-[#0a84ff]/20`} title="New chat">
              <MessageSquarePlus size={16} />
            </button>
            <button onClick={() => onOpenSettings?.()} className={`p-1.5 ${SURFACE.textSecondary} hover:text-[#f5f5f7] hover:bg-white/[0.06] rounded-lg transition-colors`} title="Settings">
              <SettingsIcon size={16} />
            </button>
          </div>
        </div>
        <div className="px-3 pt-3 pb-1">
          <div className="flex items-center gap-2 bg-black/20 border border-white/[0.06] rounded-lg px-2.5 py-1.5">
            <Search size={13} className="text-neutral-500 shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats..."
              className="flex-1 bg-transparent border-none outline-none text-xs text-neutral-200 placeholder:text-neutral-600"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="text-neutral-500 hover:text-neutral-300 shrink-0">
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredConversations.length === 0 && searchQuery && (
            <p className="text-xs text-neutral-600 px-3 py-4 text-center">No chats match "{searchQuery}"</p>
          )}
          {filteredConversations.map(convo => (
            <div
              key={convo.id}
              onClick={() => selectConversation(convo.id)}
              className={`group flex items-center justify-between px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${
                activeConvoId === convo.id
                  ? `${ACCENT.bgSoft} ${ACCENT.text}`
                  : 'text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200'
              }`}
            >
              <span className="truncate flex-1 pr-2">{convo.title}</span>
              <button
                onClick={(e) => deleteConvo(e, convo.id)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-opacity"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Main Chat View */}
      <div className="flex-1 flex flex-col h-full relative overflow-hidden bg-[#1c1c1e]">
        {/* Top toggle -- small, precise, native-feeling control */}
        <div className="absolute top-4 left-4 z-30">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] rounded-lg text-[#98989d] hover:text-[#f5f5f7] transition-colors"
          >
            {sidebarOpen ? <X size={15} /> : <Menu size={15} />}
          </button>
        </div>

        {/* NEW: the office scene -- persistent, not just shown at empty
            state, since the whole point is seeing real activity while
            it's actually happening. */}
        {messages.length > 0 && (
          <div className="pt-14 pb-1 shrink-0 border-b border-white/[0.06] bg-black/20">
            <OfficeScene
              statuses={agentStatuses}
              activeDirectTarget={directTarget}
              onCharacterClick={handleCharacterClick}
            />
          </div>
        )}

        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto pb-40 pt-4 px-6 z-10 scrollbar-thin scrollbar-thumb-neutral-800 scrollbar-track-transparent">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-500">
              <OfficeScene
                statuses={agentStatuses}
                activeDirectTarget={directTarget}
                onCharacterClick={handleCharacterClick}
                scale={2}
              />
              <p className={`text-sm mt-6 ${SURFACE.textSecondary} max-w-sm text-center`}>
                Click a character to talk directly to them, or just type below and Michael will route it.
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-6">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>

                  {msg.role === 'error' && (
                    <div className="flex items-start gap-3 bg-red-950/30 border border-red-900/40 text-red-300 p-4 rounded-2xl max-w-[85%]">
                      <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" />
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{msg.content}</pre>
                    </div>
                  )}

                  {msg.role === 'user' && (
                    <div className="flex items-end gap-2 max-w-[80%]">
                      <div className={`${ACCENT.bg} text-white px-5 py-3.5 rounded-2xl rounded-br-md text-sm leading-relaxed`}>
                        {msg.content}
                      </div>
                    </div>
                  )}

                  {msg.role !== 'user' && msg.role !== 'error' && (
                    <div className="flex items-start gap-3 max-w-[90%]">
                      <div className={`w-8 h-8 rounded-full ${ACCENT.bgSoft} flex items-center justify-center shrink-0 mt-1`}>
                        <Bot size={16} className={ACCENT.text} />
                      </div>
                      <div className={`${SURFACE.elevated} border ${SURFACE.hairline} p-5 rounded-2xl rounded-tl-md w-full overflow-x-auto text-sm ${SURFACE.textPrimary} leading-relaxed`}>
                        <div className={`text-xs ${ACCENT.text} mb-2 font-medium capitalize`}>
                          {msg.role}
                        </div>
                        {msg.files && Object.keys(msg.files).length > 0 ? (
                          // NEW: a finished piece of work gets a short card
                          // pointing at the panel, instead of the whole
                          // file being pasted into the chat a second time.
                          <button
                            onClick={() => msg.files && activeConvoId && onCodeGenerated?.({
                              files: msg.files,
                              conversationId: activeConvoId,
                              agentKey: (msg.role === 'jim' || msg.role === 'dwight' || msg.role === 'riley') ? msg.role : undefined
                              // Note: re-opening an older card doesn't carry the
                              // original instructions with it (only new messages
                              // do), so self-healing isn't available on a
                              // reopened result -- only on one just generated.
                            })}
                            className="w-full flex items-center gap-3 bg-black/20 hover:bg-black/30 border border-white/[0.06] rounded-xl px-4 py-3 text-left transition-colors"
                          >
                            <FileCode size={18} className={ACCENT.text} />
                            <div className="flex-1">
                              <div className="text-sm text-neutral-200 font-medium">
                                Generated {Object.keys(msg.files).length} file{Object.keys(msg.files).length === 1 ? '' : 's'}
                              </div>
                              <div className="text-xs text-neutral-500">View in the panel &rarr;</div>
                            </div>
                          </button>
                        ) : (animateFromIndex !== null && idx >= animateFromIndex) ? (
                          <TypewriterMarkdown text={msg.content} />
                        ) : (
                          <ReactMarkdown components={markdownComponents}>
                            {msg.content}
                          </ReactMarkdown>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {isTyping && (
                <div className="flex items-center gap-3 text-neutral-500 text-sm pl-1">
                  <span className="animate-pulse">Working...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[#1c1c1e] via-[#1c1c1e]/95 to-transparent z-20">
          <div className="w-full max-w-3xl mx-auto">
            {directTarget && (
              <div className={`flex items-center gap-2 mb-2 px-3 py-2 ${ACCENT.bgSoft} border ${ACCENT.border} rounded-xl text-xs`}>
                <span className={`w-1.5 h-1.5 rounded-full ${ACCENT.bg}`} />
                <span className="text-neutral-200 flex-1">
                  Talking directly to <span className="font-medium capitalize">{directTarget}</span> -- Michael's routing is bypassed for this message.
                </span>
                <button onClick={() => setDirectTarget(null)} className="text-neutral-400 hover:text-white shrink-0">
                  <X size={13} />
                </button>
              </div>
            )}
            {(attachedFile || isExtracting || attachError) && (
              <div className={`flex items-center gap-2 mb-2 px-3 py-2 ${SURFACE.elevated} border ${SURFACE.hairline} rounded-xl text-xs`}>
                {isExtracting ? (
                  <>
                    <Loader2 size={13} className="animate-spin text-neutral-400" />
                    <span className="text-neutral-400">Reading file...</span>
                  </>
                ) : attachError ? (
                  <>
                    <AlertCircle size={13} className="text-red-400 shrink-0" />
                    <span className="text-red-400 flex-1">{attachError}</span>
                    <button onClick={() => setAttachError(null)} className="text-neutral-500 hover:text-white shrink-0">
                      <X size={13} />
                    </button>
                  </>
                ) : attachedFile ? (
                  <>
                    <Paperclip size={13} className={`${ACCENT.text} shrink-0`} />
                    <span className="text-neutral-300 flex-1 truncate">{attachedFile.name}</span>
                    {attachedFile.truncated && <span className="text-neutral-500 shrink-0">(truncated)</span>}
                    <button onClick={() => setAttachedFile(null)} className="text-neutral-500 hover:text-white shrink-0" title="Remove attachment">
                      <X size={13} />
                    </button>
                  </>
                ) : null}
              </div>
            )}
            <div className={`flex items-center gap-3 ${SURFACE.elevated} focus-within:bg-[#323234] rounded-2xl p-2 border ${SURFACE.hairline} focus-within:${ACCENT.border} transition-colors duration-200`}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt,.md,.csv,.json"
                onChange={handleFileSelected}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isTyping || isExtracting}
                title="Attach a PDF or text document"
                className="p-2.5 text-neutral-400 hover:text-white hover:bg-white/[0.06] rounded-xl disabled:opacity-30 transition-colors shrink-0"
              >
                <Paperclip size={16} />
              </button>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
                placeholder="Message Branch HQ..."
                disabled={isTyping}
                className="flex-1 bg-transparent border-none outline-none px-2 py-2 text-sm text-neutral-100 placeholder:text-neutral-500"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isTyping}
                className={`p-3 ${ACCENT.bg} ${ACCENT.bgHover} text-white rounded-xl disabled:opacity-30 transition-colors`}
              >
                <Send size={16} className={isTyping ? "opacity-50" : "ml-0.5"} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}