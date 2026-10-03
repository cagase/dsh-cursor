import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const run = await import(pathToFileURL(join(process.cwd(), 'lib/hooks/run.js')).href)
const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const savedConfigDir = process.env.CURSOR_CONFIG_DIR
delete process.env.CURSOR_CONFIG_DIR

const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-spawn-'))
try {
  const hookDir = join(root, 'user-hooks')
  const sessionDir = join(root, 'session')
  await mkdir(hookDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  const marker = join(hookDir, 'ran.txt')
  await writeFile(join(hookDir, 'marker.sh'), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)
  await chmod(join(hookDir, 'marker.sh'), 0o755)

  const aborted = new AbortController()
  aborted.abort()
  const skipped = await run.runEventHooks(
    {
      event: 'sessionEnd',
      groups: [{ hooks: [{ command: `touch ${JSON.stringify(join(root, 'should-not-exist'))}` }] }],
      matchedValue: undefined,
      input: {},
      cwd: sessionDir,
      defaultTimeoutMs: 5000,
      signal: aborted.signal,
    },
    {},
  )
  assert(skipped[0]?.ran === false, `aborted hook still ran: ${JSON.stringify(skipped)}`)

  const relative = await run.runEventHooks(
    {
      event: 'sessionStart',
      groups: [{ cwd: hookDir, hooks: [{ command: './marker.sh' }] }],
      matchedValue: undefined,
      input: {},
      cwd: sessionDir,
      defaultTimeoutMs: 5000,
    },
    {},
  )
  assert(relative[0]?.exitCode === 0, `relative hook failed: ${JSON.stringify(relative)}`)
  const { readFile } = await import('node:fs/promises')
  assert((await readFile(marker, 'utf8')).trim() === 'ran', 'relative hook did not run in hookDir')

  await mkdir(join(sessionDir, '.cursor', 'hooks'), { recursive: true })
  await writeFile(join(sessionDir, '.cursor', 'hooks', 'noop.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(sessionDir, '.cursor', 'hooks', 'noop.sh'), 0o755)
  const projectStyle = await run.runEventHooks(
    {
      event: 'sessionStart',
      groups: [{ cwd: hookDir, hooks: [{ command: 'sh .cursor/hooks/noop.sh' }] }],
      matchedValue: undefined,
      input: {},
      cwd: sessionDir,
      defaultTimeoutMs: 5000,
    },
    {},
  )
  assert(projectStyle[0]?.exitCode === 0, `project-style hook left the session: ${JSON.stringify(projectStyle)}`)

  const noisy = await run.runEventHooks(
    {
      event: 'sessionStart',
      groups: [{ hooks: [{ command: `node -e 'process.stdout.write("x".repeat(2000000))'` }] }],
      matchedValue: undefined,
      input: {},
      cwd: sessionDir,
      defaultTimeoutMs: 5000,
    },
    {},
  )
  assert(noisy[0]?.stdout.length === 1_048_576, `stdout was not capped: ${noisy[0]?.stdout.length}`)

  const userDir = join(root, 'user')
  await mkdir(join(sessionDir, '.cursor'), { recursive: true })
  await mkdir(userDir, { recursive: true })
  await writeFile(
    join(sessionDir, '.cursor', 'hooks.json'),
    JSON.stringify({
      hooks: {
        preToolUse: [
          { command: "printf '%s' '{\"permission\":\"ask\"}'" },
        ],
        stop: [{ command: "printf '%s' '{\"additional_context\":\"from-stop\"}'" }],
        afterAgentResponse: [{ command: "printf '%s' '{\"additional_context\":\"from-response\"}'" }],
      },
    }),
  )
  const warnings = []
  const injected = []
  const listeners = new Map()
  const agent = {
    inject: (message) => injected.push(message),
    steer() {},
    session: { id: 'spawn', header: { cwd: sessionDir } },
  }
  lib.apply(
    {
      get: (name) => (name === 'logger' ? { warn: (message) => warnings.push(message), info() {} } : undefined),
      on: (event, listener) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
      },
      effect: () => {},
      plugin: () => {},
    },
    { models: false, watch: false, mcp: false, permissions: false, userCursorDir: userDir },
  )
  const pre = listeners.get('tools/pre-execute') ?? []
  const first = await pre[0](
    { name: 'read', arguments: { file_path: join(sessionDir, 'a.ts') }, agent, callId: '1' },
    async () => ({ kind: 'allow' }),
  )
  const second = await pre[0](
    { name: 'read', arguments: { file_path: join(sessionDir, 'a.ts') }, agent, callId: '2' },
    async () => ({ kind: 'allow' }),
  )
  assert(first?.kind === 'allow' && second?.kind === 'allow', `ask was not ignored: ${JSON.stringify(first)} ${JSON.stringify(second)}`)
  const askWarnings = warnings.filter((message) => message.includes('permission "ask"'))
  assert(askWarnings.length === 1, `ask warned ${askWarnings.length} times`)

  for (const listener of listeners.get('agent/turn-stopping') ?? []) listener({ agent })
  const started = Date.now()
  while (Date.now() - started < 4000) {
    const plugins = injected.map((message) => message?.source?.plugin).filter(Boolean)
    if (plugins.some((plugin) => plugin.endsWith('/stop')) && plugins.some((plugin) => plugin.endsWith('/afterAgentResponse'))) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const plugins = injected.map((message) => message?.source?.plugin)
  assert(plugins.some((plugin) => plugin?.endsWith('/stop')), `stop context was mislabeled: ${plugins.join(', ')}`)
  const stopMessage = injected.find((message) => message?.source?.plugin?.endsWith('/stop'))
  const stopText = (stopMessage?.content ?? []).map((block) => block.text ?? '').join('\n')
  assert(stopText.includes('from-stop'), `stop context missing: ${stopText}`)
  assert(!stopText.includes('from-response'), 'stop context included afterAgentResponse text')
} finally {
  if (savedConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = savedConfigDir
  await rm(root, { recursive: true, force: true })
}

console.log('checks/hooks-spawn: ok')
