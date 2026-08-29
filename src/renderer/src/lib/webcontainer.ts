import { WebContainer, FileSystemTree } from '@webcontainer/api'

// Store the Promise, not the resolved instance
let bootPromise: Promise<WebContainer> | null = null

export async function getWebContainer() {
  if (!bootPromise) {
    // FIXED: a failed boot attempt is still a non-null Promise, so the old
    // `if (!bootPromise)` check treated "we already tried and failed" the
    // same as "we already succeeded" -- every future call just replayed
    // the same failure forever, with no way to recover short of fully
    // restarting the app. Now a rejection resets bootPromise to null, so
    // the next call gets a genuine fresh attempt instead.
    bootPromise = WebContainer.boot().catch((err) => {
      bootPromise = null
      throw err
    })
  }
  // If it's already booting (or finished, or was just reset after a
  // failure), just return the current Promise.
  return bootPromise
}

export function buildFileSystemTree(files: Record<string, string>): FileSystemTree {
  const tree: FileSystemTree = {}

  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split('/')
    let current = tree

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!current[part]) {
        current[part] = { directory: {} }
      }

      // NEW: if this path segment already exists but isn't a directory
      // (e.g. two generated paths collide, like "src/App.tsx" and
      // "src/App.tsx/extra.ts"), fail with a clear message instead of a
      // confusing runtime crash a few lines later.
      const entry = current[part] as any
      if (!entry.directory) {
        throw new Error(
          `Cannot build file tree: "${parts.slice(0, i + 1).join('/')}" is used as both a file and a folder across the generated files.`
        )
      }

      current = entry.directory
    }

    const fileName = parts[parts.length - 1]
    current[fileName] = {
      file: { contents: content }
    }
  }

  return tree
}