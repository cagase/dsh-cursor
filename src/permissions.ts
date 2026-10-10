import { isAbsolute, relative, resolve } from 'node:path'
import { cursorToolName, isTeamLaneTool } from './hooks/names.js'
import type { PluginLogger, PreToolDecision, ToolExecutionLike } from './types.js'
import { errorMessage, isPlainObject, matchGlob, toolCommand, toolFilePath } from './util.js'
import type { CursorSettingsLoader } from './settings.js'

type TokenKind = 'shell' | 'read' | 'write' | 'webfetch' | 'mcp'

let notedApprovalMode = false

interface ParsedToken {
  kind: TokenKind
  pattern: string
  argsPart?: string
}

export type PermissionVerdict = { kind: 'allow' } | { kind: 'deny'; reason: string } | undefined

export function parseToken(raw: string): ParsedToken | undefined {
  const match = /^(Shell|Read|Write|WebFetch|Mcp)\((.*)\)$/.exec(raw.trim())
  if (!match) return undefined
  const kindName = match[1]!
  const inner = match[2]!
  const kind: TokenKind =
    kindName === 'Shell' ? 'shell' : kindName === 'Read' ? 'read' : kindName === 'Write' ? 'write' : kindName === 'WebFetch' ? 'webfetch' : 'mcp'
  if (kind === 'shell') {
    const colon = inner.indexOf(':')
    if (colon >= 0) return { kind, pattern: inner.slice(0, colon), argsPart: inner.slice(colon + 1) }
  }
  return { kind, pattern: inner }
}

export function evaluateCursorPermissions(
  allow: readonly string[],
  deny: readonly string[],
  exec: ToolExecutionLike,
  cwd?: string,
): PermissionVerdict {
  const name = cursorToolName(exec.name)
  let allowed = false
  for (const raw of allow) {
    const token = parseToken(raw)
    if (token !== undefined && tokenMatches(token, name, exec.arguments, exec.name, cwd)) {
      allowed = true
      break
    }
  }
  for (const raw of deny) {
    const token = parseToken(raw)
    if (token !== undefined && tokenMatches(token, name, exec.arguments, exec.name, cwd)) {
      return { kind: 'deny', reason: `denied by a Cursor permission rule (${raw})` }
    }
  }
  if (allowed) return { kind: 'allow' }
  return undefined
}

function tokenMatches(token: ParsedToken, toolName: string, args: unknown, dshName: string, cwd?: string): boolean {
  switch (token.kind) {
    case 'shell': {
      if (toolName !== 'Shell') return false
      const command = toolCommand(args)
      if (command === undefined) return false
      const base = command.trim().split(/\s+/)[0] ?? ''
      if (!matchGlob(token.pattern, base)) return false
      if (token.argsPart !== undefined && token.argsPart !== '*') {
        const rest = command.trim().slice(base.length).trim()
        if (!matchGlob(token.argsPart, rest)) return false
      }
      return true
    }
    case 'read':
      return toolName === 'Read' && pathMatches(token.pattern, toolFilePath(args), cwd)
    case 'write':
      return (toolName === 'Write' || toolName === 'Edit') && pathMatches(token.pattern, toolFilePath(args), cwd)
    case 'webfetch': {
      if (toolName !== 'WebFetch') return false
      const url = isPlainObject(args) && typeof args.url === 'string' ? args.url : undefined
      if (url === undefined) return false
      try {
        return matchGlob(token.pattern, new URL(url).hostname)
      } catch {
        return false
      }
    }
    case 'mcp': {
      if (!dshName.startsWith('mcp') && toolName !== 'Mcp') return false
      const [server, tool] = splitMcp(dshName.startsWith('mcp') ? dshName : toolName)
      const [patternServer, patternTool] = (token.pattern.includes(':') ? token.pattern : `${token.pattern}:*`).split(/:(.*)/s)
      return matchGlob(patternServer || '*', server) && matchGlob(patternTool || '*', tool)
    }
  }
}

function pathMatches(pattern: string, path: string | undefined, cwd?: string): boolean {
  if (path === undefined) return false
  let glob = pattern.replace(/\\/g, '/').trim()
  while (glob.startsWith('./')) glob = glob.slice(2)
  if (glob.startsWith('/')) glob = glob.slice(1)
  let target = path.replace(/\\/g, '/')
  if (cwd !== undefined && cwd !== '') {
    const rel = relative(resolve(cwd), resolve(target)).replace(/\\/g, '/')
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false
    target = rel
  }
  return matchGlob(glob, target)
}

function splitMcp(toolName: string): [string, string] {
  let withoutPrefix = toolName.replace(/^mcp__/, '')
  if (withoutPrefix.startsWith('cursor__')) withoutPrefix = withoutPrefix.slice('cursor__'.length)
  const index = withoutPrefix.indexOf('__')
  if (index < 0) return [withoutPrefix, '*']
  return [withoutPrefix.slice(0, index), withoutPrefix.slice(index + 2)]
}

/**
 * Deny-wins only. `allow` does not skip DSH approval — unmatched and allowed
 * calls fall through to `next()`.
 */
export function createPermissionsGate(
  logger: PluginLogger,
  loader: CursorSettingsLoader,
): (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const agent = exec.agent
    if (!agent) return next()
    try {
      const settings = await loader.load(agent.session.header.cwd)
      if (settings.approvalMode && !notedApprovalMode) {
        notedApprovalMode = true
        logger.warn?.(
          `cursor: cli approvalMode=${JSON.stringify(settings.approvalMode)} is not enforced; DSH owns approval/sandbox`,
        )
      }
      const verdict = evaluateCursorPermissions(settings.permissionAllow, settings.permissionDeny, exec, agent.session.header.cwd)
      if (verdict?.kind === 'deny') return { kind: 'deny', reason: verdict.reason }
      return next()
    } catch (error) {
      const reason = `cursor permission rules failed: ${errorMessage(error)}`
      logger.warn?.(reason)
      if (isTeamLaneTool(exec.name)) return next()
      return { kind: 'deny', reason }
    }
  }
}
