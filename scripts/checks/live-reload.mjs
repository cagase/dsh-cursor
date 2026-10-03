import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)
const rules = await import(pathToFileURL(join(process.cwd(), 'lib/rules/index.js')).href)
const mcp = await import(pathToFileURL(join(process.cwd(), 'lib/mcp.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function textFrom(value) {
  const content = value?.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n')
}

async function waitFor(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 4000) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(label)
}

const savedConfigDir = process.env.CURSOR_CONFIG_DIR
delete process.env.CURSOR_CONFIG_DIR

const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-reload-'))
const userDir = join(root, 'user')
try {
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true })
  await mkdir(userDir, { recursive: true })
  const ruleFile = join(root, '.cursor', 'rules', 'glob.mdc')
  await writeFile(ruleFile, '---\nalwaysApply: false\nglobs:\n  - "**/*.ts"\n---\nbody one\n')
  await writeFile(join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nalways body\n')

  const injected = []
  const agent = {
    inject: (message) => injected.push(message),
    session: { id: 'reload', header: { cwd: root } },
  }
  const listeners = new Map()
  lib.apply(
    {
      get: (name) => {
        if (name === 'logger') return { warn() {}, info() {} }
        if (name === 'skills') return { registerProvider: () => {} }
        return undefined
      },
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

  for (const listener of listeners.get('agent/session-start') ?? []) {
    listener({ source: 'resume', agent })
  }
  await waitFor(
    () => injected.some((message) => textFrom(message).includes('always body')),
    'resume did not inject always-apply rules',
  )

  injected.length = 0
  const filePath = join(root, 'src', 'a.ts')
  await rules.attachGlobRules(agent, filePath, {})
  assert(injected.some((message) => textFrom(message).includes('body one')), 'glob rule did not attach')
  const afterFirst = injected.length
  await rules.attachGlobRules(agent, filePath, {})
  assert(injected.length === afterFirst, 'unchanged glob rule attached twice')
  await writeFile(ruleFile, '---\nalwaysApply: false\nglobs:\n  - "**/*.ts"\n---\nbody two\n')
  await rules.attachGlobRules(agent, filePath, {})
  assert(injected.some((message) => textFrom(message).includes('body two')), 'edited glob rule did not attach again')

  const warnings = []
  const mounts = []
  const disposed = []
  const mcpListeners = new Map()
  let servers = new Map([
    ['foo/bar', { command: 'echo', args: ['one'], baseDir: root }],
    ['foo_bar', { command: 'echo', args: ['two'], baseDir: root }],
  ])
  mcp.registerMcp(
    {
      on: (event, listener) => mcpListeners.set(event, listener),
      effect: () => {},
      plugin: (_plugin, config) => {
        mounts.push(config)
        return { dispose: () => disposed.push(config.command) }
      },
    },
    { warn: (message) => warnings.push(message), info() {} },
    { load: async () => ({ mcpServers: servers }) },
    1000,
  )
  mcpListeners.get('agent/session-start')({ agent: { session: { header: { cwd: root } } } })
  await waitFor(() => mounts.length >= 1, `MCP server did not mount: ${warnings.join(' | ')}`)
  await waitFor(
    () => warnings.some((message) => message.includes('collides')),
    `name collision was not warned: ${warnings.join(' | ')}`,
  )
  assert(mounts.length === 1, `colliding server still mounted: ${mounts.length}`)
  servers = new Map([['foo/bar', { command: 'echo', args: ['changed'], baseDir: root }]])
  mcpListeners.get('agent/session-start')({ agent: { session: { header: { cwd: root } } } })
  await waitFor(() => disposed.length === 1, 'changed MCP config did not remount')
  await waitFor(() => mounts.length === 2, 'replacement MCP server did not mount')
  assert(mounts[1].args[0] === 'changed', `remount kept the old config: ${JSON.stringify(mounts[1])}`)
} finally {
  if (savedConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = savedConfigDir
  await rm(root, { recursive: true, force: true })
}

console.log('checks/live-reload: ok')
