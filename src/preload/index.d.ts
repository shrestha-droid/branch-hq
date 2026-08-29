import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
  }
  interface Window {
  electronAPI: {
    invokeAI: (prompt: string, model: string) => Promise<{ success: boolean; result?: string; error?: string }>
  }
}
}

