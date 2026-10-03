import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function textFrom(value) {
  const content = value?.content
  if (!Array.isArray(content)) return JSON.stringify(value)
  return content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n')
}

const savedConfigDir = process.env.CURSOR_CONFIG_DIR
delete process.env.CURSOR_CONFIG_DIR

const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-hooks-'))
const userDir = join(root, 'user')
try {
  await mkdir(join(root, '.cursor'), { recursive: true })
  await mkdir(userDir, { recursive: true })
  const hook = (marker) =>
    `printf '%s' '{"additional_context":"${marker}"}'`
  await writeFile(
    join(root, '.cursor', 'hooks.json'),
    JSON.stringify({
      hooks: {
        beforeReadFile: [{ command: hook('before-read') }],
        afterFileEdit: [{ command: hook('after-edit') }],
      },
    }),
  )

  const injected = []
  const agent = {
    inject: (message) => injected.push(message),
    session: { id: 'hooks', header: { cwd: root } },
  }
  const listeners = new Map()
  lib.apply(
    {
      get: (name) => (name === 'logger' ? { warn() {}, info() {} } : undefined),
      on: (event, listener) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
      },
      effect: () => {},
      plugin: () => {},
    },
    { models: false, watch: false, mcp: false, permissions: false, assets: true, userCursorDir: userDir },
  )

  const pre = listeners.get('tools/pre-execute') ?? []
  const post = listeners.get('tools/post-execute') ?? []
  assert(pre.length === 1 && post.length === 1, 'hook listeners missing')

  injected.length = 0
  await pre[0](
    { name: 'read', arguments: { file_path: join(root, 'src', 'a.ts') }, agent, callId: 'r' },
    async () => ({ kind: 'allow' }),
  )
  const readPre = injected.map(textFrom).join('\n')
  assert(readPre.includes('before-read'), `read pre missed beforeReadFile: ${readPre}`)
  assert(!readPre.includes('after-edit'), `read pre ran afterFileEdit: ${readPre}`)

  injected.length = 0
  await pre[0](
    { name: 'write', arguments: { file_path: join(root, 'src', 'a.ts') }, agent, callId: 'w' },
    async () => ({ kind: 'allow' }),
  )
  const writePre = injected.map(textFrom).join('\n')
  assert(!writePre.includes('before-read'), `write pre ran beforeReadFile: ${writePre}`)

  const readPost = await post[0](
    { name: 'read', arguments: { file_path: join(root, 'src', 'a.ts') }, agent, callId: 'r2' },
    { isError: false },
    async () => ({ kind: 'accept', additionalContexts: [] }),
  )
  const readPostText = (readPost.additionalContexts ?? []).map(textFrom).join('\n')
  assert(!readPostText.includes('after-edit'), `read post ran afterFileEdit: ${readPostText}`)

  const writePost = await post[0](
    { name: 'edit', arguments: { file_path: join(root, 'src', 'a.ts') }, agent, callId: 'e' },
    { isError: false },
    async () => ({ kind: 'accept', additionalContexts: [] }),
  )
  const writePostText = (writePost.additionalContexts ?? []).map(textFrom).join('\n')
  assert(writePostText.includes('after-edit'), `edit post missed afterFileEdit: ${writePostText}`)
} finally {
  if (savedConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = savedConfigDir
  await rm(root, { recursive: true, force: true })
}

console.log('checks/hooks-events: ok')
