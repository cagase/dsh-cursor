import { homedir } from 'node:os'
import { basename } from 'node:path'

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return homedir() + path.slice(1)
  return path
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function capString(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}

export function escapeReminderClose(text: string): string {
  return text.replaceAll('</system-reminder>', '<\\/system-reminder>')
}

export function isKebabCase(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'untitled'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Convert a glob (`**`, `*`, `?`) to an unanchored-or-full-path matcher. */
export function matchGlob(pattern: string, filePath: string): boolean {
  const path = filePath.replace(/\\/g, '/')
  const glob = pattern.replace(/\\/g, '/').trim()
  if (glob === '' || glob === '*') return true
  const regex = globToRegExp(glob)
  if (regex.test(path)) return true
  if (!glob.includes('/')) return regex.test(basename(path))
  return false
}

function globToRegExp(glob: string): RegExp {
  let out = '(?:^|/)'
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    const next = glob[i + 1]
    if (char === '*' && next === '*') {
      const after = glob[i + 2]
      if (after === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
      continue
    }
    if (char === '*') {
      out += '[^/]*'
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if ('\\^$+()[]{}|.'.includes(char)) out += `\\${char}`
    else out += char
  }
  out += '$'
  return new RegExp(out)
}

export function toolFilePath(args: unknown): string | undefined {
  if (!isPlainObject(args)) return undefined
  if (typeof args.file_path === 'string' && args.file_path.trim() !== '') return args.file_path
  if (typeof args.path === 'string' && args.path.trim() !== '') return args.path
  return undefined
}

export function toolCommand(args: unknown): string | undefined {
  if (!isPlainObject(args)) return undefined
  if (typeof args.command === 'string') return args.command
  return undefined
}

export function pluginUserMessage(plugin: string, text: string, form: 'instructions' | 'notice' = 'instructions'): PluginUserMessage {
  return {
    id: crypto.randomUUID() as never,
    role: 'user',
    content: [{ type: 'text', text }],
    source: form === 'notice'
      ? { kind: 'plugin', plugin, form: 'notice', summary: capString(text.replace(/\s+/g, ' ').trim(), 120) }
      : { kind: 'plugin', plugin, form: 'instructions' },
  }
}

export interface PluginUserMessage {
  id: never
  role: 'user'
  content: [{ type: 'text'; text: string }]
  source: { kind: 'plugin'; plugin: string; form: 'instructions' } | { kind: 'plugin'; plugin: string; form: 'notice'; summary: string }
}

export function reminder(plugin: string, body: string): PluginUserMessage {
  return pluginUserMessage(plugin, `<system-reminder>\n${escapeReminderClose(body)}\n</system-reminder>`)
}
