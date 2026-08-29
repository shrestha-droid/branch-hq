import { WebContainer, FileSystemTree } from '@webcontainer/api'

// Store the Promise, not the resolved instance
let bootPromise: Promise<WebContainer> | null = null

export async function getWebContainer() {
  if (!bootPromise) {
    // If it hasn't started booting yet, initiate it and store the pending Promise
    bootPromise = WebContainer.boot()
  }
  // If it's already booting (or finished), just return the Promise
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
      // @ts-ignore
      current = current[part].directory
    }

    const fileName = parts[parts.length - 1]
    current[fileName] = {
      file: { contents: content }
    }
  }

  return tree
}