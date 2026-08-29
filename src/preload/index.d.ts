import { ElectronAPI } from '@electron-toolkit/preload'

// FIXED: this used to also declare `api: unknown` here, which conflicted
// with the real, fully-typed `api` declared in preload/index.ts. Having
// two different descriptions of the same global property in two files is
// exactly the kind of drift that caused window.api calls to silently type
// as 'unknown' even with a correct type sitting right next to it. Removed
// so preload/index.ts's version is the only one and just merges in.
declare global {
  interface Window {
    electron: ElectronAPI
  }
  interface Window {
  electronAPI: {
    invokeAI: (prompt: string, model: string) => Promise<{ success: boolean; result?: string; error?: string }>
  }
}
}