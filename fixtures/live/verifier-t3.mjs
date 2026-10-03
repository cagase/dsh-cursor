#!/usr/bin/env node
/**
 * t3 verification harness (verifier-owned; NOT a product deliverable).
 *
 * Independently re-derives the t2 acceptance criteria from the raw captures in
 * fixtures/live/ and drives the BUILT adapter (lib/models/*.js) end-to-end
 * through a fake `agent` CLI so the exact argv and the consumer-visible chunks
 * are observed rather than inferred from source.
 *
 * Usage: node fixtures/live/verifier-t3.mjs [--only=C11a,C11c]
 *        VERIFIER_LIB=<dir> selects the lib/ tree under test (default repo lib/)
 *        (VERIFIER_LIB is how the pre-repair baseline at /tmp/dsh-cursor-lib-backup
 *         is run through the very same checks: a check that does not fail there
 *         cannot be credited with catching the defect.)
 * Writes: fixtures/live/verifier-t3-output.txt (raw evidence log)
 *         fixtures/live/verifier-artifacts/*.txt (argv logs + chunk dumps)
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const LIB = process.env.VERIFIER_LIB?.trim() ? process.env.VERIFIER_LIB.trim() : join(repo, 'lib')
const ART = join(here, 'verifier-artifacts')
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg === undefined ? undefined : new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
rmSync(ART, { recursive: true, force: true })
mkdirSync(ART, { recursive: true })

const grok = await import(join(LIB, 'models/grok.js'))
const cli = await import(join(LIB, 'models/cli.js'))
const sess = await import(join(LIB, 'models/session.js'))
const adap = await import(join(LIB, 'models/adapter.js'))

// Independently derived from the live capture, NOT imported from the product:
// the CLI accepts a version-4 UUID with RFC 4122 variant bits.
const UUID4_SELF = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const log = []
const checks = []
function out(line = '') {
  log.push(line)
  console.log(line)
}
function check(id, criterion, fn) {
  if (ONLY !== undefined && !ONLY.has(id)) return false
  let ok = false
  let evidence = ''
  try {
    const r = fn()
    ok = r === true || r === undefined ? true : Boolean(r && r.ok)
    evidence = typeof r === 'object' && r !== null && 'evidence' in r ? String(r.evidence) : ''
  } catch (error) {
    ok = false
    evidence = `THREW ${error && error.stack ? error.stack.split('\n')[0] : error}`
  }
  checks.push({ id, criterion, ok, evidence })
  out(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${criterion}`)
  if (evidence) out(`      ${evidence.replace(/\n/g, '\n      ')}`)
  return ok
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- fixtures ---
const F = (name) => readFileSync(join(here, name), 'utf8')

function parseCatalog() {
  const entries = []
  for (const raw of F('models.txt').split('\n')) {
    const line = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    if (line === '' || line.startsWith('#') || line.startsWith('Tip:')) continue
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._:+-]*)\s+-\s+(\S.*)$/)
    if (m) entries.push({ id: m[1], label: m[2] })
  }
  return entries
}
const catalog = parseCatalog()
const catalogIds = catalog.map((e) => e.id)
const labels = new Map(catalog.map((e) => [e.id, e.label]))

function parseWireMatrix() {
  const blocks = []
  for (const part of F('wire-matrix.txt').split(/^=+ MODEL: /m).slice(1)) {
    const lines = part.split('\n')
    const model = lines[0].trim()
    const exitM = part.match(/^exit=(-?\d+)/m)
    const stderrIdx = lines.findIndex((l) => l.trim() === '--- stderr ---')
    const stderr = stderrIdx === -1 ? '' : lines.slice(stderrIdx + 1).join('\n')
    blocks.push({ model, exit: exitM ? Number(exitM[1]) : NaN, stderr })
  }
  return blocks
}
const wire = parseWireMatrix()
const wireAccepted = new Set(wire.filter((b) => b.exit === 0).map((b) => b.model))
const wireRejected = new Set(wire.filter((b) => b.exit !== 0).map((b) => b.model))

const GROK_BASES = ['grok-4.7', 'cursor-grok-4.6', 'cursor-grok-4.5']
// The contract's own canonical level order (section 2 of the t2 description):
// low, medium, high, xhigh. Every comparison below is order-sensitive.
const LEVEL_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max']
const byLevel = (a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b)
function catalogEfforts(base, fast) {
  const out = []
  for (const id of catalogIds) {
    if (!id.startsWith(`${base}-`)) continue
    const rest = id.slice(base.length + 1)
    if (fast) {
      if (rest.endsWith('-fast')) out.push(rest.slice(0, -5))
    } else if (!rest.endsWith('-fast')) out.push(rest)
  }
  return [...new Set(out)].sort(byLevel)
}
const derivedMatrix = Object.fromEntries(GROK_BASES.map((b) => [b, {
  efforts: catalogEfforts(b, false),
  fastEfforts: catalogEfforts(b, true),
}]))
const nonGrokIds = catalogIds.filter((id) => !/^(?:cursor-)?grok(?:$|-)/.test(id))

// accepted universe = the CLI's own advertised ids + wire-accepted strings + bare bases.
const acceptedUniverse = new Set([...catalogIds, ...wireAccepted, 'grok-4.7', 'grok-4.6', 'grok-4.5'])

// ------------------------------------------------ the adapter under test ----
const fakeAgent = join(here, 'verifier-fake-agent.sh')
chmodSync(fakeAgent, 0o755)
process.env.CURSOR_AGENT_BIN = fakeAgent
process.env.VERIFIER_MODELS = join(here, 'models.txt')
delete process.env.CURSOR_API_KEY
delete process.env.CURSOR_AUTH_TOKEN

const quiet = { info() {}, warn() {} }
let argvSeq = 0
function newAdapter() {
  return new adap.CursorLlmAdapter(quiet)
}
/**
 * Point one scenario at its own scratch chat store and stand-in CLI.
 *
 * The stand-in enforces the two live rules by default (UUIDv4 `--new-session-id`
 * and a `--resume` that silently adopts an unknown id). CURSOR_CHATS_DIR is what
 * the built adapter's pre-flight reads; VERIFIER_CHATS_DIR is what the stand-in
 * writes. They must be the same directory for a scenario to be meaningful.
 */
function withFake(env) {
  argvSeq += 1
  const tag = env.tag
  const chatsDir = join(ART, `chats-${String(argvSeq).padStart(2, '0')}-${tag}`)
  rmSync(chatsDir, { recursive: true, force: true })
  mkdirSync(chatsDir, { recursive: true })
  const argvLog = join(ART, `argv-${String(argvSeq).padStart(2, '0')}-${tag}.jsonl`)
  const stateLog = join(ART, `state-${String(argvSeq).padStart(2, '0')}-${tag}.jsonl`)
  const applied = {
    VERIFIER_ARGV_LOG: argvLog,
    VERIFIER_STATE_LOG: stateLog,
    VERIFIER_CHATS_DIR: chatsDir,
    CURSOR_CHATS_DIR: chatsDir,
    VERIFIER_REPLAY: '',
    VERIFIER_MODE: 'normal',
    VERIFIER_EXIT: '0',
    VERIFIER_STDERR: '',
    ...env,
  }
  const prev = {}
  for (const [k, v] of Object.entries(applied)) {
    prev[k] = process.env[k]
    if (v === undefined || v === '') delete process.env[k]
    else process.env[k] = String(v)
  }
  return {
    argvLog,
    chatsDir,
    /** Does the stand-in's own store hold a chat for this id right now? */
    storeHas(id) {
      return readdirSync(chatsDir).some((ws) => existsSync(join(chatsDir, ws, id)))
    },
    storePath(id) {
      const ws = readdirSync(chatsDir)[0]
      return ws === undefined ? undefined : join(chatsDir, ws, id)
    },
    deleteStore(id) {
      let removed = false
      for (const ws of readdirSync(chatsDir)) {
        const p = join(chatsDir, ws, id)
        if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); removed = true }
      }
      return removed
    },
    readState() {
      if (!existsSync(stateLog)) return []
      const text = readFileSync(stateLog, 'utf8').trim()
      return text === '' ? [] : text.split('\n').map((l) => JSON.parse(l))
    },
    readArgvs() {
      // No file at all means the CLI was never spawned (e.g. pre-aborted signal).
      if (!existsSync(argvLog)) return []
      const text = readFileSync(argvLog, 'utf8').trim()
      return text === '' ? [] : text.split('\n').map((l) => JSON.parse(l))
    },
    restore() {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
    },
  }
}
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function chunkTypes(chunks) { return chunks.map((c) => c.type) }
function textOf(chunks) { return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') }
function reasoningOf(chunks) { return chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('') }
function finishes(chunks) { return chunks.filter((c) => c.type === 'finish') }

function dumpChunks(tag, chunks) {
  const p = join(ART, `chunks-${tag}.txt`)
  writeFileSync(p, chunks.map((c) => JSON.stringify(c)).join('\n') + '\n')
  return p
}

// Independent transcript expectation from a raw stream-json capture:
// assistant text with the CLI's own post-tool recap removed, thinking deltas joined.
function parseStream(name) {
  const events = []
  for (const raw of F(name).split('\n')) {
    if (raw.trim() === '') continue
    try { events.push(JSON.parse(raw)) } catch { events.push({ type: '<nonjson>', raw }) }
  }
  const assistant = events.filter((e) => e.type === 'assistant')
    .map((e) => (e.message?.content ?? []).map((b) => b.text ?? '').join(''))
  let turn = ''; let expectedText = ''
  for (const t of assistant) { if (turn !== '' && t === turn) { turn = ''; continue } turn += t; expectedText += t }
  const thinking = events.filter((e) => e.type === 'thinking' && e.subtype === 'delta').map((e) => e.text).join('')
  const result = events.find((e) => e.type === 'result')?.result
  const userTexts = events.filter((e) => e.type === 'user')
    .map((e) => (e.message?.content ?? []).map((b) => b.text ?? '').join(''))
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  return { events, expectedText: expectedText === '' ? (result ?? '') : expectedText, thinking, result, userTexts, init }
}

async function replay(tag, fixture, options = {}) {
  const fake = withFake({ tag, VERIFIER_REPLAY: join(here, fixture), ...options.env })
  try {
    const adapter = newAdapter()
    const chunks = await collect(adapter, {
      provider: 'cursor',
      model: options.model ?? 'grok-4.7',
      ...options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {},
      messages: options.messages ?? [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      ...options.system ? { system: options.system } : {},
      ...options.sessionId ? { sessionId: options.sessionId } : {},
      ...options.signal ? { signal: options.signal } : {},
    })
    return { chunks, argvs: fake.readArgvs(), argvLog: fake.argvLog, adapter }
  } finally {
    fake.restore()
  }
}

const allowedChunkTypes = new Set(['block-start', 'text-delta', 'reasoning-delta', 'block-end', 'finish'])

function hygiene(bundle, parsed, tag) {
  const { chunks } = bundle
  const problems = []
  const badType = chunks.find((c) => !allowedChunkTypes.has(c.type))
  if (badType) problems.push(`unexpected chunk type ${JSON.stringify(badType)}`)
  const fin = finishes(chunks)
  if (fin.length !== 1) problems.push(`expected exactly 1 finish, got ${fin.length}`)
  else if (fin[0].reason?.kind !== 'stop') problems.push(`finish kind ${fin[0].reason?.kind}`)
  for (const c of chunks) {
    if (c.type === 'block-start' && c.blockType !== 'text' && c.blockType !== 'reasoning') problems.push('bad blockType')
    if (c.type === 'block-end' && c.block?.type !== 'text' && c.block?.type !== 'reasoning') problems.push('bad block type')
  }
  const t = textOf(chunks)
  const r = reasoningOf(chunks)
  if (t !== parsed.expectedText) problems.push(`emitted text != independently derived recap-deduped assistant text\n  got: ${JSON.stringify(t)}\n  exp: ${JSON.stringify(parsed.expectedText)}`)
  if (parsed.thinking !== '' && r !== parsed.thinking) problems.push(`reasoning != joined thinking deltas\n  got: ${JSON.stringify(r)}\n  exp: ${JSON.stringify(parsed.thinking)}`)
  if (parsed.result !== undefined && parsed.result !== '' && !t.includes(parsed.result) && parsed.expectedText === parsed.result) {
    problems.push('result text absent from emitted text')
  }
  const forbidden = [...parsed.userTexts, parsed.init?.model, parsed.init?.cwd, parsed.init?.session_id].filter((s) => typeof s === 'string' && s.length > 3)
  for (const toolCall of parsed.events.filter((e) => e.type === 'tool_call' || e.type === 'tool_use')) {
    if (typeof toolCall.call_id === 'string') forbidden.push(toolCall.call_id)
    const tc = toolCall.tool_call
    if (tc && typeof tc === 'object') {
      for (const v of Object.values(tc)) {
        const id = v?.args?.toolCallId
        if (typeof id === 'string') forbidden.push(id)
      }
    }
  }
  for (const s of forbidden) {
    const hits = []
    if (t.includes(s)) hits.push('text')
    if (r.includes(s)) hits.push('reasoning')
    if (hits.length) problems.push(`prompt-echo/init content leaked into ${hits.join('+')}: ${JSON.stringify(s.slice(0, 80))}`)
  }
  if (parsed.result && countOccurrences(t, parsed.result) > 1) problems.push(`result duplicated ${countOccurrences(t, parsed.result)}x`)
  writeFileSync(join(ART, `hygiene-${tag}.txt`), problems.length ? problems.join('\n') : 'CLEAN\n')
  return problems
}
const countOccurrences = (hay, needle) => (needle === '' ? 0 : hay.split(needle).length - 1)

// ================================================================== CHECKS ===
out(`t3 verification — ${new Date().toISOString()}`)
out(`repo=${repo}`)
out(`catalog ids=${catalogIds.length} nonGrok=${nonGrokIds.length} wireCases=${wire.length}`)
out(`independent Grok matrix from models.txt: ${JSON.stringify(derivedMatrix)}`)
out('')

// ---- C1: Grok catalog -------------------------------------------------------
const pickerLive = adap.expandModelCatalog(catalogIds, false, labels)
const pickerFallback = adap.expandModelCatalog(cli.FALLBACK_MODEL_SLUGS, true)
const grokPicker = (models) => models.filter((m) => grok.isGrokModel(m.id))
const EXPECTED_GROK_IDS = [
  'grok-4.7', 'grok-4.7-high-fast',
  'cursor-grok-4.6', 'cursor-grok-4.6-high-fast',
  'cursor-grok-4.5', 'cursor-grok-4.5-high-fast',
]

// resolveModel() is async: resolve every picker id once, up front, so the checks
// below assert on real resolved objects rather than Promises.
const liveResolver = new adap.CursorLlmAdapter(quiet)
const fallbackResolver = new adap.CursorLlmAdapter(quiet)
const resolved = { live: new Map(), fallback: new Map(), nonGrok: new Map() }
for (const m of grokPicker(pickerLive)) resolved.live.set(m.id, await liveResolver.resolveModel('cursor', m.id))
for (const m of grokPicker(pickerFallback)) resolved.fallback.set(m.id, await fallbackResolver.resolveModel('cursor', m.id))
for (const id of nonGrokIds) resolved.nonGrok.set(id, await liveResolver.resolveModel('cursor', id))

check('C1a', 'picker Grok routes are exactly the 6 evidence-backed ids', () => {
  const got = grokPicker(pickerLive).map((m) => m.id)
  return { ok: eq(got, EXPECTED_GROK_IDS), evidence: `got=${JSON.stringify(got)} exp=${JSON.stringify(EXPECTED_GROK_IDS)}` }
})

check('C1b', 'no invented id: no bare <base>-fast, no grok max/minimal/xhigh-for-4.5 entry', () => {
  const bad = pickerLive.map((m) => m.id).filter((id) => /^((?:cursor-)?grok-[\d.]+)-fast$/.test(id)
    || (grok.isGrokModel(id) && /-(max|minimal)$/.test(id))
    || id === 'cursor-grok-4.5-xhigh' || id === 'cursor-grok-4.5-xhigh-fast')
  return { ok: bad.length === 0, evidence: `offending=${JSON.stringify(bad)}` }
})

check('C1c', 'resolveModel efforts equal the catalog-derived matrix for both live and fallback paths', () => {
  const problems = []
  for (const tag of ['live', 'fallback']) {
    for (const base of GROK_BASES) {
      for (const fast of [false, true]) {
        const routeId = fast ? `${base}-high-fast` : base
        const r = resolved[tag].get(routeId)
        const exp = {
          live: fast ? derivedMatrix[base].fastEfforts : derivedMatrix[base].efforts,
          fallback: fast ? grok.GROK_CAPTURE_FAMILIES.find((f) => f.base === base).fastEfforts
            : grok.GROK_CAPTURE_FAMILIES.find((f) => f.base === base).efforts,
        }[tag]
        const got = (r?.reasoning?.efforts ?? []).map((e) => e.id)
        if (!eq(got, exp)) problems.push(`${tag} ${routeId}: got ${JSON.stringify(got)} exp ${JSON.stringify(exp)}`)
        if (r?.reasoning?.defaultEffort !== 'high') problems.push(`${tag} ${routeId}: defaultEffort=${r?.reasoning?.defaultEffort}`)
      }
    }
  }
  const models = new Set(pickerLive.map((m) => m.id))
  const missing = [...new Set(EXPECTED_GROK_IDS)].filter((id) => !models.has(id))
  if (missing.length) problems.push(`missing picker ids ${JSON.stringify(missing)}`)
  return { ok: problems.length === 0, evidence: problems.length ? problems.join('; ') : 'live+fallback matrices match section 2 order; defaultEffort=high on all 12 route/path combos' }
})

check('C1d', 'every advertised Fast route id is a real captured catalog slug (and not the rejected plain -fast)', () => {
  const fast = grokPicker(pickerLive).filter((m) => m.id.endsWith('-fast'))
  const problems = fast.filter((m) => !catalogIds.includes(m.id)).map((m) => `${m.id} not in catalog`)
  const plain = 'grok-4.7-fast'
  if (wireRejected.has(plain) === false) problems.push(`${plain} unexpectedly not in rejected wire set`)
  return { ok: problems.length === 0, evidence: `fast=${JSON.stringify(fast.map((m) => m.id))} ; ${plain} rejected per wire-matrix=${wireRejected.has(plain)}` }
})

check('C1e', 'display names carry no U+200B/U+200C/U+200D/U+FEFF and Grok names are family names + " Fast"', () => {
  const bad = pickerLive.filter((m) => /[\u200B-\u200D\uFEFF]/.test(m.name)).map((m) => m.id)
  const names = Object.fromEntries(grokPicker(pickerLive).map((m) => [m.id, m.name]))
  const exp = {
    'grok-4.7': 'Grok 4.7', 'grok-4.7-high-fast': 'Grok 4.7 Fast',
    'cursor-grok-4.6': 'Grok 4.6', 'cursor-grok-4.6-high-fast': 'Grok 4.6 Fast',
    'cursor-grok-4.5': 'Grok 4.5', 'cursor-grok-4.5-high-fast': 'Grok 4.5 Fast',
  }
  return { ok: bad.length === 0 && eq(names, exp), evidence: `zero-width offenders=${JSON.stringify(bad)} names=${JSON.stringify(names)} exp=${JSON.stringify(exp)}` }
})

check('C1f', 'AUTH fallback picker advertises the same 6 Grok routes and never a fabricated one', () => {
  const got = grokPicker(pickerFallback).map((m) => m.id)
  const names = Object.fromEntries(grokPicker(pickerFallback).map((m) => [m.id, m.name]))
  return { ok: eq(got, EXPECTED_GROK_IDS) && pickerFallback.length === 8, evidence: `fallbackGrokIds=${JSON.stringify(got)} fallbackTotal=${pickerFallback.length} names=${JSON.stringify(names)}` }
})

check('C2g', 'capture cross-check: every wire-matrix case that is a catalog id was accepted, and the only accepted non-catalog strings are the bare bases + byte-identical bracket forms', () => {
  const wronglyRejected = wire.filter((b) => catalogIds.includes(b.model) && b.exit !== 0).map((b) => b.model)
  const acceptedUnlisted = wireAccepted.has(undefined) ? [] : [...wireAccepted].filter((m) => !catalogIds.includes(m))
  const unexpected = acceptedUnlisted.filter((m) => !(m.includes('[') || GROK_BASES.includes(m) || ['grok-4.6', 'grok-4.5'].includes(m)))
  return {
    ok: wronglyRejected.length === 0 && unexpected.length === 0,
    evidence: `wireCases=${wire.length} accepted=${wireAccepted.size} rejected=${wireRejected.size}\ncatalogIds rejected live=${JSON.stringify(wronglyRejected)}\naccepted-but-unlisted (${acceptedUnlisted.length})=${JSON.stringify(acceptedUnlisted)}\nunexpected=${JSON.stringify(unexpected)}`,
  }
})


// ---- C2: wire strings -------------------------------------------------------
check('C2a', 'every advertised (Grok route, effort) pair composes a wire string inside the captured accepted set', () => {
  const problems = []
  let pairs = 0
  for (const m of grokPicker(pickerLive)) {
    const info = resolved.live.get(m.id)
    const efforts = [...(info?.reasoning?.efforts ?? []).map((e) => e.id), undefined]
    for (const effort of efforts) {
      pairs += 1
      let wireStr
      try {
        wireStr = cli.wireCursorModel(m.id, effort)
      } catch (error) {
        problems.push(`${m.id} @ ${effort}: threw ${error.message}`)
        continue
      }
      if (!acceptedUniverse.has(wireStr)) problems.push(`${m.id} @ ${effort} -> ${wireStr} NOT accepted`)
      if (wireRejected.has(wireStr)) problems.push(`${m.id} @ ${effort} -> ${wireStr} REJECTED live`)
    }
  }
  return { ok: problems.length === 0, evidence: `${pairs} pairs checked; acceptedUniverse=${acceptedUniverse.size} strings; problems=${problems.length ? problems.join('; ') : 'none'}` }
})

check('C2b', 'cursor- prefix rule: cursor-grok-4.6-xhigh accepted in wire form, grok-4.6-xhigh rejected and never composed', () => {
  const evidence = []
  const a = cli.wireCursorModel('cursor-grok-4.6', 'xhigh')
  evidence.push(`cursor-grok-4.6@xhigh -> ${a} (accepted=${acceptedUniverse.has(a)}, rejected=${wireRejected.has(a)})`)
  let b = '(no throw)'
  let code = '(none)'
  try { b = cli.wireCursorModel('grok-4.6', 'xhigh') } catch (e) { b = `threw ${e.message}`; code = e.code }
  evidence.push(`grok-4.6@xhigh -> ${b} code=${code}`)
  const rejectedEvidence = 'grok-4.6-xhigh' in Object.fromEntries(wire.map((w) => [w.model, w.exit]))
  evidence.push(`wire-matrix has grok-4.6-xhigh exit=${Object.fromEntries(wire.map((w) => [w.model, w.exit]))['grok-4.6-xhigh']}; cursor form accepted live=${wireAccepted.has('cursor-grok-4.6-xhigh')}`)
  const ok = a === 'cursor-grok-4.6-xhigh' && code === cli.INVALID_ARGS_CODE && !b.includes('grok-4.6-xhigh]') && b !== 'grok-4.6-xhigh' && rejectedEvidence
  return { ok, evidence: evidence.join('\n') }
})

check('C2c', 'cursor-grok-4.5 xhigh (rejected live) fails with INVALID_ARGS instead of guessing', () => {
  let msg = '(no throw)'
  let code = '(none)'
  try { cli.wireCursorModel('cursor-grok-4.5', 'xhigh') } catch (e) { msg = e.message; code = e.code }
  const rejectedLive = wireRejected.has('cursor-grok-4.5-xhigh') || wireRejected.has('cursor-grok-4.5-xhigh-fast')
  return { ok: code === cli.INVALID_ARGS_CODE && rejectedLive, evidence: `code=${code} msg=${msg}\nrejected in capture=${rejectedLive}` }
})

check('C2d', 'no advertised pair ever produces a bracketed override', () => {
  const adapter = new adap.CursorLlmAdapter(quiet)
  const bad = []
  for (const m of grokPicker(pickerLive)) {
    for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh']) {
      try { const w = cli.wireCursorModel(m.id, effort); if (w.includes('[')) bad.push(`${m.id}@${effort} -> ${w}`) } catch { /* unadvertised level is fine */ }
    }
  }
  return { ok: bad.length === 0, evidence: bad.length ? bad.join('; ') : 'zero bracket strings across 30 compositions' }
})

check('C2e', 'Fast routes compose a real captured twin for every advertised level (no fallback to the base)', () => {
  const problems = []
  for (const base of GROK_BASES) {
    const routeId = `${base}-high-fast`
    const info = resolved.live.get(routeId)
    if (info?.reasoning?.defaultEffort !== 'high') problems.push(`${routeId} default effort ${info?.reasoning?.defaultEffort}`)
    const dflt = cli.wireCursorModel(routeId, info?.reasoning?.defaultEffort)
    if (dflt !== routeId) problems.push(`${routeId} default -> ${dflt}`)
    for (const e of (info?.reasoning?.efforts ?? []).map((x) => x.id)) {
      const w = cli.wireCursorModel(routeId, e)
      if (w !== `${base}-${e}-fast`) problems.push(`${routeId}@${e} -> ${w}`)
      if (!acceptedUniverse.has(w)) problems.push(`${routeId}@${e} -> ${w} not accepted`)
    }
  }
  return { ok: problems.length === 0, evidence: problems.length ? problems.join('; ') : 'all 3 Fast routes: default High, every level -> <base>-<level>-fast accepted' }
})

check('C2f', 'accepted bare bases from the live capture are what the vocabulary advertises', () => {
  const rejects = ['grok-4.7[effort=max]', 'grok-4.7[effort=high]', 'grok-4.7[reasoning_effort=xhigh]', 'grok-4.7-max', 'grok-4.7-minimal', 'grok-4.7-fast']
  const allRejected = rejects.filter((r) => wireRejected.has(r))
  const bareAccepted = ['grok-4.7', 'grok-4.6', 'grok-4.5'].filter((b) => wireAccepted.has(b))
  const vocab = grok.grokSlugVocabulary(catalogIds)
  return {
    ok: allRejected.length === rejects.length && bareAccepted.length === 3 && vocab.has('grok-4.7-high') && vocab.has('cursor-grok-4.6-xhigh') && vocab.has('grok-4.5') && !vocab.has('grok-4.7-fast') && !vocab.has('grok-4.7-max'),
    evidence: `rejected-in-capture=${JSON.stringify(allRejected)} accepted-bare=${JSON.stringify(bareAccepted)} vocabSize=${vocab.size} hasPlainFast=${vocab.has('grok-4.7-fast')} hasMax=${vocab.has('grok-4.7-max')}`,
  }
})

// ---- C3: bracket passthrough ------------------------------------------------
check('C3a', 'caller-supplied bracketed ids pass through byte-identical (effort ignored)', () => {
  const cases = ['grok-4.7[effort=max]', 'grok-4.7[effort=high]', 'grok-4.7[reasoning_effort=high]', 'grok-4.7[context=256k,reasoning_effort=xhigh,fast=false]', 'claude-opus-4-8[context=1m,effort=high,fast=false]']
  const bad = []
  for (const c of cases) {
    for (const effort of [undefined, 'high', 'max']) {
      const got = cli.wireCursorModel(c, effort)
      if (got !== c) bad.push(`${JSON.stringify(c)} @ ${effort} -> ${JSON.stringify(got)}`)
    }
  }
  return { ok: bad.length === 0, evidence: bad.length ? bad.join('; ') : `15 passthrough calls byte-identical (incl. the captured accepted form and the old failing ${JSON.stringify('grok-4.7[effort=max]')})` }
})

check('C3b', 'a requested pair with no advertised slug fails INVALID_ARGS (never guesses), and no rejected capture string is producible', () => {
  const problems = []
  for (const [model, effort] of [['grok-4.7', 'max'], ['grok-4.7', 'minimal'], ['grok-4.7', 'none'], ['cursor-grok-4.5', 'xhigh']]) {
    let code = '(none)'
    try { cli.wireCursorModel(model, effort) } catch (e) { code = e.code }
    if (code !== cli.INVALID_ARGS_CODE) problems.push(`${model}@${effort} code=${code}`)
  }
  // every rejected live wire string must not be reachable from a plausible (base, effort) request
  const reachable = new Set()
  for (const base of [...GROK_BASES, 'grok-4.6', 'grok-4.5']) {
    for (const eff of [undefined, 'low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'none']) {
      for (const fast of [false, true]) {
        try { reachable.add(cli.wireCursorModel(fast ? `${base}-high-fast` : base, eff)) } catch { /* expected for unadvertised */ }
      }
    }
  }
  const leaked = [...wireRejected].filter((r) => reachable.has(r))
  if (leaked.length) problems.push(`rejected strings reachable: ${JSON.stringify(leaked)}`)
  return { ok: problems.length === 0, evidence: `unadvertised levels all INVALID_ARGS; rejected-capture leakage=${JSON.stringify(leaked)}\nreachable=${reachable.size} of ${wireRejected.size} rejected strings` }
})

// ---- C4: non-Grok -----------------------------------------------------------
check('C4a', 'all non-Grok catalog ids stay listed verbatim in catalog order; no invented extras', () => {
  const gotNonGrok = pickerLive.filter((m) => !grok.isGrokModel(m.id)).map((m) => m.id)
  const orderOk = eq(gotNonGrok, nonGrokIds)
  const unknown = pickerLive.map((m) => m.id).filter((id) => !catalogIds.includes(id) && !EXPECTED_GROK_IDS.includes(id))
  return { ok: orderOk && unknown.length === 0 && pickerLive.length === 230, evidence: `nonGrok listed=${gotNonGrok.length}/${nonGrokIds.length} order-preserved=${orderOk} invented=${JSON.stringify(unknown)} totalPicker=${pickerLive.length}` }
})

check('C4b', 'non-Grok models get no synthetic suffix, renamed id or reasoning.efforts', () => {
  const problems = []
  for (const id of nonGrokIds) {
    if (cli.wireCursorModel(id, 'high') !== id) problems.push(`wire(${id},high) != id`)
    if (cli.wireCursorModel(id) !== id) problems.push(`wire(${id}) != id`)
    const r = resolved.nonGrok.get(id)
    if (r?.id !== id) problems.push(`resolveModel id ${r?.id}`)
    if (r?.reasoning !== undefined) problems.push(`resolveModel added reasoning to ${id}`)
  }
  return { ok: problems.length === 0, evidence: `${nonGrokIds.length * 4} assertions; ${problems.length ? problems.slice(0, 5).join('; ') : 'clean'}` }
})

// ---- C5: transcript hygiene (offline, through the built adapter) ------------
const HYGIENE_FIXTURES = [
  ['stream-json.jsonl', 'delta path (partial deltas + post-tool recap + result)'],
  ['stream-json-force.jsonl', 'delta path with two tool turns'],
  ['stream-json-nopartial.jsonl', 'single-flushed assistant block'],
]
for (const [i, [fixture, blurb]] of HYGIENE_FIXTURES.entries()) {
  const bundle = await replay(`replay${i}`, fixture)
  const parsed = parseStream(fixture)
  const problems = hygiene(bundle, parsed, `replay${i}`)
  const chunkDump = dumpChunks(`replay${i}`, bundle.chunks)
  check(`C5${'abc'[i]}`, `chunks from ${fixture} = assistant text + thinking + one stop, nothing echoed [${blurb}]`, () => ({
    ok: problems.length === 0,
    evidence: `types=${JSON.stringify(chunkTypes(bundle.chunks).slice(0, 12))}... finish=${JSON.stringify(finishes(bundle.chunks))}\ntext===${JSON.stringify(textOf(bundle.chunks))}\nreasoning===${JSON.stringify(reasoningOf(bundle.chunks))}\nchunkDump=${chunkDump}\nproblems=${problems.length ? problems.join('\n') : 'CLEAN'}`,
  }))
}

const resultOnly = 'verifier-result-only.jsonl'
{
  const bundle = await replay('resultonly', resultOnly)
  const parsed = parseStream(resultOnly)
  const problems = hygiene(bundle, parsed, 'resultonly')
  check('C5d', `single-flush fallback: ${resultOnly} (no assistant event) emits result.result exactly once`, () => ({
    ok: problems.length === 0 && textOf(bundle.chunks) === 'RESULT-ONLY-TEXT' && countOccurrences(textOf(bundle.chunks), 'RESULT-ONLY-TEXT') === 1,
    evidence: `chunks=${JSON.stringify(bundle.chunks)}\nproblems=${problems.length ? problems.join('\n') : 'CLEAN'}`,
  }))
}

check('C5e', 'interpreter unit map: system/user/retry/connection/interaction_query ignored, tool_call is a boundary, thinking is reasoning', () => {
  const map = {
    system: { type: 'system', subtype: 'init', session_id: 's' },
    user: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'echo me' }] } },
    retry: { type: 'retry', subtype: 'starting' },
    connection: { type: 'connection', subtype: 'reconnecting' },
    interaction_query: { type: 'interaction_query', question: 'pick one' },
    tool_call: { type: 'tool_call', subtype: 'started' },
    thinking: { type: 'thinking', subtype: 'delta', text: 't' },
    assistant: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
    result: { type: 'result', subtype: 'success', is_error: false, result: 'r' },
  }
  const got = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, cli.interpretAgentStreamObject(v).type]))
  const exp = { system: 'ignored', user: 'ignored', retry: 'ignored', connection: 'ignored', interaction_query: 'ignored', tool_call: 'tool', thinking: 'reasoning', assistant: 'text', result: 'result' }
  const nonJson = cli.interpretAgentStreamLine("RetriableError: [invalid_argument] unknown option '--system-prompt'").type
  return { ok: eq(got, exp) && nonJson === 'ignored', evidence: `got=${JSON.stringify(got)} exp=${JSON.stringify(exp)} nonJsonLine=${nonJson}` }
})

{
  const fixture = 'stream-json-system-prompt-failure.jsonl'
  const bundle = await replay('syspfail', fixture, { env: { VERIFIER_EXIT: '2', VERIFIER_STDERR: "RetriableError: [invalid_argument] unknown option '--system-prompt'" } })
  check('C5f', 'replay of the --system-prompt failure capture emits no content and one terminal finish', () => {
    const fin = finishes(bundle.chunks)
    const noContent = textOf(bundle.chunks) === '' && reasoningOf(bundle.chunks) === ''
    return { ok: noContent && fin.length === 1 && fin[0].reason?.kind === 'error', evidence: `chunks=${JSON.stringify(bundle.chunks)}\nnonJsonLineLeaked=${JSON.stringify(bundle.chunks).includes('RetriableError')}` }
  })
}

{
  const bundle = await replay('echoonly', 'stream-json-echo-only.jsonl')
  check('C5g', 'EMPTY_RESPONSE guard: echo-only capture yields no content chunks and one EMPTY_RESPONSE finish', () => {
    const fin = finishes(bundle.chunks)
    return { ok: bundle.chunks.length === 1 && fin.length === 1 && fin[0].reason?.kind === 'error' && fin[0].reason?.failure?.code === cli.EMPTY_RESPONSE_CODE, evidence: `chunks=${JSON.stringify(bundle.chunks)}` }
  })
}

{
  // The strongest anti-echo test: the fake CLI echoes the plugin's REAL positional
  // prompt (system + history + user turn) back as system/init + user + tool_call.
  const system = 'DSH SYSTEM PROMPT MARKER: you are a test harness.'
  const bundle = await replay('echoinject', 'stream-json-nopartial.jsonl', {
    env: { VERIFIER_MODE: 'echo' },
    system,
    sessionId: 'verifier-echo-session',
    messages: [
      { id: 'h1', role: 'user', content: [{ type: 'text', text: 'HISTORY USER MARKER' }] },
      { id: 'h2', role: 'assistant', content: [{ type: 'text', text: 'HISTORY ASSISTANT MARKER' }] },
      { id: 'h3', role: 'user', content: [{ type: 'text', text: 'CURRENT USER MARKER' }] },
    ],
  })
  const t = textOf(bundle.chunks)
  const r = reasoningOf(bundle.chunks)
  const positional = bundle.argvs.find((a) => a.includes('--print'))?.slice(-1)[0] ?? ''
  const leaked = ['dsh_system_prompt', 'dsh_conversation_history', 'dsh_user_message', 'DSH SYSTEM PROMPT MARKER', 'HISTORY USER MARKER', 'HISTORY ASSISTANT MARKER', 'User:', 'System:', 'Assistant:', 'permissionMode', 'fixture-session'].filter((s) => t.includes(s) || r.includes(s))
  writeFileSync(join(ART, 'echo-injection-positional.txt'), positional)
  check('C5h', 'the plugin-authored prompt is echoed by the CLI and still never reaches the consumer', () => {
    return { ok: t === 'VISIBLE-ASSISTANT-MARKER' && r === 'THINKING-ONLY-MARKER' && leaked.length === 0, evidence: `positional prompt (${positional.length} chars, dumped to artifacts) contained dsh_system_prompt=${positional.includes('<dsh_system_prompt>')}\nemittedText=${JSON.stringify(t)} emittedReasoning=${JSON.stringify(r)}\nleaked=${JSON.stringify(leaked)}` }
  })
}

// ---- C6: plumbing / argv ----------------------------------------------------
function argvProblems(argv, wireExpected) {
  const problems = []
  const positionals = argv.filter((a, i) => i > 0 && !a.startsWith('--') && ['--model', '--new-session-id', '--resume', '--output-format', '--workspace'].every((f) => argv[i - 1] !== f))
  if (!argv.includes('--print')) problems.push('missing --print')
  if (!argv.includes('--trust')) problems.push('missing --trust')
  if (!argv.includes('--force')) problems.push('missing --force')
  for (const banned of ['--system-prompt', '--conversation-history-file', '--exclude-workspace-context']) {
    if (argv.includes(banned)) problems.push(`contains banned ${banned}`)
  }
  if (positionals.length !== 1) problems.push(`positionals=${JSON.stringify(positionals)}`)
  if (wireExpected !== undefined && argv[argv.indexOf('--model') + 1] !== wireExpected) problems.push(`--model ${argv[argv.indexOf('--model') + 1]} != ${wireExpected}`)
  return problems
}

check('C6a', 'buildAgentArgs: --print --trust --force present, banned flags absent, exactly one positional', () => {
  const registry = new sess.CursorSessionRegistry()
  const plan = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S', system: 'SYS', messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  const argv = ['agent', ...cli.buildAgentArgs('grok-4.7-high', plan, '/ws')]
  const problems = argvProblems(argv, 'grok-4.7-high')
  return { ok: problems.length === 0, evidence: `argv=${JSON.stringify(argv)}\nproblems=${problems.length ? problems.join('; ') : 'none'}` }
})

{
  const fake = withFake({ tag: 'argv-live', VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl') })
  let bundle
  try {
    const adapter = newAdapter()
    const chunks = await collect(adapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'xhigh', sessionId: 'argv-session',
      system: 'SYS', messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    bundle = { chunks, argvs: fake.readArgvs() }
  } finally { fake.restore() }
  const printArgvs = bundle.argvs.filter((a) => a.includes('--print'))
  const problems = printArgvs.flatMap((a) => argvProblems(a, 'grok-4.7-xhigh'))
  const tempPaths = printArgvs.flat().filter((a) => a.includes(tmpdir()))
  writeFileSync(join(ART, 'argv-live.jsonl'), printArgvs.map((a) => JSON.stringify(a)).join('\n'))
  check('C6b', 'the real spawn argv (recorded by the fake CLI) uses only supported flags and the composed wire model', () => {
    return { ok: problems.length === 0 && printArgvs.length === 1 && tempPaths.length === 0, evidence: `spawnedArgv=${JSON.stringify(printArgvs[0])}\nproblems=${problems.length ? problems.join('; ') : 'none'} tempPathArgs=${JSON.stringify(tempPaths)}` }
  })
}

{
  const before = new Set(readdirSync(tmpdir()))
  const bundle = await replay('tmpcheck', 'stream-json-nopartial.jsonl', { system: 'S', sessionId: 'TS', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }] }] })
  check('C6c', 'no temp files: os.tmpdir() unchanged and no argv references one', () => {
    const after = readdirSync(tmpdir()).filter((e) => !before.has(e))
    const referenced = bundle.argvs.flat().filter((a) => typeof a === 'string' && a.includes(tmpdir()))
    return { ok: after.length === 0 && referenced.length === 0, evidence: `newTmpEntries=${JSON.stringify(after)} argvTmpRefs=${JSON.stringify(referenced)}` }
  })
}

// ---- C7: continuity ---------------------------------------------------------
function msg(id, role, text) { return { id, role, content: [{ type: 'text', text }] } }
const SYSTEM = 'DSH continuity system prompt'

check('C7a', 'one CLI chat per DSH session: bootstrap mints --new-session-id, the next turn --resume with only the newest user turn', () => {
  const registry = new sess.CursorSessionRegistry()
  const t1 = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'first question')] })
  const id1 = t1.session.id
  t1.commit()
  const t2 = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'first question'), msg('m2', 'assistant', 'answer one'), msg('m3', 'user', 'second question')] })
  const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const argv1 = cli.buildAgentArgs('grok-4.7-high', t1)
  const argv2 = cli.buildAgentArgs('grok-4.7-high', t2)
  return {
    ok: t1.session.mode === 'new' && uuidShape.test(id1) && id1 === sess.sessionUuidFor('S1#0')
      && t2.session.mode === 'resume' && t2.session.id === id1
      && argv1.includes('--new-session-id') && !argv1.includes('--resume')
      && argv2.includes('--resume') && !argv2.includes('--new-session-id')
      && t2.positional === 'second question'
      && t1.positional.includes('<dsh_system_prompt>') && t1.positional.includes('first question'),
    evidence: `id1=${id1} mode1=${t1.session.mode} mode2=${t2.session.mode} id2=${t2.session.id}\npositional1=${JSON.stringify(t1.positional)}\npositional2=${JSON.stringify(t2.positional)}\nargv2=${JSON.stringify(argv2)}`,
  }
})

check('C7b', 'a rewritten history re-anchors: fresh --new-session-id plus full DSH context', () => {
  const registry = new sess.CursorSessionRegistry()
  const t1 = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'first question')] })
  t1.commit()
  const rewritten = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m9', 'user', 'compacted question')] })
  return {
    ok: rewritten.session.mode === 'new' && rewritten.session.id !== t1.session.id && rewritten.bootstrap === true
      && rewritten.positional.includes('compacted question'),
    evidence: `id_before=${t1.session.id} id_after=${rewritten.session.id} mode=${rewritten.session.mode} positional=${JSON.stringify(rewritten.positional)}`,
  }
})

check('C7c', 'one-shot (no sessionId) and auxiliary (purpose) calls never touch the DSH session id', () => {
  const registry = new sess.CursorSessionRegistry()
  const t1 = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'q1')] })
  t1.commit()
  const oneShot = registry.plan({ provider: 'cursor', model: 'grok-4.7', system: SYSTEM, messages: [msg('x1', 'user', 'one shot')] })
  const aux = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', purpose: 'session-title', system: SYSTEM, messages: [msg('x2', 'user', 'title this')] })
  const auxCompaction = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', purpose: 'compaction', system: SYSTEM, messages: [msg('x3', 'user', 'compact')] })
  const t2 = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2')] })
  const argv = [oneShot, aux, auxCompaction].map((p) => cli.buildAgentArgs('grok-4.7-high', p))
  return {
    ok: [oneShot, aux, auxCompaction].every((p) => p.session.mode === 'none' && p.bootstrap === true)
      && argv.every((a) => !a.includes('--new-session-id') && !a.includes('--resume'))
      && t2.session.mode === 'resume' && t2.session.id === t1.session.id && t2.positional === 'q2',
    evidence: `oneShot=${oneShot.session.mode} aux=${aux.session.mode} compaction=${auxCompaction.session.mode}\nafterAux resume=${t2.session.mode} id=${t2.session.id} positional=${JSON.stringify(t2.positional)}`,
  }
})

check('C7d', 'a changed system prompt re-anchors, an unchanged one resumes', () => {
  const registry = new sess.CursorSessionRegistry()
  const t1 = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: 'A', messages: [msg('m1', 'user', 'q1')] })
  t1.commit()
  const same = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: 'A', messages: [msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a'), msg('m3', 'user', 'q2')] })
  const changed = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: 'B', messages: [msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a'), msg('m3', 'user', 'q2')] })
  return {
    ok: same.session.mode === 'resume' && changed.session.mode === 'new' && changed.session.id !== t1.session.id && changed.positional.includes('<dsh_system_prompt>'),
    evidence: `sameSystem=${same.session.mode} changedSystem=${changed.session.mode} newId=${changed.session.id} vs ${t1.session.id}`,
  }
})

check('C7e', 'a DSH retry with nothing new resumes and re-sends the last user turn without double-appending', () => {
  const registry = new sess.CursorSessionRegistry()
  const t1 = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'q1')] })
  t1.commit()
  registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2')] }).commit()
  const retry = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2')] })
  const next = registry.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'S1', system: SYSTEM, messages: [msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2'), msg('m4', 'assistant', 'a2'), msg('m5', 'user', 'q3')] })
  return {
    ok: retry.session.mode === 'resume' && retry.positional === 'q2' && next.session.mode === 'resume' && next.positional === 'q3',
    evidence: `retryPositional=${JSON.stringify(retry.positional)} nextPositional=${JSON.stringify(next.positional)} nextMode=${next.session.mode}`,
  }
})

check('C7f', 'deterministic session id: same DSH session resolves to one UUIDv4-shaped id across registry instances', () => {
  const a = new sess.CursorSessionRegistry()
  const b = new sess.CursorSessionRegistry()
  const p1 = a.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'dsh-abc', system: SYSTEM, messages: [msg('m1', 'user', 'q')] })
  const p2 = b.plan({ provider: 'cursor', model: 'grok-4.7', sessionId: 'dsh-abc', system: SYSTEM, messages: [msg('m1', 'user', 'q')] })
  const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  return { ok: p1.session.id === p2.session.id && uuidShape.test(p1.session.id), evidence: `id=${p1.session.id} other=${p2.session.id}` }
})

// ---- C7/C8 end-to-end through the real spawn --------------------------------
{
  const fake = withFake({ tag: 'continuity-live', VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl') })
  let result
  try {
    const adapter = newAdapter()
    const opts = (messages) => ({ provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'medium', sessionId: 'E2E', system: SYSTEM, messages })
    const c1 = await collect(adapter, opts([msg('m1', 'user', 'first question')]))
    const c2 = await collect(adapter, opts([msg('m1', 'user', 'first question'), msg('m2', 'assistant', 'answer one'), msg('m3', 'user', 'second question')]))
    const c3 = await collect(adapter, opts([msg('m9', 'user', 'rewritten question')]))
    const argvs = fake.readArgvs().filter((a) => a.includes('--print'))
    result = { c1, c2, c3, argvs }
  } finally { fake.restore() }
  const [a1, a2, a3] = result.argvs
  const id1 = a1[a1.indexOf('--new-session-id') + 1]
  const id3 = a3[a3.indexOf('--new-session-id') + 1]
  const problems = []
  if (!a1.includes('--new-session-id') || a1.includes('--resume')) problems.push('call1 not a new session')
  if (!a2.includes('--resume') || a2.includes('--new-session-id') || a2[a2.indexOf('--resume') + 1] !== id1) problems.push('call2 did not resume call1 id')
  if (a2.slice(-1)[0] !== 'second question') problems.push(`call2 positional ${JSON.stringify(a2.slice(-1)[0])}`)
  if (!a3.includes('--new-session-id') || id3 === id1) problems.push('call3 did not re-anchor with a fresh id')
  if (a3[a3.indexOf('--model') + 1] !== 'grok-4.7-medium') problems.push('wire model wrong')
  if (!(id1 && id3)) problems.push('missing ids')
  for (const a of result.argvs) problems.push(...argvProblems(a))
  writeFileSync(join(ART, 'continuity-e2e-argv.jsonl'), result.argvs.map((a) => JSON.stringify(a)).join('\n'))
  check('C7g', 'end-to-end via the real spawn: new → resume(same id, newest turn only) → re-anchor on rewrite', () => ({
    ok: problems.length === 0,
    evidence: `id1=${id1} id3=${id3}\nargv1=${JSON.stringify(a1)}\nargv2=${JSON.stringify(a2)}\nargv3=${JSON.stringify(a3)}\nproblems=${problems.length ? problems.join('; ') : 'none'}`,
  }))
}

{
  const fake = withFake({ tag: 'resume-dead', VERIFIER_MODE: 'fail-resume', VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl'), VERIFIER_STDERR: 'Error: Session not found' })
  let result
  try {
    const adapter = newAdapter()
    const opts = (messages) => ({ provider: 'cursor', model: 'grok-4.7', sessionId: 'DEAD', system: SYSTEM, messages })
    const c1 = await collect(adapter, opts([msg('m1', 'user', 'first question')]))
    const c2 = await collect(adapter, opts([msg('m1', 'user', 'first question'), msg('m2', 'assistant', 'a'), msg('m3', 'user', 'second question')]))
    const c3 = await collect(adapter, opts([msg('m1', 'user', 'first question'), msg('m2', 'assistant', 'a'), msg('m3', 'user', 'second question'), msg('m4', 'assistant', 'b'), msg('m5', 'user', 'third question')]))
    result = { c1, c2, c3, argvs: fake.readArgvs().filter((a) => a.includes('--print')) }
  } finally { fake.restore() }
  const turns = {
    call1: result.argvs[0],
    call2resume: result.argvs[1],
    call2recovery: result.argvs[2],
    call3: result.argvs[3],
  }
  const id1 = turns.call1?.[turns.call1.indexOf('--new-session-id') + 1]
  const recoveryId = turns.call2recovery?.[turns.call2recovery.indexOf('--new-session-id') + 1]
  const problems = []
  if (turns.call2resume?.slice(-1)[0] !== 'second question') problems.push('dead resume did not send only the newest turn')
  if (!turns.call2recovery?.includes('--new-session-id') || turns.call2recovery?.includes('--resume')) problems.push('no fresh-session recovery after a dead --resume')
  if (recoveryId === id1 || !recoveryId) problems.push('recovery reused the dead id')
  if (turns.call2recovery && (!turns.call2recovery.slice(-1)[0].includes('<dsh_system_prompt>') || !turns.call2recovery.slice(-1)[0].includes('second question'))) problems.push('recovery did not carry full DSH context')
  if (finishes(result.c2)[0]?.reason?.kind !== 'stop') problems.push(`turn2 did not complete: ${JSON.stringify(finishes(result.c2))}`)
  if (!textOf(result.c2).includes('alpha')) problems.push('turn2 lost the assistant text')
  if (turns.call3?.[turns.call3.indexOf('--resume') + 1] !== recoveryId) problems.push('call3 did not resume the recovered id')
  if (turns.call3?.slice(-1)[0] !== 'third question') problems.push(`call3 positional ${JSON.stringify(turns.call3?.slice(-1)[0])}`)
  writeFileSync(join(ART, 'resume-failure-argv.jsonl'), result.argvs.map((a) => JSON.stringify(a)).join('\n'))
  check('C7h', 'dead --resume (CLI exit 1 + "Session not found") degrades to a fresh session with full context; the turn succeeds and the next call resumes the new id', () => ({
    ok: problems.length === 0,
    evidence: `call2Resume=${JSON.stringify(turns.call2resume)}\ncall2Recovery=${JSON.stringify(turns.call2recovery)}\ncall3=${JSON.stringify(turns.call3)}\nturn2Chunks=${JSON.stringify(result.c2)}\nproblems=${problems.length ? problems.join('; ') : 'none'}`,
  }))
}

{
  const fake = withFake({ tag: 'session-in-use', VERIFIER_MODE: 'session-in-use', VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl') })
  let result
  try {
    const adapter = newAdapter()
    const c1 = await collect(adapter, { provider: 'cursor', model: 'grok-4.7', sessionId: 'INUSE', system: SYSTEM, messages: [msg('m1', 'user', 'q1')] })
    result = { c1, argvs: fake.readArgvs().filter((a) => a.includes('--print')) }
  } finally { fake.restore() }
  const [a1, a2] = result.argvs
  const id = a1?.[a1.indexOf('--new-session-id') + 1]
  check('C7i', 'single-use --new-session-id collision recovers via --resume on the same id and still completes', () => ({
    ok: Boolean(id) && a2?.includes('--resume') && a2[a2.indexOf('--resume') + 1] === id && finishes(result.c1)[0]?.reason?.kind === 'stop' && textOf(result.c1) === 'alpha',
    evidence: `argv1=${JSON.stringify(a1)}\nargv2=${JSON.stringify(a2)}\nchunks=${JSON.stringify(result.c1)}`,
  }))
}

// ---- C8: error / abort paths ------------------------------------------------
{
  const controller = new AbortController()
  controller.abort()
  const bundle = await replay('abort', 'stream-json-nopartial.jsonl', { signal: controller.signal })
  const fin = finishes(bundle.chunks)
  check('C8a', 'abort path: an aborted signal still yields exactly one aborted finish', () => ({
    ok: fin.length === 1 && fin[0].reason?.kind === 'aborted' && textOf(bundle.chunks) === '',
    evidence: `chunks=${JSON.stringify(bundle.chunks)}`,
  }))
}

{
  const bundle = await replay('errpath', 'stream-json-nopartial.jsonl', { env: { VERIFIER_EXIT: '1', VERIFIER_STDERR: 'boom: something exploded' } })
  check('C8b', 'error path: a non-zero CLI exit with no content yields one error finish, no content chunks', () => {
    const fin = finishes(bundle.chunks)
    return { ok: fin.length === 1 && fin[0].reason?.kind === 'error', evidence: `chunks=${JSON.stringify(bundle.chunks)}` }
  })
}

check('C9a', 'scripts/verify-models.mjs no longer asserts the old bracket wiring', () => {
  const src = readFileSync(join(repo, 'scripts/verify-models.mjs'), 'utf8')
  const oldBracket = /wireCursorModel\([^)]*\)\s*===?\s*['"`][^'"`]*\[effort=/.test(src)
  const mentionsOldLiteral = src.includes('grok-4.6[effort=high]')
  return { ok: !oldBracket && !mentionsOldLiteral, evidence: `oldBracketAssertion=${oldBracket} mentionsOldLiteral=${mentionsOldLiteral}` }
})

check('C9b', 'verify-models.mjs runs offline with the CLI unavailable (exit 0, no AUTH)', () => {
  const res = spawnSync(process.execPath, ['scripts/verify-models.mjs'], {
    cwd: repo,
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CURSOR_AGENT_BIN: '', CURSOR_API_KEY: '', CURSOR_AUTH_TOKEN: '' },
    encoding: 'utf8',
  })
  return { ok: res.status === 0, evidence: `exit=${res.status}\nstdout=${(res.stdout || '').trim().split('\n').slice(-6).join(' | ')}\nstderr=${(res.stderr || '').trim().split('\n').slice(-6).join(' | ')}` }
})

check('C9c', 'lib/ (built) exposes the new Grok/session/wire surface used by this harness', () => {
  const names = {
    grok: Object.keys(grok), cli: Object.keys(cli), session: Object.keys(sess), adapter: Object.keys(adap),
  }
  const need = {
    grok: ['GROK_CAPTURE_FAMILIES', 'grokFamiliesForCatalog', 'grokFamilyFor', 'grokSlugVocabulary', 'parseGrokRoute', 'isGrokModel'],
    cli: ['wireCursorModel', 'buildAgentArgs', 'interpretAgentStreamObject', 'interpretAgentStreamLine', 'parseModelCatalog', 'INVALID_ARGS_CODE', 'EMPTY_RESPONSE_CODE'],
    session: ['CursorSessionRegistry', 'sessionUuidFor', 'renderAgentContext'],
    adapter: ['CursorLlmAdapter', 'expandModelCatalog'],
  }
  const missing = []
  for (const [k, list] of Object.entries(need)) for (const n of list) if (!names[k].includes(n)) missing.push(`${k}.${n}`)
  return { ok: missing.length === 0, evidence: `missing=${JSON.stringify(missing)}` }
})

// ---- C10/C11: live CLI evidence --------------------------------------------
// Captured from the DSH host process (the bash sandbox cannot reach the login
// keychain, which is why `agent status` says "Not logged in" there). The raw
// JSON is retained so every live assertion below is re-checkable offline.
const liveDocs = {
  catalog: 'verifier-live-probe-host.json',
  sessionId: 'verifier-live-sessionid-host.json',
  continuity: 'verifier-live-continuity-host.json',
  continuity2: 'verifier-live-continuity2-host.json',
  round2: 'verifier-live-round2-host.json',
}
const live = {}
for (const [k, name] of Object.entries(liveDocs)) {
  const p = join(here, name)
  live[k] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
}
const liveById = (doc, label) => doc?.probes.find((p) => p.label === label)
const liveModelsText = live.catalog === undefined ? '' : (liveById(live.catalog, 'models')?.stdout ?? '')
const liveModelsPath = join(here, 'verifier-live-models.txt')
if (liveModelsText !== '') writeFileSync(liveModelsPath, liveModelsText)
const liveModelIds = new Set(liveModelsText.split('\n').map((l) => l.replace(/[\u200B-\u200D\uFEFF]/g, '').trim())
  .filter((l) => /^[A-Za-z0-9][A-Za-z0-9._:+-]*\s+-\s+\S/.test(l)).map((l) => l.split(/\s+-\s+/)[0]))

out('')
out(`live captures: catalog=${liveModelsText === '' ? 'MISSING' : `${liveModelIds.size} ids`} sessionIdProbes=${live.sessionId?.probes.length ?? 'MISSING'} continuityProbes=${live.continuity?.probes.length ?? 'MISSING'}`)

check('C10a', 'live `agent models` (246 ids) still advertises all 6 picker routes and every composed (route, effort) slug', () => {
  const pickerPairs = []
  for (const m of grokPicker(pickerLive)) {
    const info = resolved.live.get(m.id)
    for (const effort of [...(info?.reasoning?.efforts ?? []).map((e) => e.id), undefined]) pickerPairs.push(cli.wireCursorModel(m.id, effort))
  }
  // The bare bases are accepted on the wire but deliberately absent from the
  // catalog listing (t1 §3): they stay legal, they just are not "advertised".
  // A picker base route (grok-4.7 / cursor-grok-4.6 / cursor-grok-4.5) is
  // therefore expected to be missing from the listing; its wire form is proven
  // accepted by the wire-matrix instead.
  const bareAccepted = new Set(['grok-4.7', 'grok-4.6', 'grok-4.5'])
  const baseRoutes = new Set(GROK_BASES)
  const missingRoutes = EXPECTED_GROK_IDS.filter((id) => !liveModelIds.has(id) && !baseRoutes.has(id))
  const missingPairs = [...new Set(pickerPairs)].filter((p) => !liveModelIds.has(p) && !bareAccepted.has(p))
  const bareOk = [...bareAccepted].every((b) => wireAccepted.has(b))
  const baseWireOk = GROK_BASES.every((b) => bareAccepted.has(grok.GROK_CAPTURE_FAMILIES.find((f) => f.base === b)?.wireBase))
  return {
    ok: liveModelIds.size === catalogIds.length && missingRoutes.length === 0 && missingPairs.length === 0 && bareOk,
    evidence: `liveIds=${liveModelIds.size} fixtureIds=${catalogIds.length} bareBasesAcceptedLive=${bareOk} baseRoutesWireAccepted=${baseWireOk}\nmissingPickerRoutes=${JSON.stringify(missingRoutes)}\nmissingComposedSlugs=${JSON.stringify(missingPairs)}\ncaptureFile=${liveModelsPath}`,
  }
})

check('C10b', 'live `agent --print` accepts the adapter wire strings for Extra High and Fast+Extra High', () => {
  const xhigh = liveById(live.catalog, 'print-xhigh')
  const fast = liveById(live.catalog, 'print-xhigh-fast')
  const wireA = cli.wireCursorModel('grok-4.7', 'xhigh')
  const wireB = cli.wireCursorModel('grok-4.7-high-fast', 'xhigh')
  const ok = Boolean(xhigh && fast)
    && xhigh.exitCode === 0 && (xhigh.stdout ?? '').trim() === 'OK'
    && fast.exitCode === 0 && (fast.stdout ?? '').trim() === 'OK'
    && xhigh.argv[xhigh.argv.indexOf('--model') + 1] === wireA
    && fast.argv[fast.argv.indexOf('--model') + 1] === wireB
  return {
    ok,
    evidence: `adapter wire A=${wireA} -> exit=${xhigh?.exitCode} stdout=${JSON.stringify(xhigh?.stdout)}\n      argv=${JSON.stringify(xhigh?.argv)}\nadapter wire B=${wireB} -> exit=${fast?.exitCode} stdout=${JSON.stringify(fast?.stdout)}\n      argv=${JSON.stringify(fast?.argv)}`,
  }
})

check('C10c', 'live baseline: the old synthesized bracket id is still rejected (the bug class the fix removes)', () => {
  const bracket = liveById(live.catalog, 'print-bracket-baseline')
  const rejected = Boolean(bracket) && bracket.exitCode !== 0 && /Cannot use this model: grok-4\.7\[effort=max\]/.test(bracket.stderr ?? '')
  return {
    ok: rejected && !cli.wireCursorModel('grok-4.7', 'xhigh').includes('['),
    evidence: `live grok-4.7[effort=max] exit=${bracket?.exitCode} stderr=${JSON.stringify((bracket?.stderr ?? '').slice(0, 90))}\nadapter output for the same request: ${cli.wireCursorModel('grok-4.7', 'xhigh')}`,
  }
})

check('C10d', 'live controlled continuity: --resume of a v4 session returns the memorized fact while an unknown id and a fresh chat return UNKNOWN', () => {
  const doc = live.continuity2
  const known = liveById(doc, 'resume-known-ask-fact')
  const unknown = liveById(doc, 'resume-unknown-ask-fact')
  const fresh = liveById(doc, 'fresh-control-ask-fact')
  const created = liveById(doc, 'new-session-v4-with-fact')
  const ok = Boolean(known && unknown && fresh) && created?.exitCode === 0
    && (known.stdout ?? '').trim().toLowerCase() === 'aubergine'
    && (unknown.stdout ?? '').trim() === 'UNKNOWN'
    && (fresh.stdout ?? '').trim() === 'UNKNOWN'
  return {
    ok,
    evidence: `new-session(v4)+fact: exit=${created?.exitCode} stdout=${JSON.stringify(created?.stdout)}\n`
      + `resume KNOWN  -> exit=${known?.exitCode} stdout=${JSON.stringify(known?.stdout)}\n`
      + `resume UNKNOWN-> exit=${unknown?.exitCode} stdout=${JSON.stringify(unknown?.stdout)} stderr=${JSON.stringify(unknown?.stderr)}\n`
      + `fresh control -> exit=${fresh?.exitCode} stdout=${JSON.stringify(fresh?.stdout)}\n`
      + `=> --resume genuinely carries context for a v4 id; the unknown id is indistinguishable in exit code/stderr from a normal turn.`,
  }
})

// ---- C11/C12/C13: the repaired F1/F2 contract ------------------------------
// The id below is derived here, from the code path under test, and checked
// against the live validator — never read from the product's own constant or
// from the shipped suite's assertion.
const F1_KEY = 'UUID4E2E'
const mintedFor = (key) => sess.sessionUuidFor(`${key}#0`)
const f1DerivedId = mintedFor(F1_KEY)
const minted = mintedFor('S1')
const UUID4 = UUID4_SELF
// The live driver's DSH session keys (fixtures/live/verifier-live-adapter.mjs);
// the ids below are derived HERE from the code under test, never read from the
// driver's or the suite's own constants.
const LIVE_KEYS = {
  adapterBootstrap: 'LIVE-T8-F1',
  directProbe: 'LIVE-T8-F1-DIRECT',
  absentStore: 'LIVE-T8-F2-ABSENT',
  restart: 'LIVE-T8-F2-RESTART',
}

check('C11a', 'LIVE F1: the exact minted id is accepted by --new-session-id and the bootstrap turn answers', () => {
  const doc = live.round2
  const direct = doc?.mintedIdDirect
  const boot = doc?.scenarios?.bootstrap
  const bootArgv = boot?.argvs?.find((a) => a.includes('--print'))
  const bootId = bootArgv === undefined ? undefined : bootArgv[bootArgv.indexOf('--new-session-id') + 1]
  const bootFin = boot?.finishes ?? []
  const deriveDirect = mintedFor(LIVE_KEYS.directProbe)
  const deriveBoot = mintedFor(LIVE_KEYS.adapterBootstrap)
  const ok = Boolean(direct && boot)
    && direct.exitCode === 0 && (direct.stderr ?? '').trim() === ''
    && /OK/.test(direct.stdout ?? '')
    && direct.id === deriveDirect && UUID4.test(deriveDirect)
    && boot.derivedId === deriveBoot
    && bootId === deriveBoot && UUID4.test(deriveBoot)
    && bootFin.length === 1 && bootFin[0].reason?.kind === 'stop'
    && (boot.text ?? '') !== ''
  return {
    ok,
    evidence: `derived here: mintedFor('${LIVE_KEYS.directProbe}') = ${deriveDirect} (UUIDv4? ${UUID4.test(deriveDirect)})\n`
      + `              mintedFor('${LIVE_KEYS.adapterBootstrap}') = ${deriveBoot} (UUIDv4? ${UUID4.test(deriveBoot)})\n`
      + `LIVE direct probe: ${JSON.stringify(direct?.argv)}\n  exit=${direct?.exitCode} stdout=${JSON.stringify(direct?.stdout)} stderr=${JSON.stringify(direct?.stderr)}\n`
      + `LIVE through the adapter (wrapper-recorded argv): ${JSON.stringify(bootArgv)}\n`
      + `  finishes=${JSON.stringify(bootFin)} assistantText=${JSON.stringify((boot?.text ?? '').slice(0, 160))} storeAfter=${boot?.storeAfter}\n`
      + `captureFile=fixtures/live/verifier-live-round2-host.json`,
  }
})

{
  // Offline F1: a bootstrap turn driven through a stand-in that enforces the
  // live UUIDv4 rule. FAILS on the pre-repair lib (see C13a).
  const fake = withFake({ tag: 'f1-offline', VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl') })
  let result
  try {
    const adapter = newAdapter()
    const chunks = await collect(adapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high', sessionId: F1_KEY, system: SYSTEM,
      messages: [msg('m1', 'user', 'hello')],
    })
    result = { chunks, argvs: fake.readArgvs().filter((a) => a.includes('--print')), state: fake.readState() }
  } finally { fake.restore() }
  const argv = result.argvs[0] ?? []
  const spawnedId = argv.indexOf('--new-session-id') === -1 ? undefined : argv[argv.indexOf('--new-session-id') + 1]
  const fin = finishes(result.chunks)
  check('C11b', 'offline F1: the minted id is the derived UUIDv4 and the bootstrap turn completes under the live rule', () => ({
    ok: spawnedId === f1DerivedId && UUID4.test(spawnedId ?? '')
      && argv.includes('--print') && argv.includes('--trust') && argv.includes('--force')
      && fin.length === 1 && fin[0].reason?.kind === 'stop' && textOf(result.chunks) === 'alpha',
    evidence: `spawned argv=${JSON.stringify(argv)}\nspawnedId=${spawnedId} derived=${f1DerivedId} uuid4=${UUID4.test(spawnedId ?? '')}\n`
      + `chunks=${JSON.stringify(result.chunks)}\nstandInState=${JSON.stringify(result.state)}`,
  }))
}

{
  // Offline F2: the chat store is gone when the continuation is planned. The
  // pre-flight must re-anchor (fresh --new-session-id + the whole DSH context
  // delivered exactly once), never resume contextlessly. FAILS on the
  // pre-repair lib (see C13b).
  const fake = withFake({ tag: 'f2-dead-store', VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl') })
  let result
  try {
    const adapter = newAdapter()
    const opts = (messages) => ({ provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high', sessionId: 'F2DEAD', system: SYSTEM, messages })
    const c1 = await collect(adapter, opts([msg('m1', 'user', 'q1')]))
    const argv1 = fake.readArgvs().filter((a) => a.includes('--print'))[0] ?? []
    const id1 = argv1[argv1.indexOf('--new-session-id') + 1]
    const storedAfterBootstrap = fake.storeHas(id1)
    const deleted = fake.deleteStore(id1)
    const c2 = await collect(adapter, opts([msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2')]))
    const argvs = fake.readArgvs().filter((a) => a.includes('--print'))
    const argv2 = argvs[1] ?? []
    const c3 = await collect(adapter, opts([msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2'), msg('m4', 'assistant', 'a2'), msg('m5', 'user', 'q3')]))
    const argv3 = fake.readArgvs().filter((a) => a.includes('--print'))[2] ?? []
    result = { c1, c2, c3, argv1, argv2, argv3, id1, storedAfterBootstrap, deleted }
  } finally { fake.restore() }
  const id2 = result.argv2[result.argv2.indexOf('--new-session-id') + 1]
  const payload2 = result.argv2.slice(-1)[0] ?? ''
  const countSystem = payload2.split('<dsh_system_prompt>').length - 1
  const countHistory = payload2.split('<dsh_conversation_history>').length - 1
  const fin2 = finishes(result.c2)
  check('C11c', 'offline F2: an absent chat store re-anchors with the full context delivered exactly once', () => ({
    ok: result.storedAfterBootstrap === true && result.deleted === true
      && result.argv2.includes('--new-session-id') && !result.argv2.includes('--resume')
      && id2 !== undefined && id2 !== result.id1
      && countSystem === 1 && countHistory === 1 && payload2.includes('q1') && payload2.includes('q2')
      && fin2.length === 1 && fin2[0].reason?.kind === 'stop'
      && result.argv3.includes('--resume') && result.argv3[result.argv3.indexOf('--resume') + 1] === id2
      && result.argv3.slice(-1)[0] === 'q3',
    evidence: `argv1 (bootstrap)   = ${JSON.stringify(result.argv1)}\n  store had ${result.id1} after bootstrap=${result.storedAfterBootstrap}, deleted=${result.deleted}\n`
      + `argv2 (store gone)  = ${JSON.stringify(result.argv2)}\n  re-anchored id=${id2} (<dsh_system_prompt> x${countSystem}, <dsh_conversation_history> x${countHistory})\n`
      + `argv3 (steady)      = ${JSON.stringify(result.argv3)}\n  chunks2=${JSON.stringify(result.c2)}`,
  }))
}

{
  // Residual race in the F2 fix (captain-requested probe): the pre-flight runs
  // BEFORE the spawn, so a chat removed inside that window is still resumed
  // silently. The stand-in deletes the store at spawn time to expose it.
  const fake = withFake({
    tag: 'f2-race',
    VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl'),
    VERIFIER_RACE_DELETE_RESUME: '1',
  })
  let result
  try {
    const adapter = newAdapter()
    const opts = (messages) => ({ provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high', sessionId: 'F2RACE', system: SYSTEM, messages })
    await collect(adapter, opts([msg('m1', 'user', 'q1')]))
    const c2 = await collect(adapter, opts([msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2')]))
    result = { c2, argvs: fake.readArgvs().filter((a) => a.includes('--print')), state: fake.readState() }
  } finally { fake.restore() }
  const argv2 = result.argvs[1] ?? []
  const payload2 = argv2.slice(-1)[0] ?? ''
  const race = result.state.find((s) => s.kind === 'resume' && s.raceDeleted === true)
  const fin = finishes(result.c2)
  check('C12', 'residual race characterized: a store deleted inside the pre-flight->spawn window is still resumed silently', () => ({
    ok: Boolean(race) && argv2.includes('--resume') && !payload2.includes('<dsh_system_prompt>')
      && fin.length === 1 && fin[0].reason?.kind === 'stop',
    evidence: `pre-flight saw the chat, the stand-in removed it at spawn (standInState=${JSON.stringify(race)})\n`
      + `argv2=${JSON.stringify(argv2)}\n  delivered context=${payload2.includes('<dsh_system_prompt>')}, finish=${JSON.stringify(fin)}\n`
      + `=> the window EXISTS: probe-then-spawn is not atomic. Severity LOW: requires an external deletion of the\n`
      + `   exact chat directory inside a sub-second window, and the CLI itself never prunes on a competing call.\n`
      + `   Residual variant that cannot be closed this way: a store that exists but cannot actually be resumed-by-the-CLI (corrupt/foreign store).`,
  }))
}

{
  // Determinism / restart safety: a second adapter instance (fresh registry,
  // i.e. a plugin restart) for the same DSH session derives the SAME chat id,
  // collides on --new-session-id ("already in use") and recovers via --resume.
  const fake = withFake({ tag: 'restart-collision', VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl') })
  let result
  try {
    const first = newAdapter()
    const second = newAdapter()
    const opts = (messages) => ({ provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high', sessionId: 'RESTART', system: SYSTEM, messages })
    await collect(first, opts([msg('m1', 'user', 'q1')]))
    const c2 = await collect(second, opts([msg('m1', 'user', 'q1'), msg('m2', 'assistant', 'a1'), msg('m3', 'user', 'q2')]))
    result = { c2, argvs: fake.readArgvs().filter((a) => a.includes('--print')) }
  } finally { fake.restore() }
  const [argv1, argv2, argv3] = result.argvs
  const idFirst = argv1?.[argv1.indexOf('--new-session-id') + 1]
  const idSecondMint = argv2?.[argv2.indexOf('--new-session-id') + 1]
  const idRecovered = argv3?.[argv3.indexOf('--resume') + 1]
  const fin = finishes(result.c2)
  check('C11d', 'determinism/restart: the same DSH session re-mints one id, collides, and recovers via --resume', () => ({
    ok: idFirst !== undefined && idFirst === mintedFor('RESTART') && UUID4.test(idFirst)
      && idSecondMint === idFirst && argv2?.includes('--new-session-id')
      && argv3?.includes('--resume') && idRecovered === idFirst
      && (argv3?.slice(-1)[0] ?? '').includes('<dsh_system_prompt>')
      && fin.length === 1 && fin[0].reason?.kind === 'stop',
    evidence: `sessionUuidFor('RESTART#0') (derived here) = ${mintedFor('RESTART')}\n`
      + `argv1 (adapter 1 bootstrap) = ${JSON.stringify(argv1)}\nargv2 (adapter 2 collides) = ${JSON.stringify(argv2)}\n`
      + `argv3 (collision recovery) = ${JSON.stringify(argv3)}\nchunks2=${JSON.stringify(result.c2)}`,
  }))
}

check('C11e', 'LIVE restart: a fresh process re-derives the same id, collides, recovers, and the turn completes', () => {
  const child = live.round2?.scenarios?.restartChild
  const restartDerived = mintedFor(LIVE_KEYS.restart)
  const argv = child?.argvs ?? []
  const mintId = argv.map((a) => a[a.indexOf('--new-session-id') + 1]).filter(Boolean)[0]
  const resumeId = argv.map((a) => a[a.indexOf('--resume') + 1]).filter(Boolean)[0]
  const fin = child?.finishes ?? []
  const ok = Boolean(child)
    && child.derivedId === restartDerived
    && live.round2?.scenarios?.restart?.derivedId === restartDerived
    && mintId === restartDerived
    && argv.some((a) => a.includes('--new-session-id'))
    && argv.some((a) => a.includes('--resume'))
    && resumeId === restartDerived
    && fin.length === 1 && fin[0].reason?.kind === 'stop'
  return {
    ok,
    evidence: `child derivedId=${child?.derivedId} parent restart derivedId=${live.round2?.scenarios?.restart?.derivedId} derived here=${restartDerived}\n`
      + `child argv: ${JSON.stringify(argv)}\nfinishes=${JSON.stringify(fin)}\n`
      + `child answer=${JSON.stringify((child?.text ?? '').slice(0, 200))} childExit=${live.round2?.scenarios?.restart?.childExitCode}`,
  }
})

check('C11f', 'LIVE F2: a real resume carries the fact, and an absent chat store re-anchors with --new-session-id + the full context once', () => {
  const doc = live.round2
  const resume = doc?.scenarios?.resume
  const absent = doc?.scenarios?.absentStore
  const resumeArgv = resume?.argvs?.find((a) => a.includes('--print')) ?? []
  const bootId = doc?.scenarios?.bootstrap?.derivedId
  const reanchorArgv = absent?.reanchorArgvs?.find((a) => a.includes('--print')) ?? []
  const steadyArgv = absent?.steadyArgvs?.find((a) => a.includes('--print')) ?? []
  const reanchorPayload = reanchorArgv.slice(-1)[0] ?? ''
  const reanchorId = reanchorArgv[reanchorArgv.indexOf('--new-session-id') + 1]
  const countSystem = reanchorPayload.split('<dsh_system_prompt>').length - 1
  const resumeFin = resume?.finishes ?? []
  const reanchorFin = absent?.reanchorFinishes ?? []
  const ok = Boolean(resume && absent)
    // (a) real resume: same id, only the newest user turn travels
    && resumeArgv.includes('--resume') && resumeArgv[resumeArgv.indexOf('--resume') + 1] === bootId
    && resumeArgv.slice(-1)[0] === 'What is my favorite color? Reply with just the color, or UNKNOWN.'
    && resumeFin.length === 1 && resumeFin[0].reason?.kind === 'stop'
    // (b) absent store: re-anchors instead of resuming contextlessly
    && absent.storeCreated === 1 && absent.storeDeleted?.length === 1
    && reanchorArgv.includes('--new-session-id') && !reanchorArgv.includes('--resume')
    && reanchorId !== undefined && reanchorId !== absent.derivedId
    && countSystem === 1 && reanchorPayload.includes('the spare key is under the blue pot')
    && reanchorFin.length === 1 && reanchorFin[0].reason?.kind === 'stop'
    && steadyArgv.includes('--resume') && steadyArgv[steadyArgv.indexOf('--resume') + 1] === reanchorId
    && steadyArgv.slice(-1)[0] === 'Name one item in that sentence. Reply with just the item.'
  return {
    ok,
    evidence: `resume (fact recall, wording informational): argv=${JSON.stringify(resumeArgv)}\n  answer=${JSON.stringify(resume?.text)}\n`
      + `absent-store bootstrap: derivedId=${absent?.derivedId} storeCreated=${absent?.storeCreated} storeDeleted=${JSON.stringify(absent?.storeDeleted)}\n`
      + `absent-store re-anchor: argv=${JSON.stringify(reanchorArgv)}\n  <dsh_system_prompt> x${countSystem}, new id=${reanchorId}, answer=${JSON.stringify(absent?.reanchorText)}\n`
      + `absent-store steady: argv=${JSON.stringify(steadyArgv)}\n  answer=${JSON.stringify(absent?.steadyText)}`,
  }
})

{
  // C14: prove the STAND-IN ITSELF enforces the two live rules with no opt-in
  // env (VERIFIER_REQUIRE_UUID4 is deliberately unset here).
  const dir = join(ART, 'standin-rules')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const standinEnv = { ...process.env }
  delete standinEnv.VERIFIER_REQUIRE_UUID4
  delete standinEnv.CURSOR_CHATS_DIR
  Object.assign(standinEnv, {
    VERIFIER_ARGV_LOG: join(dir, 'argv.jsonl'),
    VERIFIER_STATE_LOG: join(dir, 'state.jsonl'),
    VERIFIER_CHATS_DIR: dir,
    VERIFIER_MODELS: join(here, 'models.txt'),
    VERIFIER_REPLAY: join(here, 'stream-json-nopartial.jsonl'),
  })
  const runStandin = (args) => spawnSync(fakeAgent, args, { encoding: 'utf8', env: standinEnv })
  const v5 = '39d32074-6362-53fa-8eb7-84ae8c182d38'
  const v4 = '4f8f6a1e-4b2c-4d3e-8a1b-2c3d4e5f6a7b'
  const unknown = '5a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'
  const rej = runStandin(['--print', '--trust', '--model', 'grok-4.7', '--new-session-id', v5, 'hi'])
  const acc = runStandin(['--print', '--trust', '--model', 'grok-4.7', '--new-session-id', v4, 'hi'])
  const dead = runStandin(['--print', '--trust', '--model', 'grok-4.7', '--resume', unknown, 'hi'])
  const adopted = existsSync(join(dir, 'verifier-ws', unknown))
  check('C14a', 'stand-in rule 1 (default, no opt-in): a non-UUIDv4 --new-session-id is rejected with the captured stderr', () => ({
    ok: rej.status === 1
      && /^Error: Invalid --new-session-id "39d32074-6362-53fa-8eb7-84ae8c182d38": expected a UUIDv4\./.test(rej.stderr ?? '')
      && acc.status === 0,
    evidence: `v5 id: exit=${rej.status} stderr=${JSON.stringify(rej.stderr)}\nv4 id: exit=${acc.status} stdout=${JSON.stringify((acc.stdout ?? '').slice(0, 60))}`,
  }))
  check('C14b', 'stand-in rule 2 (default, no opt-in): a --resume for an unknown id exits 0, stays silent, and adopts the id', () => ({
    ok: dead.status === 0 && (dead.stderr ?? '') === '' && adopted === true && (dead.stdout ?? '').includes('"type":"system"'),
    evidence: `--resume ${unknown}: exit=${dead.status} stderr=${JSON.stringify(dead.stderr)} stdoutLines=${(dead.stdout ?? '').trim().split('\n').length}\n`
      + `chat dir created by the stand-in: ${join(dir, 'verifier-ws', unknown)} exists=${adopted}`,
  }))
}

if (ONLY === undefined) {
  // C13: would the refreshed checks have caught F1/F2? Run THE SAME harness
  // against the pre-repair baseline. A check that passes there cannot be
  // credited with catching the defect. Skipped in a --only sub-run (the C13
  // checks launch those sub-runs; running it inside one would recurse).
  const preRepair = '/tmp/dsh-cursor-lib-backup'
  const hasBaseline = existsSync(join(preRepair, 'models/session.js'))
  const runOnly = (only, extraEnv) => spawnSync(process.execPath, [join(here, 'verifier-t3.mjs'), `--only=${only}`], {
    cwd: repo,
    env: { ...process.env, VERIFIER_LIB: preRepair, ...extraEnv },
    encoding: 'utf8',
  })
  // F1 is demonstrated with the live UUIDv4 rule ON (that is the defence under
  // test). F2 is demonstrated with the rule OFF so the pre-repair F1 defect
  // cannot mask the F2 defect: the stand-in accepts the v5 id, the chat store
  // exists, and the dead-store continuation is then the only thing left to fail.
  const f1Run = hasBaseline ? runOnly('C11b') : undefined
  const f2Run = hasBaseline ? runOnly('C11c', { VERIFIER_REQUIRE_UUID4: '0' }) : undefined
  writeFileSync(join(ART, 'pre-repair-C11b.txt'), `${f1Run?.stdout ?? ''}\n${f1Run?.stderr ?? ''}`)
  writeFileSync(join(ART, 'pre-repair-C11c.txt'), `${f2Run?.stdout ?? ''}\n${f2Run?.stderr ?? ''}`)
  check('C13a', 'the F1 check (C11b) fails against the pre-repair lib, naming the UUIDv4 rejection', () => {
    const text = `${f1Run?.stdout ?? ''}${f1Run?.stderr ?? ''}`
    return {
      ok: hasBaseline && f1Run?.status === 1 && /expected a UUIDv4/.test(text) && /FAIL\s+C11b/.test(text),
      evidence: `baseline=${preRepair} exit=${f1Run?.status}\n` + text.split('\n').filter((l) => /FAIL|expected a UUIDv4|spawnedId/.test(l)).slice(0, 6).join('\n'),
    }
  })
  check('C13b', 'the F2 check (C11c) fails against the pre-repair lib, naming the contextless resume', () => {
    const text = `${f2Run?.stdout ?? ''}${f2Run?.stderr ?? ''}`
    return {
      ok: hasBaseline && f2Run?.status === 1 && /FAIL\s+C11c/.test(text)
        && /--resume/.test(text) && /<dsh_system_prompt> x0/.test(text)
        && /store had .* after bootstrap=true, deleted=true/.test(text),
      evidence: `baseline=${preRepair} (VERIFIER_REQUIRE_UUID4=0) exit=${f2Run?.status}\n`
        + text.split('\n').filter((l) => /FAIL|argv2|re-anchored|store had/.test(l)).slice(0, 8).join('\n'),
    }
  })
}


// ---------------------------------------------------------------- summary ---
const failed = checks.filter((c) => !c.ok)
out('')
out(`lib under test: ${LIB}${ONLY === undefined ? '' : ` (only: ${[...ONLY].join(',')})`}`)
out(`SUMMARY: ${checks.length - failed.length}/${checks.length} checks passed`)
for (const c of failed) out(`  FAILED ${c.id} — ${c.criterion}`)
out(`UNMET CRITERIA: ${failed.map((c) => c.id).join(', ') || 'none'}`)
out(`CHECKS_JSON ${JSON.stringify(checks)}`)
const outputName = ONLY === undefined ? 'verifier-t3-output.txt' : `verifier-t3-output-only-${[...ONLY].join('-')}.txt`
writeFileSync(join(here, outputName), log.join('\n') + '\n')
writeFileSync(join(here, 'verifier-live-evidence.txt'), [
  't3/t8 live CLI evidence (raw captures under fixtures/live/)',
  '',
  ...Object.keys(liveDocs).flatMap((k) => [
    `### ${liveDocs[k]} (${live[k]?.startedAt ?? '?'} .. ${live[k]?.finishedAt ?? '?'})`,
    ...(live[k]?.probes ?? []).map((p) => [
      `--- ${p.label}  exit=${p.exitCode ?? 'n/a'}  ms=${p.ms ?? 'n/a'}${p.error ? ` error=${p.error}` : ''}`,
      `argv: ${JSON.stringify(p.argv)}`,
      `stdout: ${JSON.stringify((p.stdout ?? '').slice(0, 4000))}`,
      `stderr: ${JSON.stringify((p.stderr ?? '').slice(0, 2000))}`,
    ].join('\n')),
    ...(live[k]?.scenarios === undefined ? [] : Object.entries(live[k].scenarios).map(([name, s]) => [
      `--- scenario ${name}  derivedId=${s.derivedId ?? 'n/a'} plan=${JSON.stringify(s.plan ?? null)}`,
      `argv: ${JSON.stringify(s.argvs ?? [])}`,
      `chunks: ${JSON.stringify(s.chunks ?? [])}`,
      `text: ${JSON.stringify(s.text ?? '')}`,
    ].join('\n'))),
    '',
  ]),
].join('\n') + '\n')
process.exitCode = failed.length === 0 ? 0 : 1
