/// <reference types="vite/client" />

interface Window {
  electronAPI: {
    invokeAI: (prompt: string, activeAgent: string) => Promise<{ 
      success: boolean; 
      result?: string; 
      error?: string;
      files?: Record<string, string>;
    }>
  }
}