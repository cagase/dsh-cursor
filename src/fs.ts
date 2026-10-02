import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbort, isMissing } from './util.js'

export interface DirEntry {
  name: string
  isDir: boolean
  isFile: boolean
}

export async function readText(path: string, signal?: AbortSignal): Promise<string> {
  return await readFile(path, { encoding: 'utf8', signal })
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
