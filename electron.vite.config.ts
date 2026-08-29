import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
    // Cross-origin isolation headers (COEP/COOP) removed from here.
    // This block only ever applied during `npm run dev` -- it's a no-op in
    // a packaged build, since there's no Vite dev server at that point.
    // index.ts's `onHeadersReceived` handler runs in both dev and packaged
    // builds and was silently overwriting this file's `require-corp` with
    // `credentialless` anyway (whichever handler runs last on the actual
    // network response wins). That's now the single source of truth for
    // cross-origin isolation -- see index.ts.
  }
})