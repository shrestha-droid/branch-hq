import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'

// Simple JSON-backed store. This is intentionally dependency-free rather
// than reaching for SQLite -- if Phase 3's vector store already runs on
// SQLite, this can be migrated into two tables in that same DB file later.
// For a single-user desktop app, a write-through JSON cache is enough.

export type ConversationMode = 'pipeline' | 'jim' | 'dwight' | 'pam' | 'chat'
export type MessageRole = 'user' | 'michael' | 'jim' | 'dwight' | 'pam' | 'riley' | 'chat' | 'error'

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  files?: Record<string, string>
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  mode: ConversationMode
  createdAt: number
  updatedAt: number
}

interface StoreShape {
  conversations: Conversation[]
  messages: Message[]
}

const STORE_PATH = () => path.join(app.getPath('userData'), 'branch-hq-conversations.json')

let cache: StoreShape | null = null

async function load(): Promise<StoreShape> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(STORE_PATH(), 'utf-8')
    cache = JSON.parse(raw)
  } catch {
    cache = { conversations: [], messages: [] }
  }
  return cache!
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.writeFile(STORE_PATH(), JSON.stringify(cache, null, 2), 'utf-8')
}

function defaultTitle(mode: ConversationMode): string {
  switch (mode) {
    case 'pipeline': return 'New Pipeline Run'
    case 'jim': return 'Chat with Jim'
    case 'dwight': return 'Chat with Dwight'
    case 'pam': return 'Chat with Pam'
    case 'chat': return 'New Chat'
  }
}

export async function createConversation(mode: ConversationMode, title?: string): Promise<Conversation> {
  const store = await load()
  const now = Date.now()
  const convo: Conversation = {
    id: randomUUID(),
    title: title || defaultTitle(mode),
    mode,
    createdAt: now,
    updatedAt: now
  }
  store.conversations.unshift(convo)
  await persist()
  return convo
}

export async function listConversations(): Promise<Conversation[]> {
  const store = await load()
  return [...store.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversation(id: string): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const store = await load()
  const conversation = store.conversations.find(c => c.id === id)
  if (!conversation) return null
  const messages = store.messages
    .filter(m => m.conversationId === id)
    .sort((a, b) => a.createdAt - b.createdAt)
  return { conversation, messages }
}

export async function deleteConversation(id: string): Promise<void> {
  const store = await load()
  store.conversations = store.conversations.filter(c => c.id !== id)
  store.messages = store.messages.filter(m => m.conversationId !== id)
  await persist()
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const store = await load()
  const convo = store.conversations.find(c => c.id === id)
  if (convo) {
    convo.title = title
    await persist()
  }
}

export async function addMessage(
  conversationId: string,
  role: MessageRole,
  content: string,
  files?: Record<string, string>
): Promise<Message> {
  const store = await load()
  const message: Message = {
    id: randomUUID(),
    conversationId,
    role,
    content,
    files,
    createdAt: Date.now()
  }
  store.messages.push(message)

  const convo = store.conversations.find(c => c.id === conversationId)
  if (convo) {
    convo.updatedAt = message.createdAt
    // Auto-title from the first user message, if the conversation still has its default title.
    const isDefaultTitle = convo.title === defaultTitle(convo.mode)
    const isFirstUserMessage =
      role === 'user' &&
      store.messages.filter(m => m.conversationId === conversationId && m.role === 'user').length === 1
    if (isDefaultTitle && isFirstUserMessage) {
      convo.title = content.length > 60 ? content.slice(0, 60) + '…' : content
    }
  }

  await persist()
  return message
}