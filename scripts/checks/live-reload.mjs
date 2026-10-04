import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)
const rules = await import(pathToFileURL(join(process.cwd(), 'lib/rules/index.js')).href)
const mcp = await import(pathToFileURL(join(process.cwd(), 'lib/mcp.js')).href)
const sessions = await import(pathToFileURL(join(process.cwd(), 'lib/live-sessions.js')).href)

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
  const afterResume = injected.length
  for (const listener of listeners.get('agent/session-start') ?? []) {
    listener({ source: 'resume', agent })
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert(injected.length === afterResume, 'a second resume stacked the same always-apply rules')
  const other = join(root, 'other')
  await mkdir(other, { recursive: true })
  const otherAgent = {
    inject: (message) => injected.push(message),
    session: { id: 'other', header: { cwd: other } },
  }
  for (const listener of listeners.get('agent/session-start') ?? []) {
    listener({ source: 'startup', agent: otherAgent })
  }
  assert(sessions.liveCwds().includes(root) && sessions.liveCwds().includes(other), `live cwds dropped a member: ${sessions.liveCwds().join(', ')}`)
  for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent: otherAgent })
  assert(!sessions.liveCwds().includes(other), `disposed member cwd still live: ${sessions.liveCwds().join(', ')}`)

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
  assert(
    rules.matchingGlobRules(
      [{ kind: 'glob', name: 'n', file: 'f', label: 'l', body: 'b', globs: ['src/**'] }],
      '/other/src/a.ts',
      root,
    ).length === 0,
    'glob rule matched a path outside the session',
  )

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
  mcpListeners.get('agent/session-start')({ agent: { session: { id: 'mcp-root', header: { cwd: root } } } })
  await waitFor(() => mounts.length >= 1, `MCP server did not mount: ${warnings.join(' | ')}`)
  await waitFor(
    () => warnings.some((message) => message.includes('collides')),
    `name collision was not warned: ${warnings.join(' | ')}`,
  )
  assert(mounts.length === 1, `colliding server still mounted: ${mounts.length}`)
  servers = new Map([['foo/bar', { command: 'echo', args: ['changed'], baseDir: root }]])
  mcpListeners.get('agent/session-start')({ agent: { session: { id: 'mcp-root', header: { cwd: root } } } })
  await waitFor(() => disposed.length === 1, 'changed MCP config did not remount')
  await waitFor(() => mounts.length === 2, 'replacement MCP server did not mount')
  assert(mounts[1].args[0] === 'changed', `remount kept the old config: ${JSON.stringify(mounts[1])}`)

  sessions.forgetLiveSession('reload', root)
  sessions.forgetLiveSession('mcp-root', root)
  const cwdA = join(root, 'member-a')
  const cwdB = join(root, 'member-b')
  await mkdir(cwdA, { recursive: true })
  await mkdir(cwdB, { recursive: true })
  const byCwd = new Map([
    [cwdA, new Map([['echo', { command: 'echo', args: ['from-a'], baseDir: cwdA }]])],
    [cwdB, new Map([['echo', { command: 'echo', args: ['from-b'], baseDir: cwdB }]])],
  ])
  const teamMounts = []
  const teamDisposed = []
  const teamListeners = new Map()
  const teamWarnings = []
  mcp.registerMcp(
    {
      on: (event, listener) => {
        const list = teamListeners.get(event) ?? []
        list.push(listener)
        teamListeners.set(event, list)
      },
      effect: () => {},
      plugin: (_plugin, config) => {
        teamMounts.push(config)
        return { dispose: () => teamDisposed.push(config.args?.[0]) }
      },
    },
    { warn: (message) => teamWarnings.push(message), info() {} },
    { load: async (cwd) => ({ mcpServers: byCwd.get(cwd) ?? new Map() }) },
    1000,
  )
  const start = (id, cwd) => {
    for (const listener of teamListeners.get('agent/session-start') ?? []) {
      listener({ agent: { session: { id, header: { cwd } } } })
    }
  }
  start('member-a', cwdA)
  await waitFor(() => teamMounts.length === 1, 'first member MCP did not mount')
  start('member-b', cwdB)
  await waitFor(() => teamMounts.length === 2, `second member MCP clobbered the first: ${teamMounts.length}`)
  assert(
    teamWarnings.some((message) => message.includes('differs')),
    `different MCP configs were not split: ${teamWarnings.join(' | ')}`,
  )
  assert(sessions.liveCwds().includes(cwdA) && sessions.liveCwds().includes(cwdB), 'a member cwd was dropped')
  for (const listener of teamListeners.get('agent/disposed') ?? []) {
    listener({ agent: { session: { id: 'member-a', header: { cwd: cwdA } } } })
  }
  await waitFor(() => teamDisposed.includes('from-a'), 'disposed member MCP server stayed mounted')
  assert(sessions.liveCwds().includes(cwdB) && !sessions.liveCwds().includes(cwdA), `cwd set after dispose: ${sessions.liveCwds().join(', ')}`)
  for (const listener of teamListeners.get('agent/disposed') ?? []) {
    listener({ agent: { session: { id: 'member-b', header: { cwd: cwdB } } } })
  }
  await waitFor(() => !sessions.liveCwds().includes(cwdB), 'second member cwd stayed live')

  const cwdOverlapA = join(root, 'overlap-a')
  const cwdOverlapB = join(root, 'overlap-b')
  await mkdir(cwdOverlapA, { recursive: true })
  await mkdir(cwdOverlapB, { recursive: true })
  const overlapServers = new Map([
    [cwdOverlapA, new Map([['echo', { command: 'echo', args: ['overlap-a'], baseDir: cwdOverlapA }]])],
    [cwdOverlapB, new Map([['echo', { command: 'echo', args: ['overlap-b'], baseDir: cwdOverlapB }]])],
  ])
  let releaseFirst
  let loads = 0
  let critical = 0
  let maxCritical = 0
  const enter = () => {
    critical += 1
    maxCritical = Math.max(maxCritical, critical)
  }
  const leave = () => {
    critical -= 1
  }
  const overlapMounts = []
  const overlapDisposed = []
  const overlapListeners = new Map()
  mcp.registerMcp(
    {
      on: (event, listener) => overlapListeners.set(event, listener),
      effect: () => {},
      plugin: (_plugin, config) => {
        enter()
        overlapMounts.push(config)
        leave()
        return {
          dispose: () => {
            enter()
            overlapDisposed.push(config.args?.[0])
            leave()
          },
        }
      },
    },
    { warn() {}, info() {} },
    {
      load: async (cwd) => {
        loads += 1
        if (loads === 1) await new Promise((resolve) => { releaseFirst = resolve })
        return { mcpServers: overlapServers.get(cwd) ?? new Map() }
      },
    },
    1000,
  )
  overlapListeners.get('agent/session-start')({ agent: { session: { id: 'overlap-a', header: { cwd: cwdOverlapA } } } })
  await waitFor(() => typeof releaseFirst === 'function', 'first reconcile did not reach load')
  overlapListeners.get('agent/session-start')({ agent: { session: { id: 'overlap-b', header: { cwd: cwdOverlapB } } } })
  releaseFirst()
  await waitFor(
    () => overlapMounts.some((config) => config.args?.[0] === 'overlap-a') && overlapMounts.some((config) => config.args?.[0] === 'overlap-b'),
    `latest membership was not mounted: ${overlapMounts.map((config) => config.args?.[0]).join(', ')}`,
  )
  assert(!overlapDisposed.includes('overlap-a'), 'a still-desired server was left disposed')
  assert(maxCritical <= 1, `reconcile mount sections overlapped: ${maxCritical}`)
} finally {
  if (savedConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = savedConfigDir
  await rm(root, { recursive: true, force: true })
}

console.log('checks/live-reload: ok')
