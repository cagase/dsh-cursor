import { basename, isAbsolute, join } from 'node:path'
import type { HostContext } from './types.js'
import { fileExists, readText } from './fs.js'
import { expandHome, errorMessage } from './util.js'
import type { PluginLogger } from './types.js'
import type { CursorSettingsLoader, RawCursorMcpServer } from './settings.js'

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export function interpolateCursor(value: string, workspaceFolder: string): string {
  const folderBasename = basename(workspaceFolder)
  const pathSeparator = process.platform === 'win32' ? '\\' : '/'
  return value
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
    .replace(/\$\{userHome\}/g, expandHome('~'))
    .replace(/\$\{workspaceFolderBasename\}/g, folderBasename)
    .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
    .replace(/\$\{pathSeparator\}/g, pathSeparator)
    .replace(/\$\{\/\}/g, pathSeparator)
}

export function sanitizeServerName(name: string): string | undefined {
  const cleaned = `cursor__${name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 32)
  return SERVER_NAME_RE.test(cleaned) ? cleaned : undefined
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  try {
    if (!(await fileExists(path))) return env
    const text = await readText(path)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const index = trimmed.indexOf('=')
      if (index <= 0) continue
      env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
    }
  } catch {
    // fail soft
  }
  return env
}

function resolveRelative(path: string, baseDir: string): string {
  if (isAbsolute(path)) return path
  return join(baseDir, path)
}

export async function normalizeCursorServer(
  name: string,
  entry: RawCursorMcpServer,
  workspaceFolder: string,
  toolCallTimeoutMs: number,
): Promise<{ serverName: string; config: Record<string, unknown> } | undefined> {
  const serverName = sanitizeServerName(name)
  if (serverName === undefined) return undefined
  if (entry.auth !== undefined) {
    // OAuth is won’t-do; still mount if command/url exists.
  }
  if (entry.url !== undefined) {
    return {
      serverName,
      config: {
        transport: 'streamable-http',
        serverName,
        url: interpolateCursor(entry.url, workspaceFolder),
        headers: Object.fromEntries(
          Object.entries(entry.headers ?? {}).map(([key, value]) => [key, interpolateCursor(value, workspaceFolder)]),
        ),
        toolCallTimeoutMs,
        failOnStartupError: false,
      },
    }
  }
  if (entry.command !== undefined) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry.env ?? {})) env[key] = interpolateCursor(value, workspaceFolder)
    if (entry.envFile !== undefined) {
      Object.assign(env, await readEnvFile(resolveRelative(entry.envFile, entry.baseDir)))
    }
    return {
      serverName,
      config: {
        transport: 'stdio',
        serverName,
        command: interpolateCursor(entry.command, workspaceFolder),
        args: (entry.args ?? []).map((arg) => interpolateCursor(arg, workspaceFolder)),
        env,
        cwd: entry.cwd !== undefined ? resolveRelative(entry.cwd, entry.baseDir) : workspaceFolder,
        toolCallTimeoutMs,
        failOnStartupError: false,
      },
    }
  }
  return undefined
}

export function registerMcp(
  ctx: HostContext,
  logger: PluginLogger,
  loader: CursorSettingsLoader,
  toolCallTimeoutMs: number,
): void {
  const mounted = new Map<string, () => void>()
  const reconcile = async (cwd?: string) => {
    const settings = await loader.load(cwd)
    const workspace = cwd ?? process.cwd()
    const desired = new Set<string>()
    for (const [name, entry] of settings.mcpServers) {
      const normalized = await normalizeCursorServer(name, entry, workspace, toolCallTimeoutMs)
      if (normalized === undefined) continue
      desired.add(normalized.serverName)
      if (mounted.has(normalized.serverName)) continue
      try {
        const specifier = '@deepseek-ai/dsh-mcp-client'
        const mcp = (await import(specifier)) as { apply?: (ctx: HostContext, config: unknown) => unknown }
        if (typeof mcp.apply !== 'function') {
          logger.warn?.('cursor: @deepseek-ai/dsh-mcp-client has no apply(); mcp.json skipped')
          return
        }
        const child = ctx.plugin(mcp as never, normalized.config as never)
        mounted.set(normalized.serverName, () => {
          try {
            ;(child as { dispose?: () => void } | undefined)?.dispose?.()
          } catch {
            // already gone
          }
        })
        logger.info?.(`cursor: mounted MCP server as mcp__${normalized.serverName}__*`)
      } catch (error) {
        logger.warn?.(`cursor: cannot mount MCP server ${name}: ${errorMessage(error)}`)
      }
    }
    for (const [serverName, dispose] of mounted) {
      if (desired.has(serverName)) continue
      dispose()
      mounted.delete(serverName)
    }
  }

  ctx.on('agent/session-start', (payload: { agent?: { session?: { header?: { cwd?: string } } } }) => {
    void reconcile(payload.agent?.session?.header?.cwd)
  })
  ctx.effect(
    () => () => {
      for (const dispose of mounted.values()) dispose()
      mounted.clear()
    },
    'cursor mcp servers',
  )
}
