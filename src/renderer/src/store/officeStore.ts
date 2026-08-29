import { create } from 'zustand'

interface OfficeState {
  activeAgent: string
  setActiveAgent: (agent: string) => void
}

export const useOfficeStore = create<OfficeState>((set) => ({
  activeAgent: 'Michael',
  setActiveAgent: (agent) => set({ activeAgent: agent }),
}))