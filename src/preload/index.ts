import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // AI Pipeline & Agent Calls
  invokeAI: (conversationId: string, prompt: string) => ipcRenderer.invoke('ai:invoke', { conversationId, prompt }),
  invokeAgent: (conversationId: string, agentName: 'jim' | 'dwight' | 'pam' | 'chat', prompt: string) =>
    ipcRenderer.invoke('agent:invoke', { conversationId, agentName, prompt }),
  // NEW: self-healing. Called after code has already passed review but
  // then actually failed when run -- feeds the real error back and asks
  // for a fix, capped at a small number of attempts on the main-process side.
  healPipeline: (params: {
    conversationId: string
    agentKey: 'jim' | 'dwight' | 'riley'
    previousInstructions: string
    errorLog: string
    attempt: number
  }) => ipcRenderer.invoke('heal:invoke', params),

  // Workspace & File System Ops
  indexWorkspace: (targetPath?: string) => ipcRenderer.invoke('workspace:index', targetPath),
  writeFiles: (targetDirectory: string, files: Record<string, string>, humanApproverId?: string) =>
    ipcRenderer.invoke('fs:write', { targetDirectory, files, humanApproverId }),

  // Conversation Store Ops
  createConversation: (mode: string, title?: string) => ipcRenderer.invoke('conversation:create', { mode, title }),
  listConversations: () => ipcRenderer.invoke('conversation:list'),
  getConversation: (id: string) => ipcRenderer.invoke('conversation:get', id),
  deleteConversation: (id: string) => ipcRenderer.invoke('conversation:delete', id),
  renameConversation: (id: string, title: string) => ipcRenderer.invoke('conversation:rename', { id, title })
})

declare global {
  interface Window {
    api: {
      invokeAI: (conversationId: string, prompt: string) => Promise<{ success: boolean; messages?: any[]; files?: Record<string, string>; agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string; error?: string }>;
      invokeAgent: (conversationId: string, agentName: 'jim' | 'dwight' | 'pam' | 'chat', prompt: string) => Promise<{ success: boolean; messages?: any[]; error?: string }>;
      healPipeline: (params: {
        conversationId: string
        agentKey: 'jim' | 'dwight' | 'riley'
        previousInstructions: string
        errorLog: string
        attempt: number
      }) => Promise<{ success: boolean; messages?: any[]; files?: Record<string, string>; agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string; error?: string }>;
      indexWorkspace: (targetPath?: string) => Promise<{ success: boolean; indexedFiles?: number; error?: string }>;
      writeFiles: (targetDirectory: string, files: Record<string, string>, humanApproverId?: string) => Promise<{ success: boolean; writtenFiles?: string[]; provenanceManifest?: any; error?: string }>;
      createConversation: (mode: string, title?: string) => Promise<any>;
      listConversations: () => Promise<any[]>;
      getConversation: (id: string) => Promise<{ conversation: any; messages: any[] } | null>;
      deleteConversation: (id: string) => Promise<{ success: boolean }>;
      renameConversation: (id: string, title: string) => Promise<{ success: boolean }>;
    }
  }
}