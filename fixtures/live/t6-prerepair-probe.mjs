#!/usr/bin/env node
/**
 * t6 repair evidence harness: run the two t3 defects (F1 minted-id rejection,
 * F2 silent dead-resume) against an arbitrary `lib/` directory.
 *
 * Usage: node fixtures/live/t6-prerepair-probe.mjs <libDir> <variantLabel>
 *
 * It drives the BUILT adapter end-to-end through fixtures/live/fake-agent.sh
 * (which enforces the live UUIDv4 rule and the live silent-fresh-resume rule),
 * with HOME pointed at a scratch directory so no real chat store is touched.
 * It intentionally avoids the repaired lib's new exports so it can also run
 * against the pre-repair build.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = resolve(process.argv[2] ?? join(here, '..', '..', 'lib'))
const label = process.argv[3] ?? libDir
const fakeAgent = join(here, 'fake-agent.sh')
const workspaceHash = process.env.FAKE_AGENT_WORKSPACE_HASH ?? '766fe73c06573698c270309a02f752f8'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const root = mkdtempSync(join(tmpdir(), 't6-probe-'))
const home = join(root, 'home')
const chatsRoot = join(home, '.cursor', 'chats')
const argvLog = join(root, 'argv.bin')
mkdirSync(home, { recursive: true })
process.env.HOME = home
delete process.env.CURSOR_CHATS_DIR
process.env.CURSOR_API_KEY = 'probe-key'
process.env.CURSOR_AGENT_BIN = fakeAgent
process.env.FAKE_AGENT_STREAM = join(here, 'stream-json.jsonl')
process.env.FAKE_AGENT_ARGV_LOG = argvLog

const session = await import(pathToFileURL(join(libDir, 'models', 'session.js')).href)
const adapterModule = await import(pathToFileURL(join(libDir, 'models', 'adapter.js')).href)

const storePath = (id) => join(chatsRoot, workspaceHash, id, 'store.db')
const readArgv = () => {
  const parts = readFileSync(argvLog, 'utf8').split('\0')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}
const flagValues = (argv, flag) => argv.flatMap((token, index) => (token === flag ? [argv[index + 1]] : []))
const positional = (argv) => argv[argv.length - 1]

async function run(instance, options) {
  const chunks = []
  for await (const chunk of instance.stream(options)) chunks.push(chunk)
  const finish = chunks.filter((chunk) => chunk.type === 'finish')[0] ?? null
  return { chunks, finish }
}

const results = { label, libDir }

// P1 — the id the adapter mints for a DSH session.
const seed = 'S1#0'
const minted = session.sessionUuidFor(seed)
results.P1 = {
  check: `the minted id for ${seed} is a UUIDv4 the live CLI accepts`,
  id: minted,
  validV4: UUID_V4.test(minted),
  ok: UUID_V4.test(minted),
}
const v5Probe = spawnSync(
  fakeAgent,
  ['--print', '--model', 'grok-4.7', '--new-session-id', '39d32074-6362-53fa-8eb7-84ae8c182d38', 'Reply with exactly: OK'],
  { encoding: 'utf8', env: { ...process.env } },
)
results.standIn = {
  check: 'the stand-in enforces the live UUIDv4 rule',
  v5Exit: v5Probe.status,
  v5Stderr: (v5Probe.stderr ?? '').trim(),
  ok: v5Probe.status === 1 && /expected a UUIDv4/.test(v5Probe.stderr ?? ''),
}

// P2 — the whole bootstrap turn against the enforcing stand-in.
const bootstrap = await run(new adapterModule.CursorLlmAdapter(), {
  provider: 'cursor',
  model: 'grok-4.7',
  reasoningEffort: 'high',
  sessionId: 'probe-bootstrap',
  system: 'Probe system prompt.',
  messages: [{ id: 'p1', role: 'user', content: [{ type: 'text', text: 'bootstrap probe' }] }],
})
const bootstrapArgv = readArgv()
const bootstrapId = flagValues(bootstrapArgv, '--new-session-id')[0]
results.P2 = {
  check: 'a bootstrap turn completes (stop finish) against a CLI that enforces the UUIDv4 rule',
  argv: bootstrapArgv,
  mintedId: bootstrapId,
  finishKind: bootstrap.finish?.reason?.kind ?? null,
  finishFailure: bootstrap.finish?.reason?.failure ?? null,
  storeCreated: bootstrapId !== undefined && existsSync(storePath(bootstrapId)),
  ok: bootstrap.finish?.reason?.kind === 'stop',
}

// P3 — a resume whose chat store is gone must re-anchor with the full context.
const deadSession = 'probe-dead'
const deadSystem = 'Probe dead-resume system prompt.'
// One adapter instance owns one session registry, exactly like one DSH session.
const deadAdapter = new adapterModule.CursorLlmAdapter()
const first = await run(deadAdapter, {
  provider: 'cursor',
  model: 'grok-4.7',
  reasoningEffort: 'high',
  sessionId: deadSession,
  system: deadSystem,
  messages: [{ id: 'd1', role: 'user', content: [{ type: 'text', text: 'Remember AUBERGINE-77. Reply OK.' }] }],
})
const firstArgv = readArgv()
const firstId = flagValues(firstArgv, '--new-session-id')[0]
if (firstId !== undefined) rmSync(join(chatsRoot, workspaceHash, firstId), { recursive: true, force: true })
const second = await run(deadAdapter, {
  provider: 'cursor',
  model: 'grok-4.7',
  reasoningEffort: 'high',
  sessionId: deadSession,
  system: deadSystem,
  messages: [
    { id: 'd1', role: 'user', content: [{ type: 'text', text: 'Remember AUBERGINE-77. Reply OK.' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
    { id: 'd2', role: 'user', content: [{ type: 'text', text: 'What codeword? Reply with it or UNKNOWN.' }] },
  ],
})
const secondArgv = readArgv()
const reanchorId = flagValues(secondArgv, '--new-session-id')[0]
results.P3 = {
  check: 'with the chat store absent, the same session re-anchors (--new-session-id + full DSH context) instead of resuming',
  first: { argv: firstArgv, finishKind: first.finish?.reason?.kind ?? null },
  second: {
    argv: secondArgv,
    resumedId: flagValues(secondArgv, '--resume')[0] ?? null,
    reanchoredId: reanchorId ?? null,
    finishKind: second.finish?.reason?.kind ?? null,
    payloadHasSystem: positional(secondArgv)?.includes(deadSystem) ?? false,
    payloadHasPriorTurn: positional(secondArgv)?.includes('AUBERGINE-77') ?? false,
  },
  // The scenario is only meaningful once the first turn actually established a
  // checkpoint; a build whose bootstrap fails cannot re-anchor and fails here too.
  checkpointEstablished: first.finish?.reason?.kind === 'stop',
  ok: first.finish?.reason?.kind === 'stop'
    && (flagValues(secondArgv, '--resume')[0] ?? null) === null
    && reanchorId !== undefined
    && reanchorId !== firstId
    && positional(secondArgv)?.includes(deadSystem) === true
    && positional(secondArgv)?.includes('AUBERGINE-77') === true,
}

rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify(results, null, 2))
