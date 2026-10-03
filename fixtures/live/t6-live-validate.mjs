#!/usr/bin/env node
/**
 * t6 live validation (must run in the DSH host process, where the Cursor agent
 * CLI is authenticated; the AgentTeams bash sandbox cannot read the login
 * keychain — docs/live-cli-contract.md §0).
 *
 * Usage (host process):
 *   node fixtures/live/t6-live-validate.mjs [--seed=<name>] [--agent=<path>]
 *
 * It drives the BUILT adapter against the REAL CLI through a logging wrapper on
 * CURSOR_AGENT_BIN, so the argv that reaches `agent --model` / `--new-session-id`
 * is captured verbatim, and prints one JSON report:
 *   * `newSession` — a real `--new-session-id <minted id>` call (t3 F1);
 *   * `resume`     — a real `--resume <id>` that must recall the fact;
 *   * `deadResume` — with that chat's store removed, the same question must be
 *                    served by a re-anchor (argv shows `--new-session-id` and the
 *                    payload carries the bootstrap context), never a silent
 *                    contextless resume (t3 F2).
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const options = {}
for (const raw of process.argv.slice(2)) {
  const [key, value] = raw.replace(/^--/, '').split('=')
  options[key] = value ?? 'true'
}
const seed = options.seed ?? `t6live-${Date.now()}`
const agentPath = options.agent ?? '/Users/theluiscarbonell/.local/bin/agent'

process.chdir(repo)

const scratch = mkdtempSync(join(tmpdir(), 't6-live-'))
const argvLog = join(scratch, 'argv.log')
const wrapper = join(scratch, 'agent-log.sh')
writeFileSync(wrapper, [
  '#!/bin/sh',
  `printf '%s\\000' "$@" >> ${argvLog}`,
  `printf '\\n===RECORD===\\n' >> ${argvLog}`,
  `exec ${agentPath} "$@"`,
  '',
].join('\n'))
chmodSync(wrapper, 0o755)
writeFileSync(argvLog, '')
process.env.CURSOR_AGENT_BIN = wrapper

const adapter = await import(pathToFileURL(join(repo, 'lib/models/adapter.js')).href)
const session = await import(pathToFileURL(join(repo, 'lib/models/session.js')).href)
const cli = await import(pathToFileURL(join(repo, 'lib/models/cli.js')).href)

function printArgvs() {
  return readFileSync(argvLog, 'utf8')
    .split('\n===RECORD===\n')
    .filter((record) => record !== '')
    .map((record) => {
      const tokens = record.split('\0')
      if (tokens[tokens.length - 1] === '') tokens.pop()
      return tokens
    })
}
const printOnly = () => printArgvs().filter((argv) => argv.includes('--print'))
const flagValue = (argv, flag) => {
  const index = argv.indexOf(flag)
  return index === -1 ? null : argv[index + 1]
}

/** Every directory the CLI stores chats in, without assuming the workspace hash. */
function chatDirs(id) {
  const root = cli.cursorChatsRoot()
  const found = []
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, id)
    if (existsSync(candidate)) found.push(candidate)
  }
  return found
}

const instance = new adapter.CursorLlmAdapter()
const system = 'You are a shim validation harness. Be terse.'
const fact = 'Remember this codeword: PLATYPUS-7731. Reply with just OK.'
const question = 'What codeword did I ask you to remember? Reply with just the codeword, or UNKNOWN.'

async function turn(messages, label) {
  const before = printOnly().length
  const chunks = []
  for await (const chunk of instance.stream({
    provider: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessionId: seed,
    system,
    messages,
  })) {
    chunks.push(chunk)
  }
  const after = printOnly()
  const argv = after[after.length - 1]
  return {
    label,
    newSpawned: after.length > before,
    argv,
    newSessionId: flagValue(argv, '--new-session-id'),
    resumeId: flagValue(argv, '--resume'),
    text: chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''),
    finish: chunks.filter((chunk) => chunk.type === 'finish')[0]?.reason ?? null,
  }
}

const report = {
  capturedAt: new Date().toISOString(),
  seed,
  mintedId: session.sessionUuidFor(`${seed}#0`),
  mintedIdIsV4: session.isSessionUuidV4(session.sessionUuidFor(`${seed}#0`)),
  cwd: process.cwd(),
  chatsRoot: cli.cursorChatsRoot(),
  agent: agentPath,
  mode: 'adapter-driven, real CLI',
}

// Bare CLI call with the exact id the adapter mints (t3 F1 acceptance shape).
report.newSession = await turn(
  [{ id: 'l1', role: 'user', content: [{ type: 'text', text: fact }] }],
  'new-session',
)
report.storeAfterNewSession = chatDirs(report.mintedId)

// A real resume must recall the fact through the CLI's own session store.
report.resume = await turn(
  [
    { id: 'l1', role: 'user', content: [{ type: 'text', text: fact }] },
    { id: 'l2', role: 'assistant', content: [{ type: 'text', text: report.newSession.text }] },
    { id: 'l3', role: 'user', content: [{ type: 'text', text: question }] },
  ],
  'resume',
)

// Remove the chat store: the CLI would silently adopt the id and lose context.
for (const dir of chatDirs(report.mintedId)) rmSync(dir, { recursive: true, force: true })
report.storeRemoved = chatDirs(report.mintedId)

report.deadResume = await turn(
  [
    { id: 'l1', role: 'user', content: [{ type: 'text', text: fact }] },
    { id: 'l2', role: 'assistant', content: [{ type: 'text', text: report.newSession.text }] },
    { id: 'l3', role: 'user', content: [{ type: 'text', text: question }] },
  ],
  'dead-resume',
)
report.payloadCarriedContext = (() => {
  const positional = report.deadResume.argv[report.deadResume.argv.length - 1] ?? ''
  return positional.includes('PLATYPUS-7731') && positional.includes(system)
})()

report.argvSequence = printOnly().map((argv) => ({
  model: flagValue(argv, '--model'),
  newSessionId: flagValue(argv, '--new-session-id'),
  resumeId: flagValue(argv, '--resume'),
  positionalHead: (argv[argv.length - 1] ?? '').slice(0, 120),
}))

console.log(JSON.stringify(report, null, 2))
rmSync(scratch, { recursive: true, force: true })
