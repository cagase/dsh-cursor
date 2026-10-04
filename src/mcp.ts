import { createHash } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'
import type { HostContext } from './types.js'
import { fileExists, readText } from './fs.js'
import { forgetLiveSession, liveCwds, noteLiveSession } from './live-sessions.js'
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

function suffixedServerName(base: string, cwd: string, name: string, salt: string): string | undefined {
  const tag = createHash('sha1').update(`${cwd}\0${name}\0${salt}`).digest('hex').slice(0, 8)
  const stem = base.slice(0, Math.max(1, 32 - tag.length - 1))
  const mount = `${stem}_${tag}`
  return SERVER_NAME_RE.test(mount) ? mount : undefined
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  try {
    if (!(await fileExists(path))) return env
    const read = await readText(path)
    if (read.truncated) return env
    const text = read.text
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
  const mounted = new Map<string, { dispose: () => void; fingerprint: string }>()
  let reconcileRunning = false
  let reconcileDirty = false
  const reconcileOnce = async () => {
    const wanted: { mountName: string; fingerprint: string; config: Record<string, unknown>; label: string }[] = []
    for (const cwd of liveCwds()) {
      const settings = await loader.load(cwd)
      const claimed = new Map<string, string>()
      for (const [name, entry] of settings.mcpServers) {
        const normalized = await normalizeCursorServer(name, entry, cwd, toolCallTimeoutMs)
        if (normalized === undefined) continue
        const owner = claimed.get(normalized.serverName)
        if (owner !== undefined && owner !== name) {
          logger.warn?.(
            `cursor: MCP server ${JSON.stringify(name)} collides with ${JSON.stringify(owner)} as ${normalized.serverName}; skipped`,
          )
          continue
        }
        claimed.set(normalized.serverName, name)
        const fingerprint = JSON.stringify(normalized.config)
        if (wanted.some((item) => item.mountName === normalized.serverName && item.fingerprint === fingerprint)) continue
        let mountName = normalized.serverName
        if (wanted.some((item) => item.mountName === mountName)) {
          let suffixed: string | undefined
          for (let salt = 0; salt < 8; salt++) {
            const candidate = suffixedServerName(normalized.serverName, cwd, name, String(salt))
            if (candidate !== undefined && !wanted.some((item) => item.mountName === candidate)) {
              suffixed = candidate
              break
            }
          }
          if (suffixed === undefined) {
            logger.warn?.(
              `cursor: MCP server ${JSON.stringify(name)} from ${cwd} collides with a different config; skipped`,
            )
            continue
          }
          logger.warn?.(
            `cursor: MCP server ${JSON.stringify(name)} from ${cwd} differs from an existing ${mountName}; mounted as ${suffixed}`,
          )
          mountName = suffixed
        }
        wanted.push({
          mountName,
          fingerprint,
          label: name,
          config: { ...normalized.config, serverName: mountName },
        })
      }
    }
    const desired = new Set(wanted.map((item) => item.mountName))
    for (const item of wanted) {
      const current = mounted.get(item.mountName)
      if (current?.fingerprint === item.fingerprint) continue
      current?.dispose()
      mounted.delete(item.mountName)
      try {
        const specifier = '@deepseek-ai/dsh-mcp-client'
        const mcp = (await import(specifier)) as { apply?: (ctx: HostContext, config: unknown) => unknown }
        if (typeof mcp.apply !== 'function') {
          logger.warn?.('cursor: @deepseek-ai/dsh-mcp-client has no apply(); mcp.json skipped')
          continue
        }
        const child = ctx.plugin(mcp as never, item.config as never)
        mounted.set(item.mountName, {
          fingerprint: item.fingerprint,
          dispose: () => {
            try {
              ;(child as { dispose?: () => void } | undefined)?.dispose?.()
            } catch {
              // already gone
            }
          },
        })
        logger.info?.(`cursor: mounted MCP server as mcp__${item.mountName}__*`)
      } catch (error) {
        logger.warn?.(`cursor: cannot mount MCP server ${item.label}: ${errorMessage(error)}`)
      }
    }
    for (const [serverName, entry] of mounted) {
      if (desired.has(serverName)) continue
      entry.dispose()
      mounted.delete(serverName)
    }
  }
  const reconcile = async () => {
    reconcileDirty = true
    if (reconcileRunning) return
    reconcileRunning = true
    try {
      do {
        reconcileDirty = false
        await reconcileOnce()
      } while (reconcileDirty)
    } finally {
      reconcileRunning = false
      if (reconcileDirty) void reconcile()
    }
  }

  const track = (id: unknown, cwd: string | undefined) => {
    noteLiveSession(id, cwd)
  }
  ctx.on('agent/session-start', (payload: { agent?: { session?: { id?: unknown; header?: { cwd?: string } } } }) => {
    track(payload.agent?.session?.id, payload.agent?.session?.header?.cwd)
    void reconcile()
  })
  ctx.on('agent/disposed', (payload: { agent?: { session?: { id?: unknown; header?: { cwd?: string } } } }) => {
    forgetLiveSession(payload.agent?.session?.id, payload.agent?.session?.header?.cwd)
    void reconcile()
  })
  ctx.effect(
    () => () => {
      for (const entry of mounted.values()) entry.dispose()
      mounted.clear()
    },
    'cursor mcp servers',
  )
}
