import type { HostContext, PluginLogger } from '../types.js'
import { forgetSessionCwd, noteSessionCwd, sessionCwd } from './session-cwd.js'
import { isAbort, isPlainObject } from '../util.js'
import {
  AUTH_CODE,
  CursorCliError,
  EMPTY_RESPONSE_CODE,
  FALLBACK_MODEL_SLUGS,
  authError,
  classifyCliFailure,
  hasCursorChatStore,
  listCursorModelCatalog,
  missingBinaryError,
  probeCursorCli,
  streamAgentTurn,
  wireCursorModel,
  type AgentStreamEvent,
  type CursorCatalogEntry,
} from './cli.js'
import {
  EFFORT_NAMES,
  GROK_CAPTURE_FAMILIES,
  grokFamiliesForCatalog,
  grokFamilyFor,
  grokSlugVocabulary,
  isGrokModel,
  parseGrokRoute,
  type GrokFamily,
} from './grok.js'
import {
  CursorSessionRegistry,
  renderAgentContext,
  type CursorGenerateOptions,
} from './session.js'

export const PROVIDER_ID = 'cursor'

const FALLBACK_DESCRIPTION =
  'Cursor CLI help example. Run `agent login`, then `agent models`, to confirm this slug for your account.'

/** How long one `agent models` listing is reused for wire-string validation. */
const CATALOG_TTL_MS = 5 * 60_000

export type { CursorContentBlock, CursorGenerateOptions, CursorMessage } from './session.js'

export interface CursorStreamChunk {
  type: 'block-start' | 'text-delta' | 'reasoning-delta' | 'block-end' | 'finish'
  index?: number
  blockType?: 'text' | 'reasoning'
  text?: string
  block?: { type: 'text' | 'reasoning'; text: string }
  reason?: {
    kind: 'stop' | 'error' | 'aborted'
    failure?: { message: string; code: string }
  }
}

export interface CursorModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly ['text']
}

export interface CursorEffortInfo {
  id: string
  name: string
  description?: string
}

export interface CursorResolvedModelInfo extends CursorModelInfo {
  reasoning?: {
    efforts: readonly CursorEffortInfo[]
    defaultEffort?: string
  }
}

/**
 * Publish the DSH picker catalog.
 *
 * Non-Grok models are listed verbatim from the CLI catalog: no renamed entry,
 * no synthetic suffix and no synthetic effort. Every Grok family gets exactly
 * one base entry plus its own `<base>-fast` entry (DSH has no boolean model
 * parameter), both carrying only the efforts whose composed slug exists. The
 * fallback path (AUTH or a missing binary) keeps the CLI help slugs verbatim
 * and uses the captured Grok matrix — it never invents an effort or a Fast
 * entry.
 */
export function expandModelCatalog(
  slugs: readonly string[],
  fallback: boolean,
  labels?: ReadonlyMap<string, string>,
): CursorModelInfo[] {
  const models: CursorModelInfo[] = []
  const seen = new Set<string>()
  const add = (id: string, name: string, description?: string) => {
    if (seen.has(id) || id === '') return
    seen.add(id)
    models.push({
      provider: PROVIDER_ID,
      id,
      name,
      ...description ? { description } : {},
      inputModalities: ['text'],
    })
  }
  const families = fallback ? GROK_CAPTURE_FAMILIES : grokFamiliesForCatalog(slugs)
  const familiesByBase = new Map(families.map((family) => [family.base, family]))
  // Grok routes lead the picker (base + own Fast entry, in the capture's family
  // order); every other provider follows in the CLI's own catalog order.
  for (const family of families) {
    add(family.base, grokEntryName(family, labels, false), grokEntryDescription(family, false))
    // The Fast route id is a real captured slug (`<base>-<effort>-fast`), never
    // the plain `<base>-fast` the CLI rejects (capture §3).
    const fastRoute = grokFastRouteId(family)
    if (fastRoute !== undefined) {
      add(fastRoute, grokEntryName(family, labels, true), grokEntryDescription(family, true))
    }
  }
  for (const raw of slugs) {
    const slug = raw.trim()
    if (slug === '' || slug.includes('[')) continue
    const route = parseGrokRoute(slug)
    if (route !== undefined && familiesByBase.has(route.base)) continue
    // Non-Grok names stay exactly as published today: the id, prettified.
    add(slug, displayName(slug), fallback ? FALLBACK_DESCRIPTION : undefined)
  }
  return models
}

function grokEntryName(family: GrokFamily, labels: ReadonlyMap<string, string> | undefined, fast: boolean): string {
  const base = baseDisplayName(family, labels)
  return fast ? `${base} Fast` : base
}

/**
 * The Fast picker route id: a captured `<base>-<effort>-fast` twin that
 * composes cleanly with every advertised effort. The plain `<base>-fast` form
 * is rejected by the CLI, so it is never advertised as an id.
 */
function grokFastRouteId(family: GrokFamily): string | undefined {
  const effort = family.fastEfforts.includes(family.defaultEffort)
    ? family.defaultEffort
    : family.fastEfforts[0]
  return effort === undefined ? undefined : `${family.base}-${effort}-fast`
}

function baseDisplayName(family: GrokFamily, labels: ReadonlyMap<string, string> | undefined): string {
  const slug = `${family.base}-${family.defaultEffort}`
  const label = labelFor(slug, labels)
  // Without a CLI label (AUTH fallback) the name comes from the family's wire
  // base, so `cursor-grok-4.6` renders as "Grok 4.6" exactly like the live path.
  if (label === undefined) return displayName(family.wireBase ?? family.base)
  const stripped = stripEffortWords(label)
  return stripped === '' ? displayName(family.wireBase ?? family.base) : stripped
}

function labelFor(id: string, labels: ReadonlyMap<string, string> | undefined): string | undefined {
  const label = labels?.get(id)
  if (label === undefined) return undefined
  const clean = cleanLabel(label)
  return clean === '' ? undefined : clean
}

/** Labels are display text only: drop zero-width spaces and collapse runs. */
function cleanLabel(label: string): string {
  return label.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
}

function stripEffortWords(label: string): string {
  let out = label.trim()
  for (const word of ['Extra High', 'Extra-High', 'Minimal', 'Medium', 'High', 'Low', 'Max', 'Off']) {
    if (out.toLowerCase().endsWith(word.toLowerCase())) {
      out = out.slice(0, out.length - word.length).trim()
      break
    }
  }
  return out
}

function grokEntryDescription(family: GrokFamily, fast: boolean): string {
  const efforts = fast ? family.fastEfforts : family.efforts
  const suffix = fast ? '-fast' : ''
  return `Cursor CLI slug form "${family.base}-<effort>${suffix}". Reasoning efforts: ${efforts.join(', ')}`
    + ' — bracketed [effort=...] overrides are rejected by the CLI, so the effort always rides an advertised slug.'
}

function displayName(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

export class CursorLlmAdapter {
  private readonly sessions = new CursorSessionRegistry();
  private catalog?: { at: number; ids: string[]; labels: Map<string, string> };

  constructor(private readonly logger?: PluginLogger) {}

  providerInfo(provider: string) {
    return { id: provider, name: provider === PROVIDER_ID ? 'Cursor' : provider }
  }

  providerRetryPolicy(_provider: string) {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string) {
    return undefined
  }

  async listModels(_provider: string): Promise<CursorModelInfo[]> {
    const probe = await probeCursorCli()
    if (!probe.bin) throw missingBinaryError()
    if (!probe.authenticated) {
      if (probe.code && probe.code !== AUTH_CODE) throw new CursorCliError(probe.error ?? probe.code, probe.code)
      this.logger?.warn?.(probe.error ?? 'cursor: agent CLI is not logged in')
      return expandModelCatalog(FALLBACK_MODEL_SLUGS, true)
    }
    try {
      const catalog = await listCursorModelCatalog(probe.bin)
      this.cacheCatalog(catalog)
      return expandModelCatalog(catalog.map((entry) => entry.id), false, this.catalog!.labels)
    } catch (error) {
      if (error instanceof CursorCliError && error.code === AUTH_CODE) {
        this.logger?.warn?.(error.message)
        return expandModelCatalog(FALLBACK_MODEL_SLUGS, true)
      }
      throw error
    }
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<CursorResolvedModelInfo> {
    const id = model.trim()
    const route = parseGrokRoute(id)
    const family = route === undefined ? undefined : grokFamilyFor(route.base, this.catalog?.ids ?? [])
    const name = this.entryName(id, route, family)
    const info: CursorResolvedModelInfo = {
      provider,
      id,
      name,
      ...family !== undefined ? { description: grokEntryDescription(family, route!.fast) } : {},
      inputModalities: ['text'],
    }
    if (route === undefined || family === undefined) return info
    const effortIds = route.fast ? family.fastEfforts : family.efforts
    if (effortIds.length === 0) return info
    const defaultEffort = effortIds.includes(family.defaultEffort) ? family.defaultEffort : effortIds[0]!
    return {
      ...info,
      reasoning: {
        efforts: effortIds.map((effortId) => ({
          id: effortId,
          name: EFFORT_NAMES[effortId] ?? effortId,
        })),
        defaultEffort,
      },
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: CursorGenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: CursorGenerateOptions): AsyncGenerator<CursorStreamChunk> {
    let turn: { plan: ReturnType<CursorSessionRegistry['plan']> } | undefined
    try {
      const probe = await probeCursorCli(options.signal)
      if (!probe.bin) throw missingBinaryError()
      if (!probe.authenticated) throw authError(probe.error)
      const vocabulary = isGrokModel(options.model)
        ? await this.grokVocabulary(probe.bin, options.signal)
        : undefined
      const wire = wireCursorModel(options.model, options.reasoningEffort, {
        vocabulary,
        liveSlugs: this.catalog?.ids ?? [],
      })
      turn = { plan: this.sessions.plan(options) }
      // t3 F2: `--resume <unknown id>` exits 0 with empty stderr and silently
      // opens a fresh chat that adopts the id, so a dead continuation cannot be
      // detected from the stream (init.session_id is the requested id either
      // way). Check the CLI's own chat store first and re-anchor with the full
      // DSH context instead of resuming a chat that no longer exists.
      if (turn.plan.session.mode === 'resume' && turn.plan.session.id !== undefined && turn.plan.reanchor) {
        if (!(await hasCursorChatStore(turn.plan.session.id))) {
          this.logger?.warn?.(
            `cursor: CLI chat "${turn.plan.session.id}" is gone; re-anchoring with the full DSH context`,
          )
          turn.plan = turn.plan.reanchor()
        }
      }
      const translator = new StreamChunkTranslator()
      let sawError: { message: string; code: string } | undefined
      for await (const event of streamAgentTurn(probe.bin, wire, turn, {
        cwd: options.cwd ?? sessionCwd(options.sessionId) ?? process.cwd(),
        signal: options.signal,
      })) {
        const failure = eventFailure(event)
        if (failure) {
          sawError = failure
          break
        }
        yield* translator.ingest(event)
      }
      yield* translator.end()
      if (options.signal?.aborted) {
        yield finishChunk('aborted', { message: 'Cursor agent CLI request aborted.', code: 'ABORTED' })
        return
      }
      if (sawError) {
        this.recoverSession(options, turn.plan)
        yield finishChunk('error', sawError)
        return
      }
      if (!translator.emittedContent) {
        this.recoverSession(options, turn.plan)
        yield finishChunk('error', {
          message: 'Cursor agent CLI completed without content.',
          code: EMPTY_RESPONSE_CODE,
        })
        return
      }
      turn.plan.commit()
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (options.signal?.aborted || isAbort(error)) {
        yield finishChunk('aborted', { message: 'Cursor agent CLI request aborted.', code: 'ABORTED' })
        return
      }
      if (turn) this.recoverSession(options, turn.plan)
      if (error instanceof CursorCliError) {
        yield finishChunk('error', error.failure)
        return
      }
      const classified = classifyCliFailure(error instanceof Error ? error.message : String(error))
      yield finishChunk('error', classified ?? {
        message: error instanceof Error ? error.message : String(error),
        code: 'UNKNOWN',
      })
    }
  }

  /** A failed continuation drops its checkpoint so the next turn re-anchors. */
  private recoverSession(
    options: CursorGenerateOptions,
    plan: ReturnType<CursorSessionRegistry['plan']>,
  ): void {
    const sessionId = options.sessionId?.trim()
    if (sessionId === undefined || sessionId === '') return
    if (plan.session.mode === 'resume') this.sessions.forget(sessionId)
  }

  private entryName(
    id: string,
    route: ReturnType<typeof parseGrokRoute>,
    family: GrokFamily | undefined,
  ): string {
    if (route !== undefined && family !== undefined) {
      // A Grok route is named for its family, not for the effort its id encodes
      // (the effort is the separate DSH control).
      if (route.fast) return `${baseDisplayName(family, this.catalog?.labels)} Fast`
      if (route.effort === undefined) return baseDisplayName(family, this.catalog?.labels)
    }
    return labelFor(id, this.catalog?.labels) ?? displayName(id)
  }

  /** Slugs the CLI advertises right now, plus the captured Grok vocabulary. */
  private async grokVocabulary(bin: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
    const cached = this.catalog
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return grokSlugVocabulary(cached.ids)
    try {
      const catalog = await listCursorModelCatalog(bin, signal)
      this.cacheCatalog(catalog)
      return grokSlugVocabulary(catalog.map((entry) => entry.id))
    } catch (error) {
      if (isAbort(error) || signal?.aborted) throw error
      this.logger?.warn?.(
        `cursor: model catalog unavailable (${error instanceof Error ? error.message : String(error)});`
        + ' validating Grok routes against the captured catalog',
      )
      return grokSlugVocabulary([])
    }
  }

  private cacheCatalog(entries: readonly CursorCatalogEntry[]): void {
    const labels = new Map<string, string>()
    for (const entry of entries) {
      if (entry.label !== undefined) labels.set(entry.id, entry.label)
    }
    this.catalog = { at: Date.now(), ids: entries.map((entry) => entry.id), labels }
  }
}

function eventFailure(event: AgentStreamEvent): { message: string; code: string } | undefined {
  if (event.type !== 'error') return undefined
  return classifyCliFailure(event.error) ?? { message: event.error, code: 'UNKNOWN' }
}

function finishChunk(
  kind: 'error' | 'aborted',
  failure: { message: string; code: string },
): CursorStreamChunk {
  return { type: 'finish', reason: { kind, failure } }
}

/**
 * Transcript hygiene: assistant text becomes one text block, `thinking` deltas
 * become one reasoning block, and a terminal finish closes the turn.
 * `result.result` is appended only when nothing streamed, so the CLI's
 * concatenated summary never duplicates streamed text.
 */
class StreamChunkTranslator {
  private text = '';
  private reasoning = '';
  private textOpen = false;
  private reasoningOpen = false;
  private nextIndex = 0;
  private textIndex = 0;
  private reasoningIndex = 1;
  private turnText = '';
  emittedContent = false;

  *ingest(event: AgentStreamEvent): Generator<CursorStreamChunk> {
    if (event.type === 'tool') {
      // A tool call ends the CLI's text turn without ending the DSH message.
      this.turnText = ''
      return
    }
    if (event.type === 'reasoning' && event.text) {
      yield* this.append('reasoning', event.text)
      return
    }
    if (event.type === 'text' && event.text) {
      // `--stream-partial-output` streams deltas and then repeats the whole
      // turn as one full block; that recap is not new content.
      if (this.turnText !== '' && event.text === this.turnText) {
        this.turnText = ''
        return
      }
      this.turnText += event.text
      yield* this.append('text', event.text)
      return
    }
    if (event.type === 'result' && event.text !== undefined) {
      if (this.text === '') yield* this.append('text', event.text)
      else if (event.text.startsWith(this.text)) yield* this.append('text', event.text.slice(this.text.length))
    }
  }

  *end(): Generator<CursorStreamChunk> {
    if (this.reasoningOpen) {
      yield { type: 'block-end', index: this.reasoningIndex, block: { type: 'reasoning', text: this.reasoning } }
      this.reasoningOpen = false
    }
    if (this.textOpen) {
      yield { type: 'block-end', index: this.textIndex, block: { type: 'text', text: this.text } }
      this.textOpen = false
    }
  }

  private *append(kind: 'text' | 'reasoning', incoming: string): Generator<CursorStreamChunk> {
    if (incoming === '') return
    const current = kind === 'text' ? this.text : this.reasoning
    const delta = incoming.startsWith(current) ? incoming.slice(current.length) : incoming
    if (delta === '') return
    if (kind === 'text') {
      if (!this.textOpen) {
        this.textIndex = this.nextIndex++
        this.textOpen = true
        yield { type: 'block-start', index: this.textIndex, blockType: 'text' }
      }
      this.text += delta
      this.emittedContent = true
      yield { type: 'text-delta', index: this.textIndex, text: delta }
      return
    }
    if (!this.reasoningOpen) {
      this.reasoningIndex = this.nextIndex++
      this.reasoningOpen = true
      yield { type: 'block-start', index: this.reasoningIndex, blockType: 'reasoning' }
    }
    this.reasoning += delta
    this.emittedContent = true
    yield { type: 'reasoning-delta', index: this.reasoningIndex, text: delta }
  }
}

export interface LlmLike {
  registerAdapter(providers: string[], adapter: CursorLlmAdapter): { replace?: (providers: string[]) => void } | void
  registerConfigurableProviders?: (entries: Array<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
    error?: string
  }>) => { replace?: (entries: unknown[]) => void } | void
}

export function registerCursorAdapter(host: HostContext, logger: PluginLogger): void {
  const llm = host.get('llm') as LlmLike | undefined
  if (!llm || typeof llm.registerAdapter !== 'function') {
    logger.warn?.('cursor: ctx.llm is missing; model routes not registered')
    return
  }
  llm.registerAdapter([PROVIDER_ID], new CursorLlmAdapter(logger))
  host.on('agent/session-start', (payload: { agent?: { session?: { id?: unknown; header?: { cwd?: string } } } }) => {
    noteSessionCwd(payload.agent?.session?.id, payload.agent?.session?.header?.cwd)
  })
  host.on('agent/disposed', (payload: { agent?: { session?: { id?: unknown } } }) => {
    forgetSessionCwd(payload.agent?.session?.id)
  })
  const directory = {
    provider: PROVIDER_ID,
    displayName: 'Cursor',
    settingsNs: 'dsh-cursor',
    settingsPath: ['cursor'] as const,
    declared: false as const,
  }
  let handle: { replace?: (entries: unknown[]) => void } | void
  if (typeof llm.registerConfigurableProviders === 'function') {
    handle = llm.registerConfigurableProviders([directory])
    void probeCursorCli().then((probe) => {
      if (!probe.error || typeof handle?.replace !== 'function') return
      handle.replace([{ ...directory, error: probe.error }])
    }).catch((error) => {
      logger.warn?.(`cursor: CLI probe failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  logger.info?.('cursor: LLM adapter registered for provider "cursor"')
}

export function isCursorGenerateOptions(value: unknown): value is CursorGenerateOptions {
  return isPlainObject(value) && typeof value.provider === 'string' && typeof value.model === 'string'
}

export { renderAgentContext }
