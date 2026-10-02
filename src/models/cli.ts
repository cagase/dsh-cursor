import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { isAbort, isPlainObject } from '../util.js'

export const AUTH_CODE = 'AUTH'
export const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
export const INVALID_ARGS_CODE = 'INVALID_ARGS'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

const PROBE_TIMEOUT_MS = 10_000

export class CursorCliError extends Error {
  readonly code: string
  readonly failure: { readonly message: string; readonly code: string }

  constructor(message: string, code: string) {
    super(message)
    this.name = 'CursorCliError'
    this.code = code
    this.failure = { message, code }
  }
}

export interface CursorCliProbe {
  bin?: string
  authenticated: boolean
  error?: string
  code?: string
}

export interface CursorModelRoute {
  id: string
  base: string
  fast?: boolean
  effort?: string
  passthrough?: string
}

export function hasEnvCredential(): boolean {
  return Boolean(process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim())
}

export function classifyCliFailure(detail: string): { code: string; message: string } | undefined {
  const text = detail.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  const lower = text.toLowerCase()
  if (
    lower.includes('invalid api key')
    || lower.includes('invalid auth')
    || (lower.includes('malformed') && lower.includes('key'))
  ) {
    return {
      code: INVALID_CREDENTIAL_CODE,
      message: 'Cursor agent CLI credential is unusable. Set CURSOR_API_KEY to the raw key or run `agent login`.',
    }
  }
  if (
    lower.includes('not logged in')
    || lower.includes('unauthenticated')
    || lower.includes('authentication required')
    || lower.includes('agent login')
    || lower.includes('unauthorized')
  ) {
    return {
      code: AUTH_CODE,
      message: 'Cursor agent CLI is not logged in. Run `agent login`.',
    }
  }
  if (lower.includes('cannot use this model') || lower.includes('available models:')) {
    return { code: INVALID_ARGS_CODE, message: text }
  }
  return undefined
}

export function missingBinaryError(): CursorCliError {
  return new CursorCliError(
    'Cursor agent CLI not found on PATH. Install the Cursor agent CLI or set CURSOR_AGENT_BIN.',
    MISSING_CREDENTIAL_CODE,
  )
}

export function authError(message = 'Cursor agent CLI is not logged in. Run `agent login`.'): CursorCliError {
  return new CursorCliError(message, AUTH_CODE)
}

export async function resolveAgentBin(): Promise<string | undefined> {
  const override = process.env.CURSOR_AGENT_BIN?.trim()
  if (override) {
    return (await isExecutable(override)) ? override : undefined
  }
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'agent')
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function probeCursorCli(signal?: AbortSignal): Promise<CursorCliProbe> {
  const bin = await resolveAgentBin()
  if (!bin) {
    const error = missingBinaryError()
    return { authenticated: false, error: error.message, code: error.code }
  }
  if (hasEnvCredential()) {
    return { bin, authenticated: true }
  }
  try {
    const result = await runAgent(bin, ['status', '--format', 'json'], { timeoutMs: PROBE_TIMEOUT_MS, signal })
    const status = parseStatus(result.stdout) ?? parseStatus(result.stderr)
    if (status?.authenticated) return { bin, authenticated: true }
    const classified = classifyCliFailure(`${result.stdout}\n${result.stderr}`) ?? {
      code: AUTH_CODE,
      message: 'Cursor agent CLI is not logged in. Run `agent login`.',
    }
    return { bin, authenticated: false, error: classified.message, code: classified.code }
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw error
    const classified = classifyCliFailure(error instanceof Error ? error.message : String(error))
    if (classified) return { bin, authenticated: false, error: classified.message, code: classified.code }
    return {
      bin,
      authenticated: false,
      error: error instanceof Error ? error.message : String(error),
      code: AUTH_CODE,
    }
  }
}

function parseStatus(text: string): { authenticated: boolean } | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isPlainObject(parsed)) return undefined
    if (typeof parsed.isAuthenticated === 'boolean') return { authenticated: parsed.isAuthenticated }
    if (typeof parsed.status === 'string') {
      return { authenticated: parsed.status === 'authenticated' || parsed.status === 'logged_in' }
    }
  } catch {
    // fall through
  }
  const lower = trimmed.toLowerCase()
  if (lower.includes('logged in') && !lower.includes('not logged in')) return { authenticated: true }
  if (lower.includes('not logged in') || lower.includes('unauthenticated')) return { authenticated: false }
  return undefined
}

export async function listCursorModelSlugs(bin: string, signal?: AbortSignal): Promise<string[]> {
  const attempts = [['--list-models'], ['models']] as const
  let lastDetail = ''
  for (const args of attempts) {
    const result = await runAgent(bin, [...args], { timeoutMs: PROBE_TIMEOUT_MS, signal })
    const detail = `${result.stdout}\n${result.stderr}`
    lastDetail = detail
    const classified = classifyCliFailure(detail)
    if (classified) throw new CursorCliError(classified.message, classified.code)
    if (result.code !== 0) continue
    const slugs = parseModelList(result.stdout)
    if (slugs.length > 0) return slugs
  }
  const classified = classifyCliFailure(lastDetail)
  if (classified) throw new CursorCliError(classified.message, classified.code)
  throw new CursorCliError(
    lastDetail.trim() || 'Cursor agent CLI did not list any models.',
    AUTH_CODE,
  )
}

export function parseModelList(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const fromJson = slugsFromUnknown(parsed)
    if (fromJson.length > 0) return uniqueSlugs(fromJson)
  } catch {
    // line-oriented fallback
  }
  const slugs: string[] = []
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('Usage:') || line.startsWith('Error:')) continue
    if (/^available models/i.test(line) || /^models?:/i.test(line)) continue
    try {
      const parsed = JSON.parse(line) as unknown
      slugs.push(...slugsFromUnknown(parsed))
      continue
    } catch {
      // not json
    }
    const labeled = line.match(/^([A-Za-z0-9][A-Za-z0-9._:+-]*)\s+-\s+(\S.*)$/)
    if (labeled) {
      slugs.push(labeled[1]!)
      continue
    }
    const token = line.split(/\s+/)[0]
    if (token && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(token) && !token.includes('[')) {
      slugs.push(token)
    }
  }
  return uniqueSlugs(slugs)
}

function slugsFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(slugsFromUnknown)
  if (!isPlainObject(value)) return []
  if (Array.isArray(value.models)) return value.models.flatMap(slugsFromUnknown)
  if (typeof value.id === 'string') return [value.id]
  if (typeof value.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value.name)) return [value.name]
  return []
}

function uniqueSlugs(slugs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const slug of slugs) {
    const id = slug.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** CLI help examples used only when `agent models` cannot run (AUTH). */
export const FALLBACK_MODEL_SLUGS = ['gpt-5', 'sonnet-4-thinking'] as const

const EFFORT_SUFFIXES: Array<{ suffix: string; effort: string }> = [
  { suffix: '-xhigh', effort: 'max' },
  { suffix: '-extra-high', effort: 'max' },
  { suffix: '-max', effort: 'max' },
  { suffix: '-high', effort: 'high' },
  { suffix: '-medium', effort: 'medium' },
  { suffix: '-low', effort: 'low' },
  { suffix: '-minimal', effort: 'minimal' },
  { suffix: '-none', effort: 'none' },
]

export function parseCursorModelId(model: string): CursorModelRoute {
  const id = model.trim()
  if (id.includes('[')) return { id, base: id, passthrough: id }
  let rest = id
  let fast: boolean | undefined
  let effort: string | undefined
  if (rest.endsWith('-fast')) {
    rest = rest.slice(0, -'-fast'.length)
    fast = true
  }
  for (const entry of EFFORT_SUFFIXES) {
    if (!rest.endsWith(entry.suffix)) continue
    rest = rest.slice(0, -entry.suffix.length)
    effort = entry.effort
    break
  }
  return { id, base: rest === '' ? id : rest, fast, effort }
}

export function mapReasoningEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined
  const key = effort.trim().toLowerCase()
  if (key === 'xhigh' || key === 'extra-high' || key === 'extra_high' || key === 'max') return 'max'
  if (key === 'off' || key === 'none') return undefined
  return key
}

export function wireCursorModel(model: string, reasoningEffort?: string): string {
  const parsed = parseCursorModelId(model)
  if (parsed.passthrough) return parsed.passthrough
  const effort = mapReasoningEffort(reasoningEffort)
  if (!effort) return model
  const parts = [`effort=${effort}`]
  if (parsed.fast) parts.push('fast=true')
  return `${parsed.base}[${parts.join(',')}]`
}

export interface AgentRunResult {
  stdout: string
  stderr: string
  code: number | null
}

export async function runAgent(
  bin: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; stdin?: string } = {},
): Promise<AgentRunResult> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_OPEN_BROWSER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (error?: unknown, result?: AgentRunResult) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(result!)
    }
    const onAbort = () => {
      child.kill('SIGTERM')
      finish(new DOMException('Aborted', 'AbortError'))
    }
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        child.kill('SIGTERM')
        finish(new CursorCliError(`Cursor agent CLI timed out after ${options.timeoutMs}ms.`, AUTH_CODE))
      }, options.timeoutMs)
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      finish(undefined, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
      })
    })
    if (options.stdin !== undefined) child.stdin?.write(options.stdin)
    child.stdin?.end()
  })
}

export interface AgentStreamEvent {
  type: string
  text?: string
  reasoning?: string
  tool?: string
  error?: string
  done?: boolean
  success?: boolean
}

export function interpretAgentStreamLine(line: string): AgentStreamEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isPlainObject(parsed)) return { type: 'text', text: trimmed }
    return interpretAgentStreamObject(parsed)
  } catch {
    return { type: 'text', text: trimmed }
  }
}

function interpretAgentStreamObject(value: Record<string, unknown>): AgentStreamEvent | undefined {
  const type = typeof value.type === 'string' ? value.type : ''
  const errorText = collectErrorText(value)
  if (errorText && (type === 'error' || (type === 'result' && value.is_error === true) || value.success === false)) {
    return { type: 'error', error: errorText, done: type === 'result' || type === 'error' }
  }
  if (type === 'result') {
    const text = typeof value.result === 'string' ? value.result : undefined
    return { type: 'result', text, done: true, success: value.is_error !== true }
  }
  if (type === 'thinking' || type === 'reasoning') {
    return { type: 'reasoning', reasoning: textFromUnknown(value.text ?? value.reasoning ?? value.content) }
  }
  if (type === 'tool_call' || type === 'tool-call' || type === 'tool_use') {
    const name = typeof value.name === 'string' ? value.name : 'tool'
    return { type: 'tool', tool: name, reasoning: `[cursor tool] ${name}` }
  }
  const delta = textFromUnknown(
    value.text
    ?? (isPlainObject(value.delta) ? value.delta.text : undefined)
    ?? collectAssistantText(value),
  )
  if (delta) return { type: 'text', text: delta }
  if (errorText) return { type: 'error', error: errorText }
  return undefined
}

function collectAssistantText(value: Record<string, unknown>): string {
  const message = isPlainObject(value.message) ? value.message : value
  return textFromUnknown(message.content)
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (!isPlainObject(item)) continue
    if (typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'thinking' && typeof item.thinking === 'string') parts.push(item.thinking)
  }
  return parts.join('')
}

function collectErrorText(value: Record<string, unknown>): string | undefined {
  if (typeof value.error === 'string') return value.error
  if (isPlainObject(value.error) && typeof value.error.message === 'string') return value.error.message
  if (typeof value.message === 'string' && (value.type === 'error' || value.is_error === true)) return value.message
  if (typeof value.result === 'string' && value.is_error === true) return value.result
  return undefined
}

export async function* streamAgentPrint(
  bin: string,
  wireModel: string,
  prompt: string,
  options: { cwd?: string; signal?: AbortSignal } = {},
): AsyncGenerator<AgentStreamEvent> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--trust',
    '--force',
    '--model',
    wireModel,
  ]
  if (options.cwd) args.push('--workspace', options.cwd)
  args.push(prompt)

  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: { ...process.env, NO_OPEN_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

  const onAbort = () => {
    child.kill('SIGTERM')
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const lines = createInterface({ input: child.stdout! })
    for await (const line of lines) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const event = interpretAgentStreamLine(line)
      if (event) yield event
    }
    const code = await waitForExit(child)
    const errText = Buffer.concat(stderr).toString('utf8')
    const classified = classifyCliFailure(errText)
    if (classified) {
      yield { type: 'error', error: classified.message, done: true, success: false }
      return
    }
    if (code !== 0) {
      yield {
        type: 'error',
        error: errText.trim() || `Cursor agent CLI exited with code ${code}.`,
        done: true,
        success: false,
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code))
  })
}
