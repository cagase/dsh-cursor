import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Offline contract suite for the Cursor model routes and the one-to-one shim.
 *
 * Ground truth is the live capture in fixtures/live/ (docs/live-cli-contract.md):
 * the picker ids, the wire strings, the stream-json transcript and the session
 * flags are all asserted against raw fixtures, never against the implementation's
 * own memory. fixtures/live/fake-agent.sh replays those captures so nothing here
 * touches the network or a real model.
 */

const root = process.cwd()
const load = (rel) => import(pathToFileURL(join(root, rel)).href)
const lib = await load('lib/index.js')
const adapter = await load('lib/models/adapter.js')
const cli = await load('lib/models/cli.js')
const grok = await load('lib/models/grok.js')
const shim = await load('lib/models/session.js')

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const fixtureDir = join(root, 'fixtures/live')
const fakeAgent = join(fixtureDir, 'fake-agent.sh')
const readFixture = (name) => readFile(join(fixtureDir, name), 'utf8')
const displayName = (id) => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
/** The live CLI's `--new-session-id` contract (t3 F1). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ENV_KEYS = [
  'HOME',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'CURSOR_AGENT_BIN',
  'CURSOR_CHATS_DIR',
  'FAKE_AGENT_DIR',
  'FAKE_AGENT_STREAM',
  'FAKE_AGENT_ARGV_LOG',
  'FAKE_AGENT_CHATS_DIR',
  'FAKE_AGENT_WORKSPACE_HASH',
  'FAKE_AGENT_SESSION_BUSY',
  'FAKE_AGENT_RESUME_FAIL',
  'FAKE_AGENT_INVALID_SESSION_ID',
  'FAKE_AGENT_STATUS',
]

function applyEnv(next) {
  const saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

async function collect(instance, options) {
  const chunks = []
  for await (const chunk of instance.stream(options)) chunks.push(chunk)
  return chunks
}

async function readArgv(path) {
  const raw = await readFile(path, 'utf8')
  const parts = raw.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

// ---------------------------------------------------------------------------
// Plugin surface
// ---------------------------------------------------------------------------
assert(lib.PROVIDER_ID === 'cursor', 'PROVIDER_ID')
assert(typeof lib.registerCursorAdapter === 'function', 'registerCursorAdapter export')
assert(typeof lib.apply === 'function', 'apply')

// ---------------------------------------------------------------------------
// Captured catalog -> picker (no invented entry, Grok base + Fast + efforts)
// ---------------------------------------------------------------------------
const catalogText = await readFixture('models.txt')
const catalog = cli.parseModelCatalog(catalogText)
const liveIds = catalog.map((entry) => entry.id)
const labels = new Map(catalog.filter((entry) => entry.label).map((entry) => [entry.id, entry.label]))
assert(liveIds.length === 246, `live catalog should have 246 ids, parsed ${liveIds.length}`)
assert(!liveIds.includes('Tip:'), 'catalog chrome leaked into the ids')
assert(liveIds.includes('grok-4.7-xhigh-fast'), 'capture fixture changed: grok-4.7-xhigh-fast missing')

const EXPECTED_GROK = [
  'grok-4.7',
  'grok-4.7-high-fast',
  'cursor-grok-4.6',
  'cursor-grok-4.6-high-fast',
  'cursor-grok-4.5',
  'cursor-grok-4.5-high-fast',
]
const EXPECTED_EFFORTS = {
  'grok-4.7': ['low', 'medium', 'high', 'xhigh'],
  'cursor-grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'cursor-grok-4.5': ['low', 'medium', 'high'],
}
const familySlugs = new Set(liveIds.filter((id) => /^(?:cursor-)?grok(?:$|-)/.test(id)))

// Wire acceptance from the capture (section 3 / wire/). A catalog slug counts
// only when that capture did not reject it. A string that is not in the catalog
// counts only when a probe exited 0.
const wireMatrix = await readFixture('wire-matrix.txt')
const probedAccept = new Set()
const rejectedWire = new Set()
for (const block of wireMatrix.split(/^=+ MODEL: /m).slice(1)) {
  const id = block.slice(0, block.indexOf('\n')).trim()
  const exit = /^exit=(\d+)/m.exec(block)?.[1]
  if (exit === '0') probedAccept.add(id)
  else if (exit !== undefined) rejectedWire.add(id)
}
const acceptedWire = new Set([...liveIds].filter((id) => !rejectedWire.has(id)))
for (const id of probedAccept) {
  if (!rejectedWire.has(id)) acceptedWire.add(id)
}
for (const id of rejectedWire) {
  assert(!acceptedWire.has(id), `rejected wire stayed accepted: ${id}`)
}
assert(acceptedWire.has('grok-4.7'), 'capture no longer accepts the bare grok-4.7 base')
assert(rejectedWire.has('grok-4.7[effort=max]'), 'capture no longer rejects the DSH bug string')
assert(rejectedWire.has('grok-4.7-fast'), 'capture no longer rejects a plain -fast slug')
assert(rejectedWire.has('cursor-grok-4.5-xhigh'), 'capture no longer rejects cursor-grok-4.5-xhigh')
assert(familySlugs.size === 22, `capture should hold 22 grok catalog slugs, found ${familySlugs.size}`)

const picker = adapter.expandModelCatalog(liveIds, false, labels)
const pickerIds = picker.map((model) => model.id)
const allowedIds = new Set([...liveIds, ...EXPECTED_GROK])
assert(
  pickerIds.every((id) => allowedIds.has(id)),
  `picker invented an id outside the capture: ${pickerIds.filter((id) => !allowedIds.has(id)).join(', ')}`,
)
assert(
  JSON.stringify(pickerIds.slice(0, EXPECTED_GROK.length)) === JSON.stringify(EXPECTED_GROK),
  `Grok picker entries: ${pickerIds.slice(0, EXPECTED_GROK.length).join(', ')}`,
)
assert(
  JSON.stringify(pickerIds.slice(EXPECTED_GROK.length)) ===
    JSON.stringify(liveIds.filter((id) => !familySlugs.has(id))),
  'the non-Grok catalog must follow the Grok routes in the CLI catalog order',
)
assert(
  picker.length === liveIds.length - familySlugs.size + EXPECTED_GROK.length,
  `picker size ${picker.length}`,
)
for (const id of liveIds) {
  if (familySlugs.has(id)) continue
  const entry = picker.find((model) => model.id === id)
  assert(entry, `non-Grok model ${id} is missing from the picker`)
  assert(entry.name === displayName(id), `non-Grok model ${id} was renamed to "${entry.name}"`)
}
for (const model of picker) {
  if (!EXPECTED_GROK.includes(model.id)) continue
  assert(model.name && !/\[/.test(model.id), `Grok picker entry ${model.id} is malformed`)
}

assert(
  picker.every((model) => !/[\u200B-\u200D\uFEFF]/.test(model.name) && !/[\u200B-\u200D\uFEFF]/.test(model.description ?? '')),
  'a picker display name leaked a zero-width character from a CLI label',
)
assert(picker.find((model) => model.id === 'grok-4.7-high-fast')?.name === 'Grok 4.7 Fast', 'Grok 4.7 Fast display name')
assert(picker.find((model) => model.id === 'cursor-grok-4.5')?.name === 'Grok 4.5', 'Grok 4.5 display name')

const fallbackPicker = adapter.expandModelCatalog(cli.FALLBACK_MODEL_SLUGS, true)
assert(fallbackPicker.some((model) => model.id === 'gpt-5'), 'fallback catalog lost its CLI help slug')
assert(
  !fallbackPicker.some((model) => model.id === 'gpt-5-fast' || model.id === 'gpt-5-xhigh'),
  'fallback catalog invented a Fast/xhigh variant for a fallback slug',
)
assert(
  JSON.stringify(fallbackPicker.map((model) => model.id).filter((id) => /grok/i.test(id))) ===
    JSON.stringify(EXPECTED_GROK),
  'fallback catalog does not carry the captured Grok families',
)
// t3 F4: the AUTH fallback must render the same Grok names as the live-labeled path
// (the cursor-prefixed families must not read "Cursor Grok 4.6").
assert(
  JSON.stringify(fallbackPicker.filter((model) => /grok/i.test(model.id)).map((model) => [model.id, model.name])) ===
    JSON.stringify(picker.filter((model) => /grok/i.test(model.id)).map((model) => [model.id, model.name])),
  `fallback Grok names diverge from the live labels: ${fallbackPicker.filter((model) => /grok/i.test(model.id)).map((model) => `${model.id}=${model.name}`).join(', ')}`,
)

const resolvedInstance = new adapter.CursorLlmAdapter()
for (const id of EXPECTED_GROK) {
  const base = id.endsWith('-fast') ? id.slice(0, -'-fast'.length).replace(/-(?:low|medium|high|xhigh)$/, '') : id
  const resolved = await resolvedInstance.resolveModel('cursor', id)
  assert(resolved.reasoning, `${id} exposes no reasoning efforts`)
  assert(
    JSON.stringify(resolved.reasoning.efforts.map((effort) => effort.id)) ===
      JSON.stringify(EXPECTED_EFFORTS[base]),
    `${id} efforts: ${resolved.reasoning.efforts.map((effort) => effort.id).join(', ')}`,
  )
  assert(
    EXPECTED_EFFORTS[base].includes(resolved.reasoning.defaultEffort),
    `${id} defaultEffort ${resolved.reasoning.defaultEffort} is not an advertised level`,
  )
}
assert(
  pickerIds.filter((id) => !/^(?:cursor-)?grok(?:$|-)/.test(id)).every((id) => acceptedWire.has(id)),
  'every non-Grok picker id must be a catalog slug the CLI accepts',
)
const grokFastPickerIds = pickerIds.filter((id) => /^(?:cursor-)?grok(?:$|-)/.test(id) && id.endsWith('-fast'))
assert(
  grokFastPickerIds.length === 3 && grokFastPickerIds.every((id) => acceptedWire.has(id)),
  `every Grok Fast picker id must be a real captured slug, got ${grokFastPickerIds.join(', ')}`,
)
assert(
  !pickerIds.some((id) => rejectedWire.has(id)),
  `the picker advertises a string the CLI rejects: ${pickerIds.filter((id) => rejectedWire.has(id)).join(', ')}`,
)
for (const id of ['auto', 'claude-opus-4-8-max', 'gpt-5.3-codex-low', 'composer-2.5']) {
  const resolved = await resolvedInstance.resolveModel('cursor', id)
  assert(resolved.reasoning === undefined, `non-Grok model ${id} gained synthetic efforts`)
}
assert(
  (await resolvedInstance.resolveModel('cursor', 'cursor-grok-4.5')).reasoning.efforts.length === 3,
  'cursor-grok-4.5 must not advertise xhigh',
)

// ---------------------------------------------------------------------------
// Wire strings: only captured slugs, never a bracket override (criteria 2 + 3)
// ---------------------------------------------------------------------------
const vocabulary = grok.grokSlugVocabulary(liveIds)
for (const model of picker) {
  const resolved = await resolvedInstance.resolveModel('cursor', model.id)
  const efforts = [undefined, ...(resolved.reasoning?.efforts ?? []).map((effort) => effort.id)]
  for (const effort of efforts) {
    const wire = cli.wireCursorModel(model.id, effort, { vocabulary })
    assert(!wire.includes('['), `advertised pair ${model.id}/${effort} synthesised a bracket override: ${wire}`)
    assert(
      acceptedWire.has(wire),
      `advertised pair ${model.id}/${effort} -> "${wire}" is outside the captured live slug set`,
    )
  }
}
assert(cli.wireCursorModel('grok-4.7', 'high', { vocabulary }) === 'grok-4.7-high', 'wire effort')
assert(cli.wireCursorModel('grok-4.7', 'xhigh', { vocabulary }) === 'grok-4.7-xhigh', 'wire xhigh')
assert(
  cli.wireCursorModel('grok-4.7-fast', 'xhigh', { vocabulary }) === 'grok-4.7-xhigh-fast',
  'wire Fast xhigh',
)
assert(
  cli.wireCursorModel('grok-4.7-fast', undefined, { vocabulary }) === 'grok-4.7-high-fast',
  'wire Fast default effort',
)
assert(cli.wireCursorModel('cursor-grok-4.5', undefined, { vocabulary }) === 'grok-4.5', 'wire bare base')
assert(cli.wireCursorModel('grok-4.7', undefined, { vocabulary }) === 'grok-4.7', 'wire bare grok base')
assert(
  cli.wireCursorModel('cursor-grok-4.6-high', 'high', { vocabulary }) === 'cursor-grok-4.6-high',
  'wire full catalog slug',
)
const bracket = 'grok-4.7[context=256k,reasoning_effort=xhigh,fast=false]'
assert(cli.wireCursorModel(bracket, 'low', { vocabulary }) === bracket, 'bracket passthrough must be byte-identical')
for (const id of ['auto', 'gpt-5.3-codex-low', 'claude-opus-4-8-max']) {
  assert(cli.wireCursorModel(id, 'high', { vocabulary }) === id, `non-Grok ${id} must pass through verbatim`)
}
for (const [model, effort] of [
  ['grok-4.7', 'max'],
  ['grok-4.7', 'minimal'],
  ['cursor-grok-4.5', 'xhigh'],
  ['grok-4.6', 'high'],
  ['grok-4.7-fast', 'minimal'],
]) {
  let failure
  try {
    cli.wireCursorModel(model, effort, { vocabulary })
  } catch (error) {
    failure = error
  }
  assert(failure, `${model}/${effort} should have failed instead of guessing a slug`)
  assert(failure.code === 'INVALID_ARGS', `${model}/${effort} code: ${failure.code}`)
}

// A family the capture does not know (a future `agent models` listing) is derived
// from the live slugs only: no invented effort, and the wire string stays inside
// the live catalog instead of guessing a bracket override.
const futureSlugs = [...liveIds, 'grok-4.8-low', 'grok-4.8-high']
const futurePicker = adapter.expandModelCatalog(futureSlugs, false, labels)
const futureGrok = futurePicker.filter((model) => /grok-4\.8/.test(model.id))
assert(
  JSON.stringify(futureGrok.map((model) => model.id)) === JSON.stringify(['grok-4.8']),
  `future family picker entries: ${futureGrok.map((model) => model.id).join(', ')}`,
)
assert(
  !futurePicker.some((model) => model.id === 'grok-4.8-fast' || model.id === 'grok-4.8-xhigh'),
  'a future family gained a Fast/xhigh entry the live catalog does not sell',
)
assert(
  cli.wireCursorModel('grok-4.8', undefined, {
    vocabulary: grok.grokSlugVocabulary(futureSlugs),
    liveSlugs: futureSlugs,
  }) === 'grok-4.8-high',
  'a future family must compose its live default-effort slug, never a bare or bracketed guess',
)

let futureFastFailure
try {
  cli.wireCursorModel('grok-4.8-fast', 'low', {
    vocabulary: grok.grokSlugVocabulary(futureSlugs),
    liveSlugs: futureSlugs,
  })
} catch (error) {
  futureFastFailure = error
}
assert(
  futureFastFailure?.code === 'INVALID_ARGS',
  'a Fast route with no advertised -fast slug must fail instead of guessing',
)

// ---------------------------------------------------------------------------
// stream-json replay: assistant text + thinking + one finish, nothing else
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(join(tmpdir(), 'dsh-cursor-verify-'))
const argvLog = join(tmp, 'argv.bin')
try {
  const replayText = await readFixture('stream-json.jsonl')
  const replayObjects = replayText.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  // `--stream-partial-output` streams word deltas and then repeats each turn as
  // one full block; the CLI's own `result.result` is the turn-delimited
  // concatenation (verified below). Derive it from the raw capture here.
  const turnGroups = []
  let openGroup = []
  for (const object of replayObjects) {
    if (object.type === 'tool_call') {
      turnGroups.push(openGroup)
      openGroup = []
      continue
    }
    if (object.type === 'assistant') openGroup.push(object.message.content[0].text)
  }
  turnGroups.push(openGroup)
  const assistantText = turnGroups
    .map((group) => (group.length === 0 ? '' : group[group.length - 1]))
    .join('')
  const thinkingText = replayObjects
    .filter((object) => object.type === 'thinking' && typeof object.text === 'string')
    .map((object) => object.text)
    .join('')
  const promptEcho = replayObjects.find((object) => object.type === 'user').message.content[0].text
  const initModel = replayObjects.find((object) => object.type === 'system').model
  const resultText = replayObjects.find((object) => object.type === 'result').result
  assert(
    assistantText === resultText,
    'capture changed: the turn-delimited assistant blocks no longer equal result.result',
  )
  assert(
    turnGroups.length > 1,
    'capture changed: expected the tool-call conversation to carry several assistant turns',
  )

  // Every non-transcript event type in the capture maps to `ignored` (or the
  // internal tool-turn boundary) and can never become a chat message.
  const failureObjects = (await readFixture('stream-json-system-prompt-failure.jsonl'))
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line))
  const droppedSamples = [
    ['system init', replayObjects.find((object) => object.type === 'system')],
    ['user echo', replayObjects.find((object) => object.type === 'user')],
    ['tool_call', replayObjects.find((object) => object.type === 'tool_call')],
    ['thinking completed', replayObjects.find((object) => object.type === 'thinking' && object.subtype === 'completed')],
    ['retry', failureObjects.find((object) => object.type === 'retry')],
    ['connection', failureObjects.find((object) => object.type === 'connection')],
    ['interaction_query', { type: 'interaction_query', subtype: 'request', message: { content: [{ type: 'text', text: 'pick one' }] } }],
  ]
  for (const [label, object] of droppedSamples) {
    const event = cli.interpretAgentStreamObject(object)
    assert(
      event.type === 'ignored' || event.type === 'tool',
      `${label} produced a transcript event: ${JSON.stringify(event).slice(0, 120)}`,
    )
  }

  // The stand-in emulates the CLI's chat store under $HOME/.cursor/chats; point HOME
  // at the fixture temp dir so the real store is never touched (the production path
  // is os.homedir(), so this exercises it rather than a test-only override).
  const homeDir = join(tmp, 'home')
  const chatsRoot = join(homeDir, '.cursor', 'chats')
  const workspaceHash = '766fe73c06573698c270309a02f752f8'
  const storePath = (id) => join(chatsRoot, workspaceHash, id, 'store.db')
  const restore = applyEnv({
    HOME: homeDir,
    CURSOR_CHATS_DIR: undefined,
    CURSOR_API_KEY: 'fixture-key',
    CURSOR_AGENT_BIN: fakeAgent,
    FAKE_AGENT_STREAM: join(fixtureDir, 'stream-json.jsonl'),
    FAKE_AGENT_ARGV_LOG: undefined,
    FAKE_AGENT_STATUS: undefined,
  })
  // -------------------------------------------------------------------------
  // t3 F1/F3 — the minted id must satisfy the CLI's live UUIDv4 validator
  // -------------------------------------------------------------------------
  for (const seed of ['sess-1#0', 'S1#0', 'restart#0']) {
    const id = shim.sessionUuidFor(seed)
    assert(UUID_V4.test(id), `minted id for ${seed} is not a UUIDv4: ${id}`)
  }
  assert(typeof shim.isSessionUuidV4 === 'function', 'session.js must export the UUIDv4 contract check')
  assert(shim.isSessionUuidV4(shim.sessionUuidFor('sess-1#0')), 'isSessionUuidV4 must accept the minted id')
  assert(
    shim.sessionUuidFor('S1#0') === '39d32074-6362-43fa-8eb7-84ae8c182d38',
    `the deterministic derivation changed: ${shim.sessionUuidFor('S1#0')}`,
  )
  assert(
    !UUID_V4.test('39d32074-6362-53fa-8eb7-84ae8c182d38'),
    'the pre-repair v5 id must not pass as a UUIDv4',
  )
  const v5Id = '39d32074-6362-53fa-8eb7-84ae8c182d38'
  const v5Probe = spawnSync(
    fakeAgent,
    ['--print', '--mode', 'ask', '--trust', '--model', 'grok-4.7', '--new-session-id', v5Id, 'Reply with exactly: OK'],
    { encoding: 'utf8', env: { ...process.env } },
  )
  assert(
    v5Probe.status === 1
      && /Invalid --new-session-id "39d32074-6362-53fa-8eb7-84ae8c182d38": expected a UUIDv4\./.test(v5Probe.stderr ?? ''),
    `the stand-in must reject a v5 id exactly like the live CLI: status=${v5Probe.status} stderr=${JSON.stringify(v5Probe.stderr)}`,
  )
  assert(
    !existsSync(storePath(v5Id)),
    'a rejected id must not leave a chat store behind (the live CLI rejects before creating it)',
  )


  assert(cli.cursorChatsRoot() === chatsRoot, `chats root must follow HOME: ${cli.cursorChatsRoot()}`)
  const replayAdapter = new adapter.CursorLlmAdapter()
  const replay = await collect(replayAdapter, {
    provider: 'cursor',
    model: 'grok-4.7-xhigh',
    sessionId: 'replay-session',
    messages: [{ role: 'user', content: [{ type: 'text', text: promptEcho }] }],
  })
  const text = replay.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  const thinking = replay.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('')
  const finishes = replay.filter((chunk) => chunk.type === 'finish')
  assert(finishes.length === 1, `replay produced ${finishes.length} finishes`)
  assert(finishes[0].reason.kind === 'stop', `replay finish: ${JSON.stringify(finishes[0])}`)
  assert(text === assistantText, `replayed assistant text diverged: ${text.slice(0, 120)}`)
  assert(thinking === thinkingText, 'replayed thinking diverged')
  assert(
    replay.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text')
      && replay.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning'),
    'replay did not open both a text and a reasoning block',
  )
  assert(
    replay.filter((chunk) => chunk.type === 'block-end').length === 2,
    'replay block-end count',
  )
  assert(
    replay.every((chunk) => ['block-start', 'text-delta', 'reasoning-delta', 'block-end', 'finish'].includes(chunk.type)),
    'replay emitted a chunk type outside the transcript vocabulary',
  )
  for (const leak of [promptEcho, initModel, '[cursor tool]', 'User:', 'System:', 'connection', 'retry']) {
    assert(!text.includes(leak), `replayed text leaked ${JSON.stringify(leak.slice(0, 40))}`)
  }
  assert(!text.includes(assistantText + assistantText), 'result.result duplicated streamed text')

  // Single-flushed-assistant path: without --stream-partial-output the CLI emits
  // one complete block and one result, and nothing may be appended twice.
  process.env.FAKE_AGENT_STREAM = join(fixtureDir, 'stream-json-nopartial.jsonl')
  const nopartialObjects = (await readFixture('stream-json-nopartial.jsonl'))
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line))
  const nopartial = await collect(new adapter.CursorLlmAdapter(), {
    provider: 'cursor',
    model: 'grok-4.7',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: alpha' }] }],
  })
  const nopartialText = nopartial.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert(nopartialText === 'alpha', `single-flush transcript: ${JSON.stringify(nopartialText)}`)
  assert(
    nopartial.filter((chunk) => chunk.type === 'block-end').length === 2,
    'single-flush replay must close exactly one text and one reasoning block',
  )
  assert(
    nopartial.filter((chunk) => chunk.type === 'finish')[0].reason.kind === 'stop',
    'single-flush replay must finish with stop',
  )
  assert(
    nopartialObjects.filter((object) => object.type === 'result').length === 1,
    'single-flush fixture shape changed',
  )

  for (const [fixture, label] of [
    ['stream-json-echo-only.jsonl', 'init echo only'],
    ['stream-json-system-prompt-failure.jsonl', 'connection/retry failure'],
  ]) {
    process.env.FAKE_AGENT_STREAM = join(fixtureDir, fixture)
    const quiet = await collect(new adapter.CursorLlmAdapter(), {
      provider: 'cursor',
      model: 'grok-4.7-xhigh',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'echo' }] }],
    })
    const quietFinish = quiet.filter((chunk) => chunk.type === 'finish')
    assert(quietFinish.length === 1, `${label}: ${quietFinish.length} finishes`)
    assert(quietFinish[0].reason.kind === 'error', `${label}: ${JSON.stringify(quietFinish[0])}`)
    assert(quietFinish[0].reason.failure.code === 'EMPTY_RESPONSE', `${label}: ${quietFinish[0].reason.failure.code}`)
    assert(
      !quiet.some((chunk) => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'),
      `${label}: chrome reached the consumer`,
    )
  }

  // -------------------------------------------------------------------------
  // Argument + session contract: one user turn positionally, one CLI session
  // -------------------------------------------------------------------------
  process.env.FAKE_AGENT_STREAM = join(fixtureDir, 'stream-json.jsonl')
  process.env.FAKE_AGENT_ARGV_LOG = argvLog
  const systemPrompt = 'You are the DSH shim test harness.'
  const sessionAdapter = new adapter.CursorLlmAdapter()
  const firstQuestion = 'first question'
  const secondQuestion = 'second question'

  const positional = (argv) => argv[argv.length - 1]
  const collectStop = async (instance, options, label) => {
    const chunks = await collect(instance, options)
    const finish = chunks.filter((chunk) => chunk.type === 'finish')[0]
    assert(finish?.reason?.kind === 'stop', `${label} finish: ${JSON.stringify(finish)}`)
    return chunks
  }
  const flagValues = (argv, flag) => argv.flatMap((token, index) => (token === flag ? [argv[index + 1]] : []))
  const ALLOWED_FLAGS = [
    '--print',
    '--output-format',
    '--stream-partial-output',
    '--trust',
    '--force',
    '--model',
    '--workspace',
    '--new-session-id',
    '--resume',
  ]
  // The capture rules out every file-backed context channel for this account
  // (--system-prompt is rejected server-side, --conversation-history-file is
  // inert, --exclude-workspace-context is refused), so the shim creates no
  // temporary file: context rides the session store and the positional prompt.
  const GATED_FILE_FLAGS = ['--system-prompt', '--conversation-history-file', '--exclude-workspace-context']
  const valueFlags = new Set(['--output-format', '--model', '--workspace', '--new-session-id', '--resume'])
  const argvs = []
  const assertArgvShape = (argv, label) => {
    argvs.push({ label, argv })
    for (const flag of GATED_FILE_FLAGS) {
      assert(!argv.includes(flag), `${label}: ${flag} is gated for this account and must not be passed`)
    }
    const positionals = []
    for (let index = 0; index < argv.length; index++) {
      const token = argv[index]
      if (valueFlags.has(token)) {
        index++
        continue
      }
      if (token.startsWith('--')) {
        assert(ALLOWED_FLAGS.includes(token), `${label}: unexpected flag ${token}`)
        continue
      }
      positionals.push(token)
    }
    assert(positionals.length === 1, `${label}: expected exactly one positional prompt, got ${positionals.length}`)
    assert(positionals[0] === argv[argv.length - 1], `${label}: the positional prompt must travel last`)
  }

  await collectStop(sessionAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-1',
    system: systemPrompt,
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: firstQuestion }] }],
  })

  const firstArgv = await readArgv(argvLog)
  assertArgvShape(firstArgv, 'bootstrap')
  assert(firstArgv[0] === '--print' && firstArgv[7] === 'grok-4.7-high', `first argv: ${firstArgv.slice(0, 8).join(' ')}`)
  for (const flag of ['--print', '--trust', '--force', '--stream-partial-output']) {
    assert(firstArgv.includes(flag), `${flag} must be passed explicitly (capture §4.0)`)
  }
  const firstSessionId = flagValues(firstArgv, '--new-session-id')[0]
  assert(firstSessionId && /^[0-9a-f-]{36}$/.test(firstSessionId), `session id: ${firstSessionId}`)
  assert(flagValues(firstArgv, '--resume').length === 0, 'first call must not resume')
  assert(positional(firstArgv).includes(firstQuestion), 'first call lost the user turn')
  assert(positional(firstArgv).includes(systemPrompt), 'first call lost the DSH system prompt')

  await collectStop(sessionAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-1',
    system: systemPrompt,
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: firstQuestion }] },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: secondQuestion }] },
    ],
  })
  const secondArgv = await readArgv(argvLog)
  assertArgvShape(secondArgv, 'steady state')
  assert(flagValues(secondArgv, '--resume')[0] === firstSessionId, 'second call must resume the same CLI session')
  assert(flagValues(secondArgv, '--new-session-id').length === 0, 'second call must not mint a second CLI session')
  assert(positional(secondArgv) === secondQuestion, `steady-state payload must be one-to-one: ${JSON.stringify(positional(secondArgv))}`)
  assert(!positional(secondArgv).includes(systemPrompt), 'steady-state payload re-injected the system prompt')
  assert(!positional(secondArgv).includes(firstQuestion), 'steady-state payload re-injected prior turns')

  await collectStop(sessionAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-1',
    system: `${systemPrompt} (v2)`,
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: firstQuestion }] },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: secondQuestion }] },
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: 'third question' }] },
    ],
  })
  const reanchorArgv = await readArgv(argvLog)
  assertArgvShape(reanchorArgv, 're-anchor')
  const reanchorSessionId = flagValues(reanchorArgv, '--new-session-id')[0]
  assert(reanchorSessionId && reanchorSessionId !== firstSessionId, 'a changed system prompt must re-anchor a new CLI session')
  assert(positional(reanchorArgv).includes(`${systemPrompt} (v2)`), 're-anchor lost the system prompt')
  assert(positional(reanchorArgv).includes('third question'), 're-anchor lost the newest user turn')

  await collectStop(sessionAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    purpose: 'session-title',
    sessionId: 'sess-1',
    system: 'Auxiliary system prompt.',
    messages: [
      { id: 't1', role: 'user', content: [{ type: 'text', text: 'title me' }] },
      { id: 't2', role: 'assistant', content: [{ type: 'text', text: 'a previous answer' }] },
      { id: 't3', role: 'user', content: [{ type: 'text', text: 'name this conversation' }] },
    ],
  })
  const auxiliaryArgv = await readArgv(argvLog)
  assertArgvShape(auxiliaryArgv, 'auxiliary call')
  assert(
    flagValues(auxiliaryArgv, '--new-session-id').length === 0 && flagValues(auxiliaryArgv, '--resume').length === 0,
    'an auxiliary call must not touch the conversation session',
  )
  assert(
    positional(auxiliaryArgv).includes('Auxiliary system prompt.')
      && positional(auxiliaryArgv).includes('title me')
      && positional(auxiliaryArgv).includes('a previous answer'),
    'an auxiliary call must carry its full context',
  )

  await collectStop(sessionAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-1',
    system: `${systemPrompt} (v2)`,
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: firstQuestion }] },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: secondQuestion }] },
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: 'third question' }] },
      { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'third answer' }] },
      { id: 'm4', role: 'user', content: [{ type: 'text', text: 'fourth question' }] },
    ],
  })
  const fourthArgv = await readArgv(argvLog)
  assertArgvShape(fourthArgv, 'fourth turn')
  assert(flagValues(fourthArgv, '--resume')[0] === reanchorSessionId, 'steady state must follow the re-anchored CLI session')
  assert(positional(fourthArgv) === 'fourth question', `fourth payload: ${JSON.stringify(positional(fourthArgv))}`)

  // DSH retry: the same request carries nothing new, so the last user turn is
  // re-sent on the same CLI session instead of re-anchoring.
  await collectStop(sessionAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-1',
    system: `${systemPrompt} (v2)`,
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: firstQuestion }] },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: secondQuestion }] },
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: 'third question' }] },
      { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'third answer' }] },
      { id: 'm4', role: 'user', content: [{ type: 'text', text: 'fourth question' }] },
    ],
  })
  const retryArgv = await readArgv(argvLog)
  assertArgvShape(retryArgv, 'retry')
  assert(flagValues(retryArgv, '--resume')[0] === reanchorSessionId, 'a retry must keep its CLI session')
  assert(positional(retryArgv) === 'fourth question', `retry payload: ${JSON.stringify(positional(retryArgv))}`)

  // A rewritten history (new message identities) re-anchors a fresh CLI session.
  await collectStop(sessionAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-1',
    system: `${systemPrompt} (v2)`,
    messages: [
      { id: 'r1', role: 'user', content: [{ type: 'text', text: 'compacted summary' }] },
      { id: 'r2', role: 'user', content: [{ type: 'text', text: 'fifth question' }] },
    ],
  })
  const rewrittenArgv = await readArgv(argvLog)
  assertArgvShape(rewrittenArgv, 'rewritten history')
  const rewrittenSessionId = flagValues(rewrittenArgv, '--new-session-id')[0]
  assert(
    rewrittenSessionId && rewrittenSessionId !== reanchorSessionId,
    'a rewritten history must re-anchor a fresh CLI session',
  )
  assert(positional(rewrittenArgv).includes('fifth question'), 're-anchor lost the newest user turn')

  // Single-use `--new-session-id` (capture §6.1): collide once, recover with --resume.
  const busySessionId = shim.sessionUuidFor('sess-busy#0')
  process.env.FAKE_AGENT_SESSION_BUSY = busySessionId
  const busy = await collect(new adapter.CursorLlmAdapter(), {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-busy',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'busy session' }] }],
  })
  assert(busy.filter((chunk) => chunk.type === 'finish')[0].reason.kind === 'stop', 'busy-session recovery failed')
  const busyArgv = await readArgv(argvLog)
  assertArgvShape(busyArgv, 'busy-session recovery')
  assert(flagValues(busyArgv, '--resume')[0] === busySessionId, 'busy-session recovery must resume the existing chat')
  delete process.env.FAKE_AGENT_SESSION_BUSY

  // A `--resume` the CLI can no longer satisfy must not fail the turn: the shim
  // degrades to a fresh session that carries the full DSH context again.
  const degradeAdapter = new adapter.CursorLlmAdapter()
  const degradeSystem = 'Degrade path system prompt.'
  await collect(degradeAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    sessionId: 'sess-degrade',
    system: degradeSystem,
    messages: [{ id: 'd1', role: 'user', content: [{ type: 'text', text: 'degrade first' }] }],
  })
  const degradeFirstArgv = await readArgv(argvLog)
  assertArgvShape(degradeFirstArgv, 'degradation bootstrap')
  const degradeFirstId = flagValues(degradeFirstArgv, '--new-session-id')[0]
  assert(degradeFirstId === shim.sessionUuidFor('sess-degrade#0'), `degrade bootstrap id: ${degradeFirstId}`)
  process.env.FAKE_AGENT_RESUME_FAIL = degradeFirstId
  const degraded = await collect(degradeAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    sessionId: 'sess-degrade',
    system: degradeSystem,
    messages: [
      { id: 'd1', role: 'user', content: [{ type: 'text', text: 'degrade first' }] },
      { id: 'd2', role: 'assistant', content: [{ type: 'text', text: 'degrade answer' }] },
      { id: 'd3', role: 'user', content: [{ type: 'text', text: 'degrade second' }] },
    ],
  })
  delete process.env.FAKE_AGENT_RESUME_FAIL
  assert(
    degraded.filter((chunk) => chunk.type === 'text-delta').length > 0,
    'a failed --resume must still produce assistant text',
  )
  assert(
    degraded.filter((chunk) => chunk.type === 'finish')[0].reason.kind === 'stop',
    'a failed --resume must not fail the turn',
  )
  const degradeSecondArgv = await readArgv(argvLog)
  assertArgvShape(degradeSecondArgv, 'resume degradation')
  const degradeSecondId = flagValues(degradeSecondArgv, '--new-session-id')[0]
  assert(degradeSecondId && degradeSecondId !== degradeFirstId, 'degradation must mint a fresh CLI session')
  assert(positional(degradeSecondArgv).includes(degradeSystem), 'degradation must re-deliver the DSH context')
  assert(positional(degradeSecondArgv).includes('degrade second'), 'degradation lost the newest user turn')
  assert(
    JSON.stringify(argvs.map((entry) => entry.label)) === JSON.stringify([
      'bootstrap',
      'steady state',
      're-anchor',
      'auxiliary call',
      'fourth turn',
      'retry',
      'rewritten history',
      'busy-session recovery',
      'degradation bootstrap',
      'resume degradation',
    ]),
    `captured argument lists: ${argvs.map((entry) => entry.label).join(', ')}`,
  )

  // -------------------------------------------------------------------------
  // t3 F2 — a missing chat store re-anchors instead of resuming silently
  // -------------------------------------------------------------------------
  const deadSession = 'sess-dead'
  const deadSystem = 'Dead resume system prompt.'
  const factTurn = 'Remember this codeword: AUBERGINE-77. Reply with just OK.'
  const factQuestion = 'What codeword did I ask you to remember? Reply with just the codeword, or UNKNOWN.'
  const deadTurn = (id) => [
    { id: 'd1', role: 'user', content: [{ type: 'text', text: factTurn }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
    { id, role: 'user', content: [{ type: 'text', text: factQuestion }] },
  ]
  const deadAdapter = new adapter.CursorLlmAdapter()
  await collectStop(deadAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    sessionId: deadSession,
    system: deadSystem,
    messages: [{ id: 'd1', role: 'user', content: [{ type: 'text', text: factTurn }] }],
  }, 'dead-resume bootstrap')
  const deadFirstArgv = await readArgv(argvLog)
  assertArgvShape(deadFirstArgv, 'dead-resume bootstrap')
  const deadFirstId = flagValues(deadFirstArgv, '--new-session-id')[0]
  assert(shim.isSessionUuidV4(deadFirstId), `bootstrap id: ${deadFirstId}`)
  assert(existsSync(storePath(deadFirstId)), 'a new session must create the CLI chat store')

  await collectStop(deadAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    sessionId: deadSession,
    system: deadSystem,
    messages: deadTurn('d2'),
  }, 'dead-resume alive')
  const aliveArgv = await readArgv(argvLog)
  assertArgvShape(aliveArgv, 'dead-resume alive')
  assert(flagValues(aliveArgv, '--resume')[0] === deadFirstId, 'an existing chat must be resumed')
  assert(positional(aliveArgv) === factQuestion, `alive resume payload: ${JSON.stringify(positional(aliveArgv))}`)

  // A raw --resume for a chat the CLI does not have is silent: exit 0, empty stderr,
  // and it creates that chat under the requested id (t3 F2). The stand-in models it.
  rmSync(join(chatsRoot, workspaceHash, deadFirstId), { recursive: true, force: true })
  assert(!existsSync(storePath(deadFirstId)), 'store removal failed')
  const silentId = '22222222-2222-4222-8222-222222222222'
  const silentProbe = spawnSync(
    fakeAgent,
    ['--print', '--model', 'grok-4.7', '--resume', silentId, 'hi'],
    { encoding: 'utf8', env: { ...process.env } },
  )
  assert(silentProbe.status === 0 && (silentProbe.stderr ?? '') === '', `an unknown resume must be silent: ${silentProbe.status} ${JSON.stringify(silentProbe.stderr)}`)
  assert(existsSync(storePath(silentId)), 'an unknown resume must silently adopt the id')
  rmSync(join(chatsRoot, workspaceHash, silentId), { recursive: true, force: true })

  await collectStop(deadAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    sessionId: deadSession,
    system: deadSystem,
    messages: deadTurn('d2'),
  }, 'dead-resume re-anchor')
  const deadReanchorArgv = await readArgv(argvLog)
  assertArgvShape(deadReanchorArgv, 'dead-resume re-anchor')
  const deadNewId = flagValues(deadReanchorArgv, '--new-session-id')[0]
  assert(deadNewId && deadNewId !== deadFirstId, 'a missing chat store must re-anchor a fresh CLI session')
  assert(flagValues(deadReanchorArgv, '--resume').length === 0, 'a missing chat store must not resume')
  assert(positional(deadReanchorArgv).includes(deadSystem), 'the re-anchor must re-deliver the DSH system prompt')
  assert(positional(deadReanchorArgv).includes(factTurn), 'the re-anchor must re-deliver the prior turns')
  assert(positional(deadReanchorArgv).includes(factQuestion), 'the re-anchor must carry the newest turn')
  assert(existsSync(storePath(deadNewId)), 'the re-anchored chat must be delivered exactly once')

  await collectStop(deadAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'medium',
    sessionId: deadSession,
    system: deadSystem,
    messages: [
      ...deadTurn('d2'),
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'AUBERGINE-77' }] },
      { id: 'd3', role: 'user', content: [{ type: 'text', text: 'Say OK again.' }] },
    ],
  }, 'dead-resume steady state')
  const deadSteadyArgv = await readArgv(argvLog)
  assertArgvShape(deadSteadyArgv, 'dead-resume steady state')
  assert(flagValues(deadSteadyArgv, '--resume')[0] === deadNewId, 'steady state must resume the re-anchored chat')
  assert(positional(deadSteadyArgv) === 'Say OK again.', `steady payload: ${JSON.stringify(positional(deadSteadyArgv))}`)

  // -------------------------------------------------------------------------
  // Collision and id-shape recoveries still work
  // -------------------------------------------------------------------------
  const collideSession = 'sess-collide'
  const collideId = shim.sessionUuidFor(`${collideSession}#0`)
  mkdirSync(join(chatsRoot, workspaceHash, collideId), { recursive: true })
  writeFileSync(storePath(collideId), '')
  await collectStop(new adapter.CursorLlmAdapter(), {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: collideSession,
    system: 'Collision system prompt.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'collision' }] }],
  }, 'store collision')
  const collideArgv = await readArgv(argvLog)
  assertArgvShape(collideArgv, 'store collision')
  assert(flagValues(collideArgv, '--resume')[0] === collideId, 'an existing chat must be resumed after the collision')

  // If a future CLI rejects the derived id's shape, one random UUIDv4 keeps the turn alive.
  const forcedSession = 'sess-forced-invalid'
  const forcedId = shim.sessionUuidFor(`${forcedSession}#0`)
  process.env.FAKE_AGENT_INVALID_SESSION_ID = forcedId
  await collectStop(new adapter.CursorLlmAdapter(), {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: forcedSession,
    system: 'Forced id system prompt.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'forced' }] }],
  }, 'forced invalid id')
  delete process.env.FAKE_AGENT_INVALID_SESSION_ID
  const forcedArgv = await readArgv(argvLog)
  assertArgvShape(forcedArgv, 'forced invalid id')
  const forcedRetryId = flagValues(forcedArgv, '--new-session-id')[0]
  assert(
    forcedRetryId !== undefined && forcedRetryId !== forcedId && shim.isSessionUuidV4(forcedRetryId),
    `forced-id recovery must mint a random UUIDv4: ${forcedRetryId}`,
  )

  // -------------------------------------------------------------------------
  // Abort and failure paths keep their terminal finishes
  // -------------------------------------------------------------------------
  const abortedController = new AbortController()
  abortedController.abort()
  const aborted = await collect(new adapter.CursorLlmAdapter(), {
    provider: 'cursor',
    model: 'grok-4.7',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'aborted' }] }],
    signal: abortedController.signal,
  })
  assert(aborted.length === 1 && aborted[0].type === 'finish', `aborted chunks: ${JSON.stringify(aborted)}`)
  assert(aborted[0].reason.kind === 'aborted', `aborted finish: ${JSON.stringify(aborted[0])}`)

  // Mid-stream abort: the turn stops with an aborted finish and leaves no
  // checkpoint behind, so the next call bootstraps a fresh session.
  const abortController = new AbortController()
  const abortAdapter = new adapter.CursorLlmAdapter()
  const midAbort = []
  for await (const chunk of abortAdapter.stream({
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-abort',
    system: 'Abort system prompt.',
    messages: [{ id: 'ab1', role: 'user', content: [{ type: 'text', text: 'abort me' }] }],
    signal: abortController.signal,
  })) {
    midAbort.push(chunk)
    if (midAbort.length === 1) abortController.abort()
  }
  assert(
    midAbort.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'aborted'),
    `mid-stream abort finish: ${JSON.stringify(midAbort.filter((chunk) => chunk.type === 'finish'))}`,
  )
  await collect(abortAdapter, {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: 'sess-abort',
    system: 'Abort system prompt.',
    messages: [
      { id: 'ab1', role: 'user', content: [{ type: 'text', text: 'abort me' }] },
      { id: 'ab2', role: 'user', content: [{ type: 'text', text: 'after abort' }] },
    ],
  })
  const afterAbortArgv = await readArgv(argvLog)
  assertArgvShape(afterAbortArgv, 'after abort')
  assert(
    flagValues(afterAbortArgv, '--new-session-id').length === 1,
    'an aborted turn must not leave a delivered checkpoint behind',
  )
  assert(positional(afterAbortArgv).includes('Abort system prompt.'), 'after abort must re-bootstrap the context')

  const invalidArgs = await collect(new adapter.CursorLlmAdapter(), {
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'max',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'max effort' }] }],
  })
  const invalidFinish = invalidArgs.filter((chunk) => chunk.type === 'finish')[0]
  assert(invalidFinish.reason.kind === 'error', 'an unadvertised effort must fail the call')
  assert(invalidFinish.reason.failure.code === 'INVALID_ARGS', `unadvertised effort code: ${invalidFinish.reason.failure.code}`)
  assert(!JSON.stringify(invalidArgs).includes('[effort='), 'an unadvertised effort produced a bracket override')
  restore()
} finally {
  await rm(tmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Missing binary / unauthenticated paths
// ---------------------------------------------------------------------------
const restoreEnv = applyEnv({ CURSOR_AGENT_BIN: '/no/such/cursor-agent-bin', CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined, FAKE_AGENT_STATUS: undefined })
const missingStarted = Date.now()
const missing = await collect(new adapter.CursorLlmAdapter(), {
  provider: 'cursor',
  model: 'gpt-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})
const missingElapsed = Date.now() - missingStarted
const missingFinish = missing.find((chunk) => chunk.type === 'finish')
assert(missingFinish?.reason?.kind === 'error', `missing-bin finish kind: ${JSON.stringify(missingFinish)}`)
assert(missingFinish.reason.failure.code === 'MISSING_CREDENTIAL', `missing-bin code: ${JSON.stringify(missingFinish.reason.failure)}`)
assert(missingElapsed < 8_000, `missing-bin hung: ${missingElapsed}ms`)
restoreEnv()

const restoreAuth = applyEnv({ CURSOR_AGENT_BIN: fakeAgent, FAKE_AGENT_STATUS: 'unauthenticated', CURSOR_API_KEY: undefined, CURSOR_AUTH_TOKEN: undefined })
const authStarted = Date.now()
const auth = await collect(new adapter.CursorLlmAdapter(), {
  provider: 'cursor',
  model: 'gpt-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})
const authElapsed = Date.now() - authStarted
const authFinish = auth.find((chunk) => chunk.type === 'finish')
assert(authFinish?.reason?.kind === 'error', `auth finish kind: ${JSON.stringify(authFinish)}`)
assert(authFinish.reason.failure.code === 'AUTH', `auth code: ${JSON.stringify(authFinish.reason.failure)}`)
assert(authElapsed < 15_000, `auth hung: ${authElapsed}ms`)
restoreAuth()

// ---------------------------------------------------------------------------
// Registration wiring + AgentTeams profile
// ---------------------------------------------------------------------------
const registered = []
const directory = []
const logs = []
lib.apply(
  {
    get: (name) => {
      if (name === 'logger') return { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
      if (name === 'llm') {
        return {
          registerAdapter: (providers, instance) => {
            registered.push({ providers, instance })
          },
          registerConfigurableProviders: (entries) => {
            directory.push(...entries)
            return { replace: (next) => { directory.splice(0, directory.length, ...next) } }
          },
        }
      }
      return undefined
    },
    on: () => {},
    effect: () => {},
    plugin: () => {},
  },
  { assets: false, models: true },
)
assert(registered.length === 1 && registered[0].providers[0] === 'cursor', `registerAdapter: ${JSON.stringify(registered.map((r) => r.providers))}`)
assert(typeof registered[0].instance.stream === 'function', 'adapter.stream')
assert(directory.some((entry) => entry.provider === 'cursor'), 'configurable provider')
assert(logs.some((line) => String(line).includes('LLM adapter registered')), `register log: ${logs.join(' | ')}`)

const profile = await readFile(join(root, 'examples/teams/cursor-member.yml'), 'utf8')
assert(/provider:\s*cursor/.test(profile), 'profile provider')
assert(/model:\s*cursor-grok-4\.6(-high)?\b/.test(profile), 'profile model')
assert(/reasoningEffort:\s*high/.test(profile), 'profile effort')
assert(/- mailbox/.test(profile) && /- task/.test(profile), 'profile mailbox/task tools')
assert(!/^\s*-\s*cursor_agent_/m.test(profile), 'profile has no ACP tools')

console.log('verify-models: ok')
