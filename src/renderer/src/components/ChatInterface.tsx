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
  suggestedFolderName?: string
  auditId?: string | null
}

function slugifyForFolder(title: string, conversationId: string): string {
  const slug = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  const suffix = conversationId.replace(/-/g, '').slice(0, 6)
  return (slug || 'project') + '-' + suffix
}

interface ChatInterfaceProps {
  onCodeGenerated?: (result: GeneratedResult) => void
  onClearPreview?: () => void
  onOpenSettings?: () => void
  onActiveConversationChange?: (conversationId: string | null) => void
}

const ACCENT = {
  text: 'text-[#409cff]',
  bg: 'bg-[#0a84ff]',
  bgHover: 'hover:bg-[#3395ff]',
  bgSoft: 'bg-[#0a84ff]/10',
  border: 'border-[#0a84ff]/30',
}

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
  // NEW: needed so the live message listener below (set up once, in a
  // mount-level effect) always checks against the CURRENT active
  // conversation, not whatever it was when the listener was first
  // created -- the same closure-staleness reasoning as runIdRef
  // elsewhere in this codebase.
  const activeConvoIdRef = useRef<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [attachedFile, setAttachedFile] = useState<{ name: string; text: string; truncated: boolean } | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isTyping, setIsTyping] = useState(false)
  const [agentStatuses, setAgentStatuses] = useState<Record<string, 'idle' | 'working' | 'done'>>({})
  const [directTarget, setDirectTarget] = useState<'jim' | 'dwight' | 'pam' | 'riley' | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [animateFromIndex, setAnimateFromIndex] = useState<number | null>(null)

  useEffect(() => {
    loadConversations()
  }, [])

  useEffect(() => {
    onActiveConversationChange?.(activeConvoId)
    activeConvoIdRef.current = activeConvoId
  }, [activeConvoId])

  // NEW: confirmed real, long-standing UX gap -- the chat previously
  // showed nothing at all while a multi-agent build ran, however long
  // that legitimately took, indistinguishable from a hang the whole
  // time. Each message now arrives here the instant it's actually
  // created on the main-process side (see addMessageAndBroadcast in
  // index.ts), not just once at the very end. The user's own message
  // is skipped here specifically -- it's already shown optimistically
  // the moment they hit send, in handleSend below, so appending it
  // again here would show it twice.
  useEffect(() => {
    // @ts-ignore
    const unsub = window.api.onChatMessageAdded((data: any) => {
      if (data.conversationId !== activeConvoIdRef.current) return
      if (data.message?.role === 'user') return
      setMessages(prev => [...prev, data.message])
      if (data.message?.role && ['michael', 'jim', 'dwight', 'pam', 'riley'].includes(data.message.role)) {
        setAgentStatuses(prev => ({ ...prev, [data.message.role]: 'working' }))
        setTimeout(() => {
          setAgentStatuses(prev => ({ ...prev, [data.message.role]: 'done' }))
        }, 1200)
      }
    })
    return () => unsub?.()
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
      // @ts-ignore
      const newConvo = await window.api.createConversation('pipeline')
      setConversations(prev => [newConvo, ...prev])
      setActiveConvoId(newConvo.id)
      setMessages([])
      setAnimateFromIndex(null)
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
        // FIXED: confirmed real bug -- this used to scan data.messages
        // in reverse for the last one with a `files` field and treat
        // THAT as the finished result. That's an individual agent's own
        // message, not necessarily the true final merged/staged output
        // -- and confirmed real failure: if this conversation's build
        // was a multi-agent one and got reselected while a LATER agent
        // was still mid-retry, the FIRST agent's already-saved message
        // would be found instead, silently loading an incomplete,
        // in-progress snapshot as if it were done. Reading from
        // stagedFilesStore.ts instead -- written once, only when a
        // pipeline genuinely completes -- gives a real answer instead
        // of a guess.
        // @ts-ignore
        const staged = await window.api.getStagedFiles(id)
        if (staged.success && staged.files && Object.keys(staged.files).length > 0 && onCodeGenerated) {
          // FIXED: confirmed real regression -- this previously only
          // passed files + conversationId, never agentKey/instructions/
          // auditId. handleSend's own onCodeGenerated call (right when a
          // generation finishes) DOES carry all of that -- but if
          // selectConversation ever ran again afterward for any reason
          // (even just clicking the same already-active conversation in
          // the sidebar), it would silently overwrite that correct,
          // complete context with this incomplete one, breaking
          // self-heal for a run that had genuinely just succeeded.
          // stagedFilesStore now persists the same context handleSend
          // already has, so both paths hand onCodeGenerated the same
          // complete shape.
          onCodeGenerated({
            files: staged.files,
            conversationId: id,
            agentKey: staged.agentKey,
            instructions: staged.instructions,
            auditId: staged.auditId,
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
    const container = messagesContainerRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const wasNearBottom = distanceFromBottom < 150
    if (wasNearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isTyping])

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

    const startLen = messages.length
    setMessages(prev => [...prev, { role: 'user', content: displayText }])
    setAnimateFromIndex(startLen + 1)

    const activeConversation = conversations.find(c => c.id === activeConvoId)
    const isChatMode = activeConversation?.mode === 'chat'

    try {
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

      <div className="flex-1 flex flex-col h-full relative overflow-hidden bg-[#1c1c1e]">
        <div className="absolute top-4 left-4 z-30">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] rounded-lg text-[#98989d] hover:text-[#f5f5f7] transition-colors"
          >
            {sidebarOpen ? <X size={15} /> : <Menu size={15} />}
          </button>
        </div>

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
                          <button
                            onClick={() => msg.files && activeConvoId && onCodeGenerated?.({
                              files: msg.files,
                              conversationId: activeConvoId,
                              agentKey: (msg.role === 'jim' || msg.role === 'dwight' || msg.role === 'riley') ? msg.role : undefined
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