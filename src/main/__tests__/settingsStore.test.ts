import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'

// settingsStore.ts calls app.getPath('userData') internally, which only
// exists inside a real running Electron process. Mocking it here to
// point at a real temp directory is what makes this testable in plain
// Node/vitest without needing Electron itself -- the actual file I/O
// underneath is still real, this just relocates where it happens.
const testDir = path.join(os.tmpdir(), 'branch-hq-test-' + Date.now())

vi.mock('electron', () => ({
  app: { getPath: () => testDir }
}))

describe('settingsStore', () => {
  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true })
    // Each test gets a clean settings file -- otherwise a write in one
    // test could leak into the next and make failures confusing to trace.
    await fs.rm(path.join(testDir, 'branch-hq-settings.json'), { force: true })
    vi.resetModules()
  })

  it('returns sane defaults on a completely fresh install with no saved file', async () => {
    const { getSettings } = await import('../settingsStore')
    const settings = await getSettings()
    expect(settings.modelProvider).toBe('gemini')
    expect(settings.geminiModel).toBeTruthy()
  })

  it('persists an update and reflects it on the next read', async () => {
    const { getSettings, updateSettings } = await import('../settingsStore')
    await updateSettings({ geminiModel: 'gemini-3.7-flash' })
    const settings = await getSettings()
    expect(settings.geminiModel).toBe('gemini-3.7-flash')
  })

  it('a partial update never wipes out unrelated fields', async () => {
    const { getSettings, updateSettings } = await import('../settingsStore')
    await updateSettings({ defaultTargetDir: '/Users/test/project' })
    await updateSettings({ geminiModel: 'gemini-3.1-flash-lite' })
    const settings = await getSettings()
    expect(settings.defaultTargetDir).toBe('/Users/test/project')
    expect(settings.geminiModel).toBe('gemini-3.1-flash-lite')
  })

  it('an older settings file missing a newer field still loads with that field defaulted, not missing', async () => {
    // Simulates a real upgrade scenario: fallbackGeminiModel was added
    // after some users already had a settings.json on disk without it.
    await fs.writeFile(
      path.join(testDir, 'branch-hq-settings.json'),
      JSON.stringify({ modelProvider: 'gemini', geminiModel: 'gemini-3.7-flash' }),
      'utf-8'
    )
    const { getSettings } = await import('../settingsStore')
    const settings = await getSettings()
    expect(settings.geminiModel).toBe('gemini-3.7-flash')
    expect(settings.fallbackGeminiModel).toBeDefined()
  })
})