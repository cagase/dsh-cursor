import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isAbort, isMissing } from './util.js'

const DEFAULT_MAX_READ_CHARS = 1024 * 1024
const MAX_STAMP_DEPTH = 32

export interface DirEntry {
  name: string
  isDir: boolean
  isFile: boolean
}

export interface TextRead {
  text: string
  truncated: boolean
}

export async function readText(path: string, signal?: AbortSignal, maxChars = DEFAULT_MAX_READ_CHARS): Promise<TextRead> {
  const text = await readFile(path, { encoding: 'utf8', signal })
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/** Cheap identity for a directory tree: names, sizes, and mtimes, not file bodies. */
export async function treeStamp(path: string, signal?: AbortSignal): Promise<string> {
  const parts: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (depth > MAX_STAMP_DEPTH) return
    let entries: DirEntry[]
    try {
      entries = await listDir(dir, signal)
    } catch (error) {
      if (isAbort(error)) throw error
      parts.push(`${dir}:missing`)
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      let stamped: string | undefined
      try {
        stamped = await stamp(child)
      } catch (error) {
        if (isAbort(error)) throw error
        parts.push(`${child}:unstampable`)
        continue
      }
      parts.push(`${child}:${stamped ?? 'missing'}`)
      if (entry.isDir) await walk(child, depth + 1)
    }
  }
  await walk(path, 0)
  return parts.join('|')
}

export async function fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  try {
    const info = await stat(path)
    return info.isFile()
  } catch (error) {
    if (isAbort(error)) throw error
    if (isMissing(error)) return false
    throw error
  }
}

export async function dirExists(path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch (error) {
    if (isAbort(error)) throw error
    if (isMissing(error)) return false
    throw error
  }
}

export async function listDir(path: string, signal?: AbortSignal): Promise<DirEntry[]> {
  const entries = await readdir(path, { withFileTypes: true })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return entries.map((entry) => ({
    name: entry.name,
    isDir: entry.isDirectory(),
    isFile: entry.isFile(),
  }))
}

export async function stamp(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    return `${info.mtimeMs}:${info.size}`
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}
