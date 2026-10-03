import { spawn, type ChildProcess } from 'node:child_process'
import type { CommandHook, MatcherGroup, PluginLogger } from '../types.js'
import { capString, errorMessage, isPlainObject } from '../util.js'

export interface HookOutcome {
  ran: boolean
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  output?: HookJson
  failClosed: boolean
  loopLimit?: number
}

export interface HookJson {
  permission?: string
  additional_context?: string
  agent_message?: string
  user_message?: string
  continue?: boolean
  followup_message?: string
  updated_input?: unknown
}

export interface HookRunSpec {
  event: string
  groups: readonly MatcherGroup[]
  matchedValue: string | undefined
  input: Record<string, unknown>
  cwd: string
  defaultTimeoutMs: number
  signal?: AbortSignal
  onSpawn?: (child: ChildProcess) => void
}

export function matcherHits(matcher: string | undefined, value: string | undefined): boolean {
  if (matcher === undefined || matcher.trim() === '') return true
  if (value === undefined) return false
  try {
    return new RegExp(matcher).test(value)
  } catch {
    return matcher === value
  }
}

const MAX_HOOK_CAPTURE_CHARS = 1_048_576

export async function runEventHooks(spec: HookRunSpec, logger: PluginLogger): Promise<HookOutcome[]> {
  const outcomes: HookOutcome[] = []
  for (const group of spec.groups) {
    if (!matcherHits(group.matcher, spec.matchedValue)) continue
    for (const hook of group.hooks) {
      if (!matcherHits(hook.matcher, spec.matchedValue)) continue
      outcomes.push(await runCommandHook(hook, spec, logger, group.cwd))
    }
  }
  return outcomes
}

function commandUsesHookDir(command: string): boolean {
  return /(^|\s)\.\.?\//.test(command.trim())
}

function resolveHookCwd(command: string, hookDir: string | undefined, sessionCwd: string): string {
  if (hookDir !== undefined && hookDir.trim() !== '' && commandUsesHookDir(command)) return hookDir
  return sessionCwd
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_HOOK_CAPTURE_CHARS) return current
  const next = current + chunk
  return next.length <= MAX_HOOK_CAPTURE_CHARS ? next : next.slice(0, MAX_HOOK_CAPTURE_CHARS)
}

function skippedHook(hook: CommandHook): HookOutcome {
  return {
    ran: false,
    command: hook.command,
    exitCode: null,
    stdout: '',
    stderr: '',
    failClosed: hook.failClosed === true,
  }
}

async function runCommandHook(
  hook: CommandHook,
  spec: HookRunSpec,
  logger: PluginLogger,
  hookDir?: string,
): Promise<HookOutcome> {
  if (spec.signal?.aborted) return skippedHook(hook)
  const timeoutMs = hook.timeout ?? spec.defaultTimeoutMs
  const cwd = resolveHookCwd(hook.command, hookDir, spec.cwd)
  return await new Promise((resolve) => {
    let settled = false
    const child = spawn(hook.command, {
      cwd,
      env: process.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    spec.onSpawn?.(child)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString('utf8'))
    })
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      resolve({
        ran: true,
        command: hook.command,
        exitCode,
        stdout,
        stderr,
        output: parseHookJson(stdout),
        failClosed: hook.failClosed === true,
        loopLimit: hook.loop_limit ?? undefined,
      })
    }
    child.on('error', (error) => {
      logger.warn?.(`cursor: hook ${JSON.stringify(hook.command)} failed to spawn: ${errorMessage(error)}`)
      finish(hook.failClosed ? 2 : 1)
    })
    child.on('close', (code) => finish(code))
    const timer = setTimeout(() => {
      logger.warn?.(`cursor: hook timed out after ${timeoutMs}ms: ${hook.command}`)
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish(hook.failClosed ? 2 : 1)
    }, timeoutMs)
    child.on('close', () => clearTimeout(timer))
    spec.signal?.addEventListener('abort', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    })
    try {
      child.stdin?.end(JSON.stringify(spec.input))
    } catch {
      child.stdin?.end()
    }
  })
}

export function parseHookJson(stdout: string): HookJson | undefined {
  const trimmed = stdout.trim()
  if (trimmed === '') return undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    return isPlainObject(value) ? (value as HookJson) : undefined
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown
      return isPlainObject(value) ? (value as HookJson) : undefined
    } catch {
      return undefined
    }
  }
}

export function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value
  }
  return ''
}

export function collectAdditionalContext(outcomes: readonly HookOutcome[], maxChars: number): string[] {
  const contexts: string[] = []
  for (const outcome of outcomes) {
    if (!outcome.ran) continue
    const extra = outcome.output?.additional_context
    if (typeof extra === 'string' && extra.trim() !== '') contexts.push(capString(extra, maxChars))
  }
  return contexts
}
