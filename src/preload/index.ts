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

  // NEW: native execution engine -- a real Node/npm runtime instead of
  // WebContainers, when one is actually available on the machine.
  detectRuntime: () => ipcRenderer.invoke('runtime:detect'),
  startNativeSandbox: (runId: string, files: Record<string, string>) =>
    ipcRenderer.invoke('sandbox:startNative', { runId, files }),
  stopNativeSandbox: (runId: string) => ipcRenderer.invoke('sandbox:stopNative', { runId }),
  // Streaming events from a native run -- log lines and readiness/error
  // signals arrive over time, not as a single request/response. Each
  // listener returns an unsubscribe function so the caller can clean up
  // when it stops caring (switching runs, unmounting).
  onSandboxLog: (callback: (data: { runId: string; source: string; line: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('sandbox:log', listener)
    return () => ipcRenderer.removeListener('sandbox:log', listener)
  },
  onSandboxFrontendReady: (callback: (data: { runId: string; url: string; port: number }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('sandbox:frontend-ready', listener)
    return () => ipcRenderer.removeListener('sandbox:frontend-ready', listener)
  },
  onSandboxBackendReady: (callback: (data: { runId: string; url: string; port: number }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('sandbox:backend-ready', listener)
    return () => ipcRenderer.removeListener('sandbox:backend-ready', listener)
  },
  onSandboxError: (callback: (data: { runId: string; source: string; message: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('sandbox:error', listener)
    return () => ipcRenderer.removeListener('sandbox:error', listener)
  },

  // Workspace & File System Ops
  indexWorkspace: (targetPath?: string) => ipcRenderer.invoke('workspace:index', targetPath),
  writeFiles: (targetDirectory: string, files: Record<string, string>, overwriteConfirmed?: boolean) =>
    ipcRenderer.invoke('fs:write', { targetDirectory, files, overwriteConfirmed }),
  // NEW: dry-run overwrite check -- reports which files already exist
  // without writing anything.
  checkFileConflicts: (targetDirectory: string, files: Record<string, string>) =>
    ipcRenderer.invoke('fs:checkConflicts', { targetDirectory, files }),
  // NEW: a real ZIP download -- opens a native save dialog, writes a
  // genuine .zip of the merged file set. For someone who just wants the
  // code to take elsewhere and deploy it themselves.
  downloadZip: (files: Record<string, string>, suggestedName?: string) =>
    ipcRenderer.invoke('fs:downloadZip', { files, suggestedName }),
  // NEW: real file upload -- extracts actual text from an uploaded PDF
  // or plain-text document so it can be used as real context, not just
  // a filename mentioned in passing.
  extractFileText: (fileName: string, fileBytes: ArrayBuffer) =>
    ipcRenderer.invoke('file:extractText', { fileName, fileBytes }),
  // NEW: GitHub integration -- credential management (the token itself
  // never comes back through this bridge, only a boolean) and the real
  // push-to-a-new-repo action.
  setGithubToken: (token: string) => ipcRenderer.invoke('credentials:setGithubToken', token),
  hasGithubToken: () => ipcRenderer.invoke('credentials:hasGithubToken'),
  clearGithubToken: () => ipcRenderer.invoke('credentials:clearGithubToken'),
  pushToGithub: (files: Record<string, string>, repoName: string, isPrivate: boolean) =>
    ipcRenderer.invoke('git:pushToGithub', { files, repoName, isPrivate }),
  // NEW: model-call usage stats for the current session/conversation.
  getUsage: (conversationId?: string) => ipcRenderer.invoke('usage:get', conversationId),
  // NEW: live settings -- provider, model, default folder. Changing
  // these takes effect on the next message, no restart needed.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial: Record<string, any>) => ipcRenderer.invoke('settings:set', partial),
  // NEW: exports the factual Gate1/Pam record for a conversation, with
  // an integrity hash proving the report wasn't edited after generation.
  exportAuditReport: (conversationId: string) => ipcRenderer.invoke('audit:export', conversationId),
  // NEW: called once the sandbox has genuinely run a generation
  // successfully -- upgrades its audit record from "Pam approved" to
  // "confirmed running." Distinct, stronger claim than Gate 2's opinion.
  markAuditExecuted: (auditId: string) => ipcRenderer.invoke('audit:markExecuted', auditId),

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
      invokeAI: (conversationId: string, prompt: string) => Promise<{ success: boolean; messages?: any[]; files?: Record<string, string>; agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string; auditId?: string | null; error?: string }>;
      invokeAgent: (conversationId: string, agentName: 'jim' | 'dwight' | 'pam' | 'chat', prompt: string) => Promise<{ success: boolean; messages?: any[]; error?: string }>;
      healPipeline: (params: {
        conversationId: string
        agentKey: 'jim' | 'dwight' | 'riley'
        previousInstructions: string
        errorLog: string
        attempt: number
      }) => Promise<{ success: boolean; messages?: any[]; files?: Record<string, string>; agentKey?: 'jim' | 'dwight' | 'riley'; instructions?: string; auditId?: string; error?: string }>;
      detectRuntime: () => Promise<{ available: boolean; nodeVersion?: string; npmVersion?: string }>;
      startNativeSandbox: (runId: string, files: Record<string, string>) => Promise<{ success: boolean; error?: string }>;
      stopNativeSandbox: (runId: string) => Promise<{ success: boolean }>;
      onSandboxLog: (callback: (data: { runId: string; source: string; line: string }) => void) => () => void;
      onSandboxFrontendReady: (callback: (data: { runId: string; url: string; port: number }) => void) => () => void;
      onSandboxBackendReady: (callback: (data: { runId: string; url: string; port: number }) => void) => () => void;
      onSandboxError: (callback: (data: { runId: string; source: string; message: string }) => void) => () => void;
      indexWorkspace: (targetPath?: string) => Promise<{ success: boolean; indexedFiles?: number; error?: string }>;
      writeFiles: (targetDirectory: string, files: Record<string, string>, overwriteConfirmed?: boolean) => Promise<{ success: boolean; writtenFiles?: string[]; skippedFiles?: string[]; error?: string }>;
      checkFileConflicts: (targetDirectory: string, files: Record<string, string>) => Promise<{ success: boolean; conflicts?: string[]; error?: string }>;
      downloadZip: (files: Record<string, string>, suggestedName?: string) => Promise<{ success: boolean; savedTo?: string; canceled?: boolean; error?: string }>;
      extractFileText: (fileName: string, fileBytes: ArrayBuffer) => Promise<{ success: boolean; text?: string; truncated?: boolean; error?: string }>;
      setGithubToken: (token: string) => Promise<{ success: boolean; error?: string }>;
      hasGithubToken: () => Promise<{ hasToken: boolean }>;
      clearGithubToken: () => Promise<{ success: boolean }>;
      pushToGithub: (files: Record<string, string>, repoName: string, isPrivate: boolean) => Promise<{ success: boolean; repoUrl?: string; error?: string }>;
      getUsage: (conversationId?: string) => Promise<{ success: boolean; session: { callCount: number; charsIn: number; charsOut: number }; conversation: { callCount: number; charsIn: number; charsOut: number } | null }>;
      getSettings: () => Promise<{ modelProvider: 'gemini' | 'local'; geminiModel: string; fallbackGeminiModel: string; localModelBaseUrl: string; localModelName: string; localEmbeddingModelName: string; defaultTargetDir: string; strictVerification: boolean }>;
      updateSettings: (partial: Record<string, any>) => Promise<{ modelProvider: 'gemini' | 'local'; geminiModel: string; fallbackGeminiModel: string; localModelBaseUrl: string; localModelName: string; localEmbeddingModelName: string; defaultTargetDir: string; strictVerification: boolean }>;
      exportAuditReport: (conversationId: string) => Promise<{ success: boolean; report?: string; integrityHash?: string; generatedAt?: string; error?: string }>;
      markAuditExecuted: (auditId: string) => Promise<{ success: boolean; updated?: boolean; error?: string }>;
      createConversation: (mode: string, title?: string) => Promise<any>;
      listConversations: () => Promise<any[]>;
      getConversation: (id: string) => Promise<{ conversation: any; messages: any[] } | null>;
      deleteConversation: (id: string) => Promise<{ success: boolean }>;
      renameConversation: (id: string, title: string) => Promise<{ success: boolean }>;
    }
  }
}