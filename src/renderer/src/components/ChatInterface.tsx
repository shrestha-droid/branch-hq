import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { Send, Bot, AlertCircle, MessageSquarePlus, Trash2, Menu, X, FileCode } from 'lucide-react'

interface Message {
  id?: string
  role: 'user' | 'michael' | 'jim' | 'dwight' | 'pam' | 'riley' | 'chat' | 'error'
  content: string
  files?: Record<string, string>
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
}

interface ChatInterfaceProps {
  onCodeGenerated?: (result: GeneratedResult) => void
  // NEW: called whenever the active conversation has nothing staged of
  // its own -- switching to it (or starting a new one) must not leave a
  // PREVIOUS conversation's sandbox sitting open, showing content that
  // no longer belongs to what's on screen.
  onClearPreview?: () => void
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

export default function ChatInterface({ onCodeGenerated, onClearPreview }: ChatInterfaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)

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
      // A brand new conversation never has anything staged -- don't leave
      // whatever was open from wherever the user just was.
      onClearPreview?.()
    } catch (err) {
      console.error('Failed to create conversation:', err)
    }
  }

  const selectConversation = async (id: string) => {
    setActiveConvoId(id)
    try {
      // @ts-ignore
      const data = await window.api.getConversation(id)
      if (data && data.messages) {
        setMessages(data.messages)
        const lastMsgWithFiles = [...data.messages].reverse().find(m => m.files && Object.keys(m.files).length > 0)
        if (lastMsgWithFiles?.files && onCodeGenerated) {
          onCodeGenerated({ files: lastMsgWithFiles.files, conversationId: id })
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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  const handleSend = async () => {
    if (!input.trim() || isTyping || !activeConvoId) return
    const promptText = input.trim()
    setInput('')
    setIsTyping(true)

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

        // CRITICAL: Pass generated files up to App.tsx to trigger the sandbox split-pane
        if (response.files && Object.keys(response.files).length > 0 && onCodeGenerated) {
          onCodeGenerated({
            files: response.files,
            conversationId: activeConvoId,
            agentKey: response.agentKey,
            instructions: response.instructions
          })
        }
      } else if (response.messages) {
        setMessages(response.messages)
      }
      loadConversations()
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'error', content: `IPC Bridge Error: ${err.message}` }])
    } finally {
      setIsTyping(false)
    }
  }

  return (
    <div className="flex h-full relative bg-[#141414] text-neutral-100 overflow-hidden">
      {/* Sidebar for Conversations -- calmer, no neon border glow */}
      <div className={`${sidebarOpen ? 'w-64' : 'w-0'} transition-all duration-300 bg-[#191919] border-r border-white/[0.06] flex flex-col shrink-0 overflow-hidden z-20`}>
        <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
          <span className="text-sm text-neutral-400">Chats</span>
          <button onClick={createNewConversation} className={`p-1.5 ${ACCENT.bgSoft} ${ACCENT.text} rounded-lg transition-colors hover:bg-[#a8443c]/20`} title="New chat">
            <MessageSquarePlus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {conversations.map(convo => (
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

        <div className="flex-1 overflow-y-auto pb-40 pt-16 px-6 z-10 scrollbar-thin scrollbar-thumb-neutral-800 scrollbar-track-transparent">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-500">
              <div className={`${ACCENT.bgSoft} p-4 rounded-full mb-4`}>
                <Bot size={28} className={ACCENT.text} />
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
                        ) : (
                          <ReactMarkdown
                            components={{
                              p: ({ node, ...props }) => <p className="mb-4 last:mb-0" {...props} />,
                              code: ({ node, inline, ...props }: any) =>
                                inline
                                  ? <code className="bg-white/10 px-1.5 py-0.5 rounded text-[#d9847b] font-mono text-[13px]" {...props} />
                                  : <code {...props} />,
                              pre: ({ node, ...props }) => (
                                <div className="my-4 rounded-xl overflow-hidden border border-white/[0.06] bg-[#0f0f0f]">
                                  <pre className="p-4 overflow-x-auto text-[13px] font-mono" {...props} />
                                </div>
                              )
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {isTyping && (
                <div className="flex items-center gap-3 text-neutral-500 text-sm">
                  <div className={`w-8 h-8 rounded-full ${ACCENT.bgSoft} flex items-center justify-center`}>
                    <Bot size={14} className={`${ACCENT.text} animate-pulse`} />
                  </div>
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