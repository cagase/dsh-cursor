import { spawn } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { isAbort, isPlainObject } from '../util.js'
import { grokFamilyFor, grokSlugVocabulary, parseGrokRoute } from './grok.js'
import type { AgentTurnPlan } from './session.js'

export const AUTH_CODE = 'AUTH'
export const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
export const INVALID_ARGS_CODE = 'INVALID_ARGS'
export const INVALID_SESSION_ID_CODE = 'INVALID_SESSION_ID'
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
  // `--new-session-id` is validated as a UUIDv4 by the live CLI (t3 capture):
  // `Error: Invalid --new-session-id "…": expected a UUIDv4.`
  if (lower.includes('expected a uuidv4') || (lower.includes('invalid --new-session-id'))) {
    return { code: INVALID_SESSION_ID_CODE, message: text }
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

/**
 * Absolute root of the CLI's local chat store. Production uses the CLI default
 * `~/.cursor/chats` (capture §6); `CURSOR_CHATS_DIR` overrides it so the
 * offline suite can point the adapter and its stand-in at one directory.
 */
export function cursorChatsRoot(): string {
  const override = process.env.CURSOR_CHATS_DIR?.trim()
  return override === undefined || override === '' ? join(homedir(), '.cursor', 'chats') : override
}

/**
 * True when the CLI already stores a chat for `sessionId`.
 *
 * A `--resume` for a chat the CLI does not have exits 0 with empty stderr and
 * silently creates a fresh chat that adopts the requested id (t3 F2), so the
 * chat's existence must be established BEFORE choosing `--resume`. The
 * workspace-hash directory is opaque and is therefore never assumed: every
 * directory under the chats root is scanned. Nothing about mtime or size is
 * used as a signal.
 */
export async function hasCursorChatStore(sessionId: string): Promise<boolean> {
  const id = sessionId.trim()
  if (id === '') return false
  const root = cursorChatsRoot()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return false
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await stat(join(root, entry.name, id))
      .then((info) => info.isDirectory())
      .catch(() => false)
    if (found) return true
  }
  return false
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

/** One advertised catalog entry: the id handed to `--model` plus its label. */
export interface CursorCatalogEntry {
  id: string
  label?: string
}

/** Chrome emitted by `agent models` / `agent --list-models` around the ids. */
const CATALOG_CHROME = /^(?:available models|tip:|usage:|error:|###)/i

export async function listCursorModelCatalog(
  bin: string,
  signal?: AbortSignal,
): Promise<CursorCatalogEntry[]> {
  const attempts = [['--list-models'], ['models']] as const
  let lastDetail = ''
  for (const args of attempts) {
    const result = await runAgent(bin, [...args], { timeoutMs: PROBE_TIMEOUT_MS, signal })
    const detail = `${result.stdout}\n${result.stderr}`
    lastDetail = detail
    const classified = classifyCliFailure(detail)
    if (classified) throw new CursorCliError(classified.message, classified.code)
    if (result.code !== 0) continue
    const entries = parseModelCatalog(result.stdout)
    if (entries.length > 0) return entries
  }
  const classified = classifyCliFailure(lastDetail)
  if (classified) throw new CursorCliError(classified.message, classified.code)
  throw new CursorCliError(
    lastDetail.trim() || 'Cursor agent CLI did not list any models.',
    AUTH_CODE,
  )
}

export async function listCursorModelSlugs(bin: string, signal?: AbortSignal): Promise<string[]> {
  return (await listCursorModelCatalog(bin, signal)).map((entry) => entry.id)
}

/**
 * Parse a catalog listing into id/label pairs. `agent models` is line-oriented
 * text (`<id> - <label>`) with no JSON form; JSON is still accepted first for
 * forward compatibility.
 */
export function parseModelCatalog(text: string): CursorCatalogEntry[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const entries: CursorCatalogEntry[] = []
  const seen = new Set<string>()
  const push = (id: string, label?: string) => {
    const clean = id.trim()
    if (clean === '' || clean.includes('[') || seen.has(clean)) return
    seen.add(clean)
    entries.push(label === undefined ? { id: clean } : { id: clean, label })
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const fromJson = slugsFromUnknown(parsed)
    if (fromJson.length > 0) {
      for (const id of fromJson) push(id)
      return entries
    }
  } catch {
    // line-oriented fallback
  }
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || CATALOG_CHROME.test(line)) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const ids = slugsFromUnknown(parsed)
      if (ids.length > 0) {
        for (const id of ids) push(id)
        continue
      }
    } catch {
      // not json
    }
    const labeled = line.match(/^([A-Za-z0-9][A-Za-z0-9._:+-]*)\s+-\s+(\S.*)$/)
    if (labeled) {
      push(labeled[1]!, labeled[2]!)
      continue
    }
    const token = line.split(/\s+/)[0]
    if (token && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(token) && !token.includes('[')) {
      push(token)
    }
  }
  return entries
}

export function parseModelList(text: string): string[] {
  return parseModelCatalog(text).map((entry) => entry.id)
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

/** CLI help examples used only when `agent models` cannot run (AUTH). */
export const FALLBACK_MODEL_SLUGS = ['gpt-5', 'sonnet-4-thinking'] as const

const EFFORT_SUFFIXES: Array<{ suffix: string; effort: string }> = [
  { suffix: '-extra-high', effort: 'xhigh' },
  { suffix: '-xhigh', effort: 'xhigh' },
  { suffix: '-max', effort: 'max' },
  { suffix: '-high', effort: 'high' },
  { suffix: '-medium', effort: 'medium' },
  { suffix: '-low', effort: 'low' },
  { suffix: '-minimal', effort: 'minimal' },
  { suffix: '-none', effort: 'none' },
]

/** Split a route id into its base and any encoded effort / Fast suffix. */
export function parseCursorModelId(model: string): CursorModelRoute {
  const id = model.trim()
  if (id.includes('[')) return { id, base: id, passthrough: id }
  const grok = parseGrokRoute(id)
  if (grok) {
    return {
      id,
      base: grok.base,
      ...grok.fast ? { fast: true } : {},
      ...grok.effort ? { effort: grok.effort } : {},
    }
  }
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

/**
 * Normalize a caller effort into the CLI's own slug vocabulary. `xhigh` is the
 * catalog spelling; there is no `max` level for any Grok base (capture §2), so
 * nothing is rewritten into `max` here.
 */
export function mapReasoningEffort(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined
  const key = effort.trim().toLowerCase().replace(/_/g, '-')
  if (key === '') return undefined
  if (key === 'extra-high' || key === 'xhigh') return 'xhigh'
  if (key === 'off') return 'none'
  return key
}

export interface CursorWireOptions {
  /** Slugs the CLI advertises for this account (live catalog ∪ captured set). */
  vocabulary?: ReadonlySet<string> | readonly string[]
  /** Live catalog slugs, so a family the capture does not know still composes. */
  liveSlugs?: readonly string[]
  /** Route default effort materialized when the caller omits one. */
  defaultEffort?: string
}

function asVocabulary(
  vocabulary: CursorWireOptions['vocabulary'],
): ReadonlySet<string> {
  if (vocabulary === undefined) return grokSlugVocabulary([])
  if (vocabulary instanceof Set) return vocabulary
  return new Set(vocabulary)
}

/**
 * Compose the exact string handed to `agent --model`.
 *
 * Grok routes are composed from the CLI's own advertised slug vocabulary
 * (`<base>-<effort>`, `<base>-<effort>-fast`) — never from `base[param=value]`
 * overrides, which the CLI rejects (capture §3.2). A caller-supplied bracketed
 * id passes through byte-identical, and every non-Grok provider keeps its
 * catalog id verbatim: no synthetic suffix and no synthetic effort. A pair with
 * no advertised slug fails with INVALID_ARGS instead of guessing.
 */
export function wireCursorModel(
  model: string,
  reasoningEffort?: string,
  options: CursorWireOptions = {},
): string {
  const id = model.trim()
  if (id === '' || id.includes('[')) return id
  const route = parseGrokRoute(id)
  if (!route) return id
  const vocabulary = asVocabulary(options.vocabulary)
  const family = grokFamilyFor(route.base, options.liveSlugs ?? [])
  const requested = mapReasoningEffort(reasoningEffort)
  const effort = requested ?? route.effort
  const defaultEffort = options.defaultEffort ?? family?.defaultEffort ?? 'high'
  const candidates: string[] = []
  if (effort !== undefined) candidates.push(`${route.base}-${effort}${route.fast ? '-fast' : ''}`)
  else if (route.fast) candidates.push(`${route.base}-${defaultEffort}-fast`)
  else {
    if (family?.wireBase !== undefined) candidates.push(family.wireBase)
    candidates.push(`${route.base}-${defaultEffort}`, route.base)
  }
  for (const candidate of candidates) {
    if (vocabulary.has(candidate)) return candidate
  }
  throw new CursorCliError(
    `Cursor model "${id}"${effort === undefined ? '' : ` at effort "${effort}"`}`
    + ` has no slug advertised by the Cursor agent CLI (tried ${candidates.map((c) => `"${c}"`).join(', ')}).`
    + ' Pick the effort from the model\'s own supported levels, or the Fast route.',
    INVALID_ARGS_CODE,
  )
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

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** The CLI's own tool activity: a turn boundary, never transcript content. */
  | { type: 'tool' }
  | { type: 'result'; text?: string; done: true; success: boolean }
  | { type: 'error'; error: string; done: true; success: false }
  | { type: 'ignored' }

export function interpretAgentStreamLine(line: string): AgentStreamEvent {
  const trimmed = line.trim()
  if (trimmed === '') return { type: 'ignored' }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isPlainObject(parsed)) return { type: 'ignored' }
    return interpretAgentStreamObject(parsed)
  } catch {
    // Non-JSON stdout is not assistant content; never surface it as a message.
    return { type: 'ignored' }
  }
}

/**
 * Map one `--output-format stream-json` object to a transcript event.
 *
 * Only `assistant` carries assistant text and only `thinking`/`reasoning`
 * carries thinking. `system` init, the `user` prompt echo, `tool_call`,
 * `retry`, `connection` and `interaction_query` are dropped: none of them is
 * part of the DSH transcript (capture §7).
 */
export function interpretAgentStreamObject(value: Record<string, unknown>): AgentStreamEvent {
  const type = typeof value.type === 'string' ? value.type : ''
  if (type === 'assistant') {
    const message = isPlainObject(value.message) ? value.message : value
    const role = typeof message.role === 'string' ? message.role : 'assistant'
    if (role !== 'assistant') return { type: 'ignored' }
    const text = textFromUnknown(message.content)
    return text === '' ? { type: 'ignored' } : { type: 'text', text }
  }
  if (type === 'thinking' || type === 'reasoning') {
    const text = textFromUnknown(value.text ?? value.thinking ?? value.reasoning ?? value.content)
    return text === '' ? { type: 'ignored' } : { type: 'reasoning', text }
  }
  if (type === 'result') {
    const errorText = collectErrorText(value)
    if (value.is_error === true || value.success === false || errorText !== undefined) {
      return {
        type: 'error',
        error: errorText ?? 'Cursor agent CLI reported an error result.',
        done: true,
        success: false,
      }
    }
    const text = typeof value.result === 'string' ? value.result : undefined
    return text === undefined
      ? { type: 'result', done: true, success: true }
      : { type: 'result', text, done: true, success: true }
  }
  if (type === 'error') {
    return {
      type: 'error',
      error: collectErrorText(value) ?? 'Cursor agent CLI reported an error.',
      done: true,
      success: false,
    }
  }
  if (type === 'tool_call' || type === 'tool-call' || type === 'tool_use') return { type: 'tool' }
  return { type: 'ignored' }
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
    else if (typeof item.thinking === 'string') parts.push(item.thinking)
  }
  return parts.join('')
}

function collectErrorText(value: Record<string, unknown>): string | undefined {
  if (typeof value.error === 'string' && value.error.trim() !== '') return value.error
  if (isPlainObject(value.error) && typeof value.error.message === 'string') return value.error.message
  if (typeof value.message === 'string' && (value.type === 'error' || value.is_error === true)) return value.message
  if (typeof value.result === 'string' && value.is_error === true) return value.result
  return undefined
}

/**
 * Full `agent` argument list for one planned shim turn. Exactly one positional
 * prompt travels; the session store is selected by `--new-session-id` once and
 * `--resume` afterwards (capture §6).
 */
export function buildAgentArgs(wireModel: string, plan: AgentTurnPlan, cwd?: string): string[] {
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
  if (cwd) args.push('--workspace', cwd)
  if (plan.session.mode === 'new' && plan.session.id) args.push('--new-session-id', plan.session.id)
  else if (plan.session.mode === 'resume' && plan.session.id) args.push('--resume', plan.session.id)
  args.push(plan.positional)
  return args
}

interface AgentTurnAttempt {
  code: number | null
  stderr: string
  failure?: { message: string; code: string }
}

function isSessionInUse(detail: string): boolean {
  // capture §6.1: Error: Session ID "…" is already in use. (exit 1)
  return /already in use/i.test(detail)
}

async function* attemptAgentTurn(
  bin: string,
  args: readonly string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): AsyncGenerator<AgentStreamEvent, AgentTurnAttempt> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const child = spawn(bin, [...args], {
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

  let failure: { message: string; code: string } | undefined
  try {
    const lines = createInterface({ input: child.stdout! })
    for await (const line of lines) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const event = interpretAgentStreamLine(line)
      if (event.type === 'ignored') continue
      if (event.type === 'tool') {
        // The turn boundary is all we take from the CLI's own tool activity.
        yield event
        continue
      }
      if (event.type === 'error') {
        failure ??= classifyCliFailure(event.error) ?? { message: event.error, code: 'UNKNOWN' }
        continue
      }
      yield event
    }
    const code = await waitForExit(child)
    const stderrText = Buffer.concat(stderr).toString('utf8')
    if (!failure) {
      const classified = classifyCliFailure(stderrText)
      if (classified) failure = classified
      else if (code !== 0) {
        failure = {
          message: stderrText.trim() || `Cursor agent CLI exited with code ${code}.`,
          code: 'UNKNOWN',
        }
      }
    }
    return { code, stderr: stderrText, ...(failure ? { failure } : {}) }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

/** Mutable holder so a recovery inside {@link streamAgentTurn} is the plan the caller commits. */
export interface AgentTurnHolder {
  plan: AgentTurnPlan
}

/**
 * Stream one planned turn, yielding transcript events only. Terminal failures
 * are yielded last so the caller can classify them. Two recoveries keep the
 * turn alive without ever failing the DSH request:
 *   - a single-use `--new-session-id` collision (the DSH session's CLI chat
 *     already exists, e.g. after a plugin restart) resumes that chat;
 *   - a failed `--resume` (the CLI no longer has the chat) degrades to a fresh
 *     session that carries the full DSH context again.
 * `turn.plan` is updated to whichever session actually served the turn.
 */
export async function* streamAgentTurn(
  bin: string,
  wireModel: string,
  turn: AgentTurnHolder,
  options: { cwd?: string; signal?: AbortSignal } = {},
): AsyncGenerator<AgentStreamEvent> {
  const first = yield* attemptAgentTurn(bin, buildAgentArgs(wireModel, turn.plan, options.cwd), options)
  if (
    first.failure
    && turn.plan.session.mode === 'new'
    && turn.plan.session.id
    && isSessionInUse(first.stderr)
  ) {
    const resumed: AgentTurnPlan = { ...turn.plan, session: { mode: 'resume', id: turn.plan.session.id } }
    const second = yield* attemptAgentTurn(bin, buildAgentArgs(wireModel, resumed, options.cwd), options)
    if (second.failure) yield { type: 'error', error: second.failure.message, done: true, success: false }
    return
  }
  if (first.failure && turn.plan.session.mode === 'resume' && turn.plan.reanchor) {
    const fresh = turn.plan.reanchor()
    turn.plan = fresh
    const second = yield* attemptAgentTurn(bin, buildAgentArgs(wireModel, fresh, options.cwd), options)
    if (second.failure) yield { type: 'error', error: second.failure.message, done: true, success: false }
    return
  }
  if (
    first.failure
    && turn.plan.session.mode === 'new'
    && first.failure.code === INVALID_SESSION_ID_CODE
    && turn.plan.reanchorFresh
  ) {
    // Belt and braces: if a future CLI rejects the derived id's shape, one random
    // UUIDv4 keeps the turn alive instead of failing it.
    const fresh = turn.plan.reanchorFresh()
    turn.plan = fresh
    const second = yield* attemptAgentTurn(bin, buildAgentArgs(wireModel, fresh, options.cwd), options)
    if (second.failure) yield { type: 'error', error: second.failure.message, done: true, success: false }
    return
  }
  if (first.failure) yield { type: 'error', error: first.failure.message, done: true, success: false }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code))
  })
}
