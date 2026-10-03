import { dirname, join } from 'node:path'
import { parseJsonc } from './jsonc.js'
import { fileExists, readText, stamp } from './fs.js'
import { projectCursorDir, userCursorDir } from './roots.js'
import type { CommandHook, MatcherGroup, PluginLogger } from './types.js'
import { errorMessage, isPlainObject } from './util.js'

export interface RawCursorMcpServer {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  envFile?: string
  cwd?: string
  url?: string
  headers?: Record<string, string>
  auth?: unknown
  baseDir: string
}

export interface LoadedCursorSettings {
  byEvent: ReadonlyMap<string, readonly MatcherGroup[]>
  permissionAllow: readonly string[]
  permissionDeny: readonly string[]
  approvalMode?: string
  mcpServers: ReadonlyMap<string, RawCursorMcpServer>
  mcpAllowlist: readonly string[]
  terminalAllowlist: readonly string[]
}

interface SettingsSource {
  path: string
  kind: 'user' | 'project'
  hookDir?: string
}

export class CursorSettingsLoader {
  private readonly cache = new Map<string, { stamp: string; loaded: LoadedCursorSettings }>()
  private notedUnsupported = false

  constructor(
    private readonly logger: PluginLogger,
    private readonly configuredUserDir: string,
  ) {}

  userDir(): string {
    return userCursorDir(this.configuredUserDir)
  }

  async sourcePaths(cwd?: string): Promise<string[]> {
    return (await this.sources(cwd)).map((source) => source.path)
  }

  invalidate(): void {
    this.cache.clear()
  }

  private async sources(cwd?: string): Promise<SettingsSource[]> {
    const userDir = this.userDir()
    const sources: SettingsSource[] = [
      { path: join(userDir, 'cli-config.json'), kind: 'user' },
      { path: join(userDir, 'hooks.json'), kind: 'user', hookDir: userDir },
      { path: join(userDir, 'mcp.json'), kind: 'user' },
      { path: join(userDir, 'permissions.json'), kind: 'user' },
    ]
    if (cwd) {
      const dir = projectCursorDir(cwd)
      sources.push(
        { path: join(dir, 'cli.json'), kind: 'project' },
        { path: join(dir, 'hooks.json'), kind: 'project' },
        { path: join(dir, 'mcp.json'), kind: 'project' },
        { path: join(dir, 'permissions.json'), kind: 'project' },
      )
    }
    return sources
  }

  async load(cwd?: string): Promise<LoadedCursorSettings> {
    const sources = await this.sources(cwd)
    const stamps: string[] = []
    for (const source of sources) {
      try {
        stamps.push(`${source.path}:${(await stamp(source.path)) ?? 'absent'}`)
      } catch {
        stamps.push(`${source.path}:unreadable`)
      }
    }
    const cacheKey = cwd ?? '<no-cwd>'
    const key = stamps.join('|')
    const cached = this.cache.get(cacheKey)
    if (cached && cached.stamp === key) {
      this.noteUnsupported(cached.loaded)
      return cached.loaded
    }
    const loaded = await this.loadFresh(sources)
    this.cache.set(cacheKey, { stamp: key, loaded })
    this.noteUnsupported(loaded)
    return loaded
  }

  private noteUnsupported(loaded: LoadedCursorSettings): void {
    if (this.notedUnsupported) return
    const notes: string[] = []
    if (loaded.approvalMode) notes.push(`approvalMode=${JSON.stringify(loaded.approvalMode)}`)
    if (loaded.mcpAllowlist.length > 0) notes.push('mcpAllowlist')
    if (loaded.terminalAllowlist.length > 0) notes.push('terminalAllowlist')
    if (notes.length === 0) return
    this.notedUnsupported = true
    this.logger.warn?.(
      `cursor: ${notes.join(', ')} is not enforced; DSH owns approval and sandbox`,
    )
  }

  private async loadFresh(sources: SettingsSource[]): Promise<LoadedCursorSettings> {
    const byEvent = new Map<string, MatcherGroup[]>()
    const seenHandlers = new Set<string>()
    let permissionAllow: string[] | undefined
    let permissionDeny: string[] | undefined
    let approvalMode: string | undefined
    let mcpAllowlist: string[] | undefined
    let terminalAllowlist: string[] | undefined
    const mcpServers = new Map<string, RawCursorMcpServer>()

    for (const source of sources) {
      const base = source.path.endsWith('cli.json') || source.path.endsWith('cli-config.json')
        ? 'cli'
        : source.path.endsWith('hooks.json')
          ? 'hooks'
          : source.path.endsWith('mcp.json')
            ? 'mcp'
            : 'permissions'
      const layer = await this.readLayer(source, base)
      if (layer === undefined) continue
      for (const [event, groups] of Object.entries(layer.hooks ?? {})) {
        const merged = byEvent.get(event) ?? []
        for (const group of groups) {
          const handlers: CommandHook[] = []
          for (const handler of group.hooks) {
            const key = JSON.stringify(handler)
            if (seenHandlers.has(key)) continue
            seenHandlers.add(key)
            handlers.push(handler)
          }
          if (handlers.length > 0) merged.push({ matcher: group.matcher, cwd: group.cwd, hooks: handlers })
        }
        byEvent.set(event, merged)
      }
      if (layer.permissionAllow !== undefined) permissionAllow = [...(permissionAllow ?? []), ...layer.permissionAllow]
      if (layer.permissionDeny !== undefined) permissionDeny = [...(permissionDeny ?? []), ...layer.permissionDeny]
      if (layer.approvalMode !== undefined) approvalMode = layer.approvalMode
      if (layer.mcpAllowlist !== undefined) mcpAllowlist = layer.mcpAllowlist
      if (layer.terminalAllowlist !== undefined) terminalAllowlist = layer.terminalAllowlist
      if (layer.mcpServers !== undefined) {
        for (const [name, entry] of layer.mcpServers) mcpServers.set(name, entry)
      }
    }

    return {
      byEvent,
      permissionAllow: permissionAllow ?? [],
      permissionDeny: permissionDeny ?? [],
      approvalMode,
      mcpServers,
      mcpAllowlist: mcpAllowlist ?? [],
      terminalAllowlist: terminalAllowlist ?? [],
    }
  }

  private async readLayer(
    source: SettingsSource,
    base: 'cli' | 'hooks' | 'mcp' | 'permissions',
  ): Promise<{
    hooks?: Record<string, MatcherGroup[]>
    permissionAllow?: string[]
    permissionDeny?: string[]
    approvalMode?: string
    mcpServers?: Map<string, RawCursorMcpServer>
    mcpAllowlist?: string[]
    terminalAllowlist?: string[]
  } | undefined> {
    let text: string
    try {
      if (!(await fileExists(source.path))) return undefined
      text = await readText(source.path)
    } catch (error) {
      this.logger.warn?.(`cursor: cannot read config ${source.path}: ${errorMessage(error)}`)
      return undefined
    }
    let value: unknown
    try {
      value = parseJsonc(text)
    } catch (error) {
      this.logger.warn?.(`cursor: ignoring invalid JSON config file ${source.path}: ${errorMessage(error)}`)
      return undefined
    }
    if (!isPlainObject(value)) {
      this.logger.warn?.(`cursor: ignoring config file ${source.path}: top level must be an object`)
      return undefined
    }
    const layer: {
      hooks?: Record<string, MatcherGroup[]>
      permissionAllow?: string[]
      permissionDeny?: string[]
      approvalMode?: string
      mcpServers?: Map<string, RawCursorMcpServer>
      mcpAllowlist?: string[]
      terminalAllowlist?: string[]
    } = {}
    if (base === 'hooks') layer.hooks = normalizeHooks(value.hooks, this.logger, source.path, source.hookDir)
    if (base === 'cli') {
      const permissions = value.permissions
      if (isPlainObject(permissions)) {
        if (Array.isArray(permissions.allow)) {
          layer.permissionAllow = permissions.allow.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        }
        if (Array.isArray(permissions.deny)) {
          layer.permissionDeny = permissions.deny.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        }
      }
      if (typeof value.approvalMode === 'string' && value.approvalMode.trim() !== '') {
        layer.approvalMode = value.approvalMode.trim()
      }
    }
    if (base === 'mcp') {
      const mcpServers = value.mcpServers
      if (isPlainObject(mcpServers)) {
        const parsed = new Map<string, RawCursorMcpServer>()
        const baseDir = dirname(source.path)
        for (const [name, entry] of Object.entries(mcpServers)) {
          if (!isPlainObject(entry)) continue
          const server: RawCursorMcpServer = { baseDir }
          if (typeof entry.type === 'string' && entry.type.trim() !== '') server.type = entry.type.trim()
          if (typeof entry.command === 'string' && entry.command.trim() !== '') server.command = entry.command
          if (Array.isArray(entry.args)) server.args = entry.args.filter((arg): arg is string => typeof arg === 'string')
          if (isPlainObject(entry.env)) {
            const env: Record<string, string> = {}
            for (const [key, envValue] of Object.entries(entry.env)) {
              if (typeof envValue === 'string') env[key] = envValue
            }
            server.env = env
          }
          if (typeof entry.envFile === 'string' && entry.envFile.trim() !== '') server.envFile = entry.envFile.trim()
          if (typeof entry.cwd === 'string' && entry.cwd.trim() !== '') server.cwd = entry.cwd.trim()
          if (typeof entry.url === 'string' && entry.url.trim() !== '') server.url = entry.url
          if (isPlainObject(entry.headers)) {
            const headers: Record<string, string> = {}
            for (const [key, headerValue] of Object.entries(entry.headers)) {
              if (typeof headerValue === 'string') headers[key] = headerValue
            }
            server.headers = headers
          }
          if (entry.auth !== undefined) server.auth = entry.auth
          if (server.command === undefined && server.url === undefined) continue
          parsed.set(name, server)
        }
        if (parsed.size > 0) layer.mcpServers = parsed
      }
    }
    if (base === 'permissions') {
      if (Array.isArray(value.mcpAllowlist)) {
        layer.mcpAllowlist = value.mcpAllowlist.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      }
      if (Array.isArray(value.terminalAllowlist)) {
        layer.terminalAllowlist = value.terminalAllowlist.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      }
    }
    return layer
  }
}

function normalizeHooks(
  value: unknown,
  logger: PluginLogger,
  path: string,
  hookDir?: string,
): Record<string, MatcherGroup[]> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    logger.warn?.(`cursor: ignoring malformed hooks field in ${path}: must be an object`)
    return undefined
  }
  const normalized: Record<string, MatcherGroup[]> = {}
  for (const [event, handlers] of Object.entries(value)) {
    if (!Array.isArray(handlers)) continue
    const valid = handlers.filter(isValidHandler)
    if (valid.length > 0) normalized[event] = valid.map((hooks) => ({ matcher: hooks.matcher, cwd: hookDir, hooks: [hooks] }))
  }
  return normalized
}

function isValidHandler(value: unknown): value is CommandHook {
  if (!isPlainObject(value)) return false
  if (value.type !== undefined && value.type !== 'command') return false
  if (typeof value.command !== 'string' || value.command.trim() === '') return false
  return (
    (value.timeout === undefined || typeof value.timeout === 'number') &&
    (value.loop_limit === undefined || value.loop_limit === null || typeof value.loop_limit === 'number') &&
    (value.failClosed === undefined || typeof value.failClosed === 'boolean') &&
    (value.matcher === undefined || typeof value.matcher === 'string')
  )
}
