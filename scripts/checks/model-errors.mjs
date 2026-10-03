import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const cli = await import(pathToFileURL(join(process.cwd(), 'lib/models/cli.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const saved = {
  bin: process.env.CURSOR_AGENT_BIN,
  key: process.env.CURSOR_API_KEY,
  token: process.env.CURSOR_AUTH_TOKEN,
}
const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-errors-'))
try {
  const calls = join(root, 'calls.txt')
  const agent = join(root, 'agent.mjs')
  await writeFile(
    agent,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n')
if (process.argv[2] === 'status') {
  process.stdout.write('{"isAuthenticated":true}')
}
process.exit(0)
`,
  )
  await chmod(agent, 0o755)
  process.env.CURSOR_AGENT_BIN = agent
  process.env.CURSOR_API_KEY = 'present-key'
  delete process.env.CURSOR_AUTH_TOKEN
  const probe = await cli.probeCursorCli()
  const { readFile } = await import('node:fs/promises')
  const log = await readFile(calls, 'utf8')
  assert(log.includes('status'), 'an env credential skipped agent status')
  assert(probe.authenticated === true, `status probe failed: ${JSON.stringify(probe)}`)

  await assertRejects(
    cli.listCursorModelCatalog(agent),
    cli.EMPTY_CATALOG_CODE,
    'empty catalog',
  )

  const sleeper = join(root, 'sleep-agent.mjs')
  await writeFile(sleeper, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  await chmod(sleeper, 0o755)
  process.env.CURSOR_AGENT_BIN = sleeper
  const started = Date.now()
  const timed = await cli.probeCursorCli()
  const elapsed = Date.now() - started
  assert(timed.code === cli.TIMEOUT_CODE, `timeout was classified as ${timed.code}: ${timed.error}`)
  assert(elapsed < 20_000, `timeout hung for ${elapsed}ms`)
} finally {
  restore('CURSOR_AGENT_BIN', saved.bin)
  restore('CURSOR_API_KEY', saved.key)
  restore('CURSOR_AUTH_TOKEN', saved.token)
  await rm(root, { recursive: true, force: true })
}

function restore(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function assertRejects(promise, code, label) {
  try {
    await promise
  } catch (error) {
    assert(error?.code === code, `${label} code was ${error?.code}: ${error?.message}`)
    return
  }
  throw new Error(`${label} did not fail`)
}

console.log('checks/model-errors: ok')
