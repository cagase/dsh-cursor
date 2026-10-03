import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const savedConfigDir = process.env.CURSOR_CONFIG_DIR
delete process.env.CURSOR_CONFIG_DIR

const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-prompt-'))
const userDir = join(root, 'user')
try {
  await mkdir(join(root, '.cursor'), { recursive: true })
  await mkdir(userDir, { recursive: true })
  await writeFile(
    join(root, '.cursor', 'hooks.json'),
    JSON.stringify({
      hooks: {
        beforeSubmitPrompt: [{ command: "printf '%s' '{\"continue\":false,\"user_message\":\"stop this\"}'" }],
      },
    }),
  )

  const warnings = []
  const listeners = new Map()
  const agent = { inject() {}, session: { id: 'prompt', header: { cwd: root } } }
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

  const pre = listeners.get('agent/pre-step') ?? []
  assert(pre.length === 1, 'pre-step listener missing')
  let entered = false
  const decision = await pre[0](
    {
      agent,
      messages: [{ content: [{ type: 'text', text: 'hello' }] }],
    },
    async () => {
      entered = true
      return { kind: 'enter', messages: [] }
    },
  )
  assert(decision?.kind === 'reject', `blocked prompt entered the step: ${JSON.stringify(decision)}`)
  assert(entered === false, 'next() ran after a blocking beforeSubmitPrompt hook')
  assert(warnings.some((message) => message.includes('stop this')), `block reason was not logged: ${warnings.join(' | ')}`)
} finally {
  if (savedConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = savedConfigDir
  await rm(root, { recursive: true, force: true })
}

console.log('checks/hooks-prompt: ok')
