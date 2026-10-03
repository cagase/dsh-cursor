#!/usr/bin/env node
/**
 * t8 live round-2 driver (verifier-owned; NOT a product deliverable).
 *
 * Runs the BUILT adapter against the REAL Cursor agent CLI from the DSH host
 * process (the bash sandbox cannot reach the login keychain) and records, for
 * each scenario, the exact argv the adapter spawned, the consumer-visible
 * chunks, and the store facts. The wrapper records argv without changing what
 * the CLI does.
 *
 * Usage: node verifier-live-adapter.mjs <repo> <outJson> [child <payloadJson>]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = process.argv[2] ?? process.cwd()
const outPath = process.argv[3]
const mode = process.argv[4] ?? 'all'
const payloadPath = process.argv[5]

const REAL_AGENT = '/Users/theluiscarbonell/.local/bin/agent'
const WRAPPER = join(here, 'verifier-live-agent-wrapper.sh')
const ART = join(here, 'verifier-artifacts')
mkdirSync(ART, { recursive: true })
const ARGV_LOG = join(ART, `live-round2-argv-${mode}.jsonl`)

const adapterMod = await import(join(repo, 'lib/models/adapter.js'))
const sessionMod = await import(join(repo, 'lib/models/session.js'))

process.env.CURSOR_AGENT_BIN = WRAPPER
process.env.VERIFIER_LIVE_ARGV_LOG = ARGV_LOG
delete process.env.CURSOR_API_KEY
delete process.env.CURSOR_AUTH_TOKEN
process.env.NO_OPEN_BROWSER = '1'

const KEYS = {
  adapterBootstrap: 'LIVE-T8-F1',
  directProbe: 'LIVE-T8-F1-DIRECT',
  absentStore: 'LIVE-T8-F2-ABSENT',
  restart: 'LIVE-T8-F2-RESTART',
}
const SYSTEM = 'You are the t8 live verification harness. Follow the user instruction exactly and answer in as few words as possible.'

function summarize(chunks) {
  return {
    chunks,
    text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
    reasoning: chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''),
    finishes: chunks.filter((c) => c.type === 'finish'),
  }
}
async function drive(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return summarize(chunks)
}
function msg(id, role, text) {
  return { id, role, content: [{ type: 'text', text }] }
}
function chatDirsFor(id) {
  const root = join(homedir(), '.cursor', 'chats')
  const found = []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const p = join(root, entry.name, id)
    if (existsSync(p)) found.push(p)
  }
  return found
}
function allPrintArgvs() {
  if (!existsSync(ARGV_LOG)) return []
  return readFileSync(ARGV_LOG, 'utf8').split('\n')
    .map((l) => { try { return JSON.parse(l) } catch { return undefined } })
    .filter((a) => Array.isArray(a) && a.includes('--print'))
}
const since = (startIndex) => allPrintArgvs().slice(startIndex)

const report = {
  startedAt: new Date().toISOString(),
  mode,
  repo,
  bin: REAL_AGENT,
  wrapper: WRAPPER,
  keys: KEYS,
  derived: {
    adapterBootstrap: sessionMod.sessionUuidFor(`${KEYS.adapterBootstrap}#0`),
    directProbe: sessionMod.sessionUuidFor(`${KEYS.directProbe}#0`),
    absentStore: sessionMod.sessionUuidFor(`${KEYS.absentStore}#0`),
    restart: sessionMod.sessionUuidFor(`${KEYS.restart}#0`),
  },
  mintedIdDirect: null,
  scenarios: {},
  cleanup: {},
  errors: [],
}

try {
  if (mode === 'child') {
    // Restart simulation: a FRESH process + fresh adapter for an existing DSH
    // session. It must derive the same id, collide, and recover.
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
    const adapter = new adapterMod.CursorLlmAdapter({ info() {}, warn() {} })
    const start = allPrintArgvs().length
    const chunks = await drive(adapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high',
      sessionId: KEYS.restart, system: SYSTEM, messages: payload.messages,
    })
    report.scenarios.restartChild = {
      derivedId: sessionMod.sessionUuidFor(`${KEYS.restart}#0`),
      argvs: since(start),
      chunks: chunks.chunks,
      text: chunks.text,
      finishes: chunks.finishes,
    }
  } else {
    // 1) LIVE F1 raw capture: the exact id the adapter mints, handed straight to
    //    the real CLI's --new-session-id.
    const directId = report.derived.directProbe
    const directArgv = ['--print', '--mode', 'ask', '--trust', '--model', 'grok-4.7', '--new-session-id', directId, 'Reply with exactly: OK']
    const direct = spawnSync(REAL_AGENT, directArgv, { encoding: 'utf8', cwd: repo, env: { ...process.env, NO_OPEN_BROWSER: '1' } })
    report.mintedIdDirect = { id: directId, argv: directArgv, exitCode: direct.status, stdout: direct.stdout, stderr: direct.stderr }

    // 2) LIVE F1 through the adapter: full bootstrap turn.
    const adapter = new adapterMod.CursorLlmAdapter({ info() {}, warn() {} })
    let n = allPrintArgvs().length
    const boot = await drive(adapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high',
      sessionId: KEYS.adapterBootstrap, system: SYSTEM,
      messages: [msg('m1', 'user', 'My favorite color is aubergine. Reply with just OK.')],
    })
    report.scenarios.bootstrap = {
      derivedId: report.derived.adapterBootstrap,
      argvs: since(n),
      chunks: boot.chunks,
      text: boot.text,
      finishes: boot.finishes,
      storeAfter: chatDirsFor(report.derived.adapterBootstrap).length > 0,
    }

    // 3) LIVE F2a: resume the same chat and ask for the fact (wording is
    //    informational; the argv/positional is the proof).
    n = allPrintArgvs().length
    const resume = await drive(adapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high',
      sessionId: KEYS.adapterBootstrap, system: SYSTEM,
      messages: [
        msg('m1', 'user', 'My favorite color is aubergine. Reply with just OK.'),
        msg('m2', 'assistant', 'OK'),
        msg('m3', 'user', 'What is my favorite color? Reply with just the color, or UNKNOWN.'),
      ],
    })
    report.scenarios.resume = { argvs: since(n), chunks: resume.chunks, text: resume.text, finishes: resume.finishes }

    // 4) LIVE F2b: the chat store disappears between turns.
    const absentAdapter = new adapterMod.CursorLlmAdapter({ info() {}, warn() {} })
    const absentId = report.derived.absentStore
    const first = msg('a1', 'user', 'Remember this sentence: the spare key is under the blue pot. Reply with just OK.')
    n = allPrintArgvs().length
    const abs1 = await drive(absentAdapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high',
      sessionId: KEYS.absentStore, system: SYSTEM, messages: [first],
    })
    const created = chatDirsFor(absentId)
    for (const dir of created) rmSync(dir, { recursive: true, force: true })
    report.scenarios.absentStore = {
      derivedId: absentId,
      bootstrapArgvs: since(n),
      bootstrapText: abs1.text,
      bootstrapFinishes: abs1.finishes,
      storeCreated: created.length,
      storeDeleted: created,
    }
    const second = msg('a3', 'user', 'Where is the spare key? Reply with just the location, or UNKNOWN.')
    n = allPrintArgvs().length
    const abs2 = await drive(absentAdapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high',
      sessionId: KEYS.absentStore, system: SYSTEM,
      messages: [first, msg('a2', 'assistant', 'OK'), second],
    })
    Object.assign(report.scenarios.absentStore, {
      reanchorArgvs: since(n), reanchorChunks: abs2.chunks, reanchorText: abs2.text, reanchorFinishes: abs2.finishes,
    })
    const third = msg('a5', 'user', 'Name one item in that sentence. Reply with just the item.')
    n = allPrintArgvs().length
    const abs3 = await drive(absentAdapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high',
      sessionId: KEYS.absentStore, system: SYSTEM,
      messages: [first, msg('a2', 'assistant', 'OK'), second, msg('a4', 'assistant', 'under the blue pot'), third],
    })
    Object.assign(report.scenarios.absentStore, {
      steadyArgvs: since(n), steadyText: abs3.text, steadyFinishes: abs3.finishes,
    })

    // 5) LIVE restart: fresh process, fresh registry, same DSH session.
    const restartMessages = [
      first,
      msg('a2', 'assistant', 'OK'),
      third,
    ]
    const restartAdapter = new adapterMod.CursorLlmAdapter({ info() {}, warn() {} })
    n = allPrintArgvs().length
    const rst1 = await drive(restartAdapter, {
      provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'high',
      sessionId: KEYS.restart, system: SYSTEM, messages: restartMessages,
    })
    report.scenarios.restart = {
      derivedId: report.derived.restart,
      parentArgvs: since(n),
      parentText: rst1.text,
      parentFinishes: rst1.finishes,
    }
    const payloadPathLocal = join(ART, 'live-round2-restart-payload.json')
    writeFileSync(payloadPathLocal, JSON.stringify({ messages: restartMessages }))
    const child = spawnSync(process.execPath, [join(here, 'verifier-live-adapter.mjs'), repo, join(ART, 'live-round2-restart-child.json'), 'child', payloadPathLocal], {
      encoding: 'utf8', cwd: repo, env: { ...process.env },
    })
    report.scenarios.restart.childExitCode = child.status
    report.scenarios.restart.childStderr = (child.stderr ?? '').slice(-2000)
    try {
      const parsed = JSON.parse(child.stdout)
      report.scenarios.restartChild = parsed?.scenarios?.restartChild ?? parsed
    } catch { report.errors.push('child stdout was not JSON') }

    // cleanup: remove only the synthetic chats this driver created
    for (const [name, key] of Object.entries(KEYS)) {
      const id = sessionMod.sessionUuidFor(`${key}#0`)
      const dirs = chatDirsFor(id)
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
      report.cleanup[name] = dirs
    }
  }
} catch (error) {
  report.errors.push(`${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error)}`)
}

report.finishedAt = new Date().toISOString()
report.argv = allPrintArgvs()
const json = JSON.stringify(report, null, 2)
if (outPath !== undefined) writeFileSync(outPath, json)
process.stdout.write(json + '\n')
