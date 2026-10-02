import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const adapter = await import(pathToFileURL(join(process.cwd(), 'lib/models/adapter.js')).href)
const cli = await import(pathToFileURL(join(process.cwd(), 'lib/models/cli.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`timed out: ${bin} ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

const profile = await readFile(join(process.cwd(), 'examples/teams/cursor-member.yml'), 'utf8')
assert(/provider:\s*cursor/.test(profile), 'teams profile provider')
assert(/model:\s*cursor-grok-4\.6-high/.test(profile), 'teams profile model')
assert(/- mailbox/.test(profile) && /- task/.test(profile), 'teams mailbox/task')
assert(!/^\s*-\s*cursor_agent_/m.test(profile), 'teams has no ACP tools')

const probe = await cli.probeCursorCli()
if (!probe.bin) {
  console.log('verify-models-live: SKIP (MISSING_CREDENTIAL) — install the Cursor agent CLI, then:')
  console.log('  agent login')
  console.log('  npm run verify:models:live')
  console.log('Human picker/teams commands: fixtures/VERIFY.md')
  process.exit(0)
}
 if (!probe.authenticated) {
  console.log('verify-models-live: SKIP (AUTH) — run `agent login`, then:')
  console.log('  npm run verify:models:live')
  console.log('Human picker/teams commands: fixtures/VERIFY.md')
  process.exit(0)
}

const models = await new adapter.CursorLlmAdapter().listModels('cursor')
assert(models.length > 0, 'picker catalog empty')
assert(models.every((model) => model.provider === 'cursor' && model.id && model.name), 'picker catalog fields')
const route = models.find((model) => model.id === 'cursor-grok-4.6-high') ?? models.find((model) => model.id === 'auto') ?? models[0]
assert(route, 'no selectable Cursor route')
console.log(`verify-models-live: catalog ${models.length} routes; using ${route.id}`)

const printed = await run(probe.bin, [
  '--print',
  '--mode',
  'ask',
  '--trust',
  '--output-format',
  'text',
  '--model',
  route.id,
  'Reply with exactly pong and nothing else.',
], 60_000)
const output = `${printed.stdout}\n${printed.stderr}`
assert(printed.code === 0, `ask-mode session failed (${printed.code}): ${output.slice(0, 800)}`)
assert(/pong/i.test(output), `ask-mode session had no pong: ${output.slice(0, 800)}`)
console.log(`verify-models-live: ask-mode session on ${route.id} returned pong`)

console.log('verify-models-live: adapter catalog + ask-mode session ok')
console.log('verify-models-live: AgentTeams UI member completion is not claimed here — see fixtures/VERIFY.md')
