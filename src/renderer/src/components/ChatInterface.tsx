import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { Send, Bot, AlertCircle, MessageSquarePlus, Trash2, Menu, X, FileCode, Search, Settings as SettingsIcon } from 'lucide-react'

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
      ? <code className="bg-white/10 px-1.5 py-0.5 rounded text-[#d9847b] font-mono text-[13px]" {...props} />
      : <code {...props} />,
  pre: ({ node, ...props }: any) => (
    <div className="my-4 rounded-xl overflow-hidden border border-white/[0.06] bg-[#0f0f0f]">
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
}

// Plain-word note: this is the only place the "brand red" lives, as one
// small set of values, so it's easy to find and change later without
// hunting through every className.
const ACCENT = {
  text: 'text-[#c1554b]',
  bg: 'bg-[#a8443c]',
  bgHover: 'hover:bg-[#b84f45]',
  bgSoft: 'bg-[#a8443c]/10',
  border: 'border-[#a8443c]/30',
}

export default function ChatInterface({ onCodeGenerated, onClearPreview, onOpenSettings }: ChatInterfaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
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

  const handleSend = async () => {
    if (!input.trim() || isTyping || !activeConvoId) return
    const promptText = input.trim()
    setInput('')
    setIsTyping(true)

    // NEW: captured before the optimistic append below, so this marks
    // exactly where the newly-arriving messages will start once the
    // response replaces the array -- the boundary the typewriter effect
    // uses to know what's new vs. old history.
    const startLen = messages.length
    setMessages(prev => [...prev, { role: 'user', content: promptText }])

    // Kept only so any conversation created before this change (back when
    // "Chat" was picked as a separate mode) still works correctly. Every
    // new conversation is 'pipeline' now, and goes through Michael, who
    // decides for himself whether to just talk or delegate.
    const activeConversation = conversations.find(c => c.id === activeConvoId)
    const isChatMode = activeConversation?.mode === 'chat'

    try {
      const response = isChatMode
        // @ts-ignore
        ? await window.api.invokeAgent(activeConvoId, 'chat', promptText)
        // @ts-ignore
        : await window.api.invokeAI(activeConvoId, promptText)

      if (response.success && response.messages) {
        setMessages(response.messages)
        setAnimateFromIndex(startLen + 1)

        // CRITICAL: Pass generated files up to App.tsx to trigger the sandbox split-pane
        if (response.files && Object.keys(response.files).length > 0 && onCodeGenerated) {
          const activeTitle = conversations.find(c => c.id === activeConvoId)?.title || promptText
          onCodeGenerated({
            files: response.files,
            conversationId: activeConvoId,
            agentKey: response.agentKey,
            instructions: response.instructions,
            suggestedFolderName: slugifyForFolder(activeTitle, activeConvoId)
          })
        }
      } else if (response.messages) {
        setMessages(response.messages)
        setAnimateFromIndex(startLen + 1)
      }
      loadConversations()
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'error', content: `IPC Bridge Error: ${err.message}` }])
    } finally {
      setIsTyping(false)
    }
  }

  const filteredConversations = searchQuery.trim()
    ? conversations.filter(c => c.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : conversations

  return (
    <div className="flex h-full relative bg-[#141414] text-neutral-100 overflow-hidden">
      {/* Sidebar for Conversations -- calmer, no neon border glow */}
      <div className={`${sidebarOpen ? 'w-64' : 'w-0'} transition-all duration-300 bg-[#191919] border-r border-white/[0.06] flex flex-col shrink-0 overflow-hidden z-20`}>
        <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
          <span className="text-sm text-neutral-400">Chats</span>
          <div className="flex items-center gap-1.5">
            <button onClick={createNewConversation} className={`p-1.5 ${ACCENT.bgSoft} ${ACCENT.text} rounded-lg transition-colors hover:bg-[#a8443c]/20`} title="New chat">
              <MessageSquarePlus size={16} />
            </button>
            <button onClick={() => onOpenSettings?.()} className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.06] rounded-lg transition-colors" title="Settings">
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
              className={`group flex items-center justify-between px-3 py-2.5 rounded-xl text-sm cursor-pointer transition-colors ${
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
      <div className="flex-1 flex flex-col h-full relative overflow-hidden">
        {/* Top Header Toggle -- flat, no blur/glow */}
        <div className="absolute top-4 left-4 z-30">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-xl text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            {sidebarOpen ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>

        {/* No background grid pattern -- plain flat background, calmer */}

        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto pb-40 pt-16 px-6 z-10 scrollbar-thin scrollbar-thumb-neutral-800 scrollbar-track-transparent">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-500">
              <style>{`
                @keyframes branchGlowPulse {
                  0%, 100% { opacity: 0.35; }
                  50% { opacity: 0.6; }
                }
                @keyframes branchSpin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
              {/* NEW: an original radial burst mark -- own signature
                  element for this spot, not a copy of anything else.
                  Slow, continuous rotation plus a soft ambient glow
                  behind it. Kept to a fixed, contained size -- it should
                  never sit over or hide any part of the page. */}
              <div className="relative w-24 h-24 mb-4">
                <div
                  className={`absolute inset-0 ${ACCENT.bg} rounded-full blur-xl`}
                  style={{ animation: 'branchGlowPulse 4s ease-in-out infinite' }}
                />
                <svg
                  viewBox="0 0 100 100"
                  className="relative w-full h-full"
                  style={{ animation: 'branchSpin 14s linear infinite' }}
                >
                  {[
                    { len: 40, w: 3.2, tone: '#a8443c', op: 1 },
                    { len: 30, w: 2.6, tone: '#d9847b', op: 0.85 },
                    { len: 37, w: 3.0, tone: '#a8443c', op: 0.95 },
                    { len: 27, w: 2.4, tone: '#d9847b', op: 0.75 },
                    { len: 42, w: 3.2, tone: '#a8443c', op: 1 },
                    { len: 29, w: 2.6, tone: '#d9847b', op: 0.8 },
                    { len: 35, w: 2.8, tone: '#a8443c', op: 0.9 },
                    { len: 26, w: 2.4, tone: '#d9847b', op: 0.7 },
                    { len: 39, w: 3.0, tone: '#a8443c', op: 0.95 },
                    { len: 28, w: 2.6, tone: '#d9847b', op: 0.8 }
                  ].map((petal, i) => {
                    const tipY = 50 - petal.len
                    const halfW = petal.w
                    return (
                      <path
                        key={i}
                        d={`M 50,${50 - petal.len * 0.15} C ${50 - halfW * 1.6},${50 - petal.len * 0.55} ${50 - halfW},${tipY + 6} 50,${tipY} C 50,${tipY} ${50 + halfW},${tipY + 6} ${50 + halfW * 1.6},${50 - petal.len * 0.55} C ${50 + halfW * 0.6},${50 - petal.len * 0.3} 50,${50 - petal.len * 0.15} 50,${50 - petal.len * 0.15} Z`}
                        fill={petal.tone}
                        opacity={petal.op}
                        transform={`rotate(${i * 36} 50 50)`}
                      />
                    )
                  })}
                </svg>
              </div>
              <p className="text-lg font-medium text-neutral-200">Branch HQ</p>
              <p className="text-sm mt-2 text-neutral-500 max-w-sm text-center">
                Ask anything -- chat, code, research, or a document. Just start typing.
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
                      <div className="bg-[#1c1c1c] border border-white/[0.06] p-5 rounded-2xl rounded-tl-md w-full overflow-x-auto text-sm text-neutral-300 leading-relaxed">
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
        <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[#141414] via-[#141414]/95 to-transparent z-20">
          <div className={`w-full max-w-3xl mx-auto flex items-center gap-3 bg-white/[0.04] focus-within:bg-white/[0.06] rounded-2xl p-2 border border-white/[0.06] focus-within:${ACCENT.border} transition-colors duration-200`}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
              placeholder="Message Branch HQ..."
              disabled={isTyping}
              className="flex-1 bg-transparent border-none outline-none px-4 py-2 text-sm text-neutral-100 placeholder:text-neutral-500"
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
  )
}