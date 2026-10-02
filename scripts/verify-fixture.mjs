import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)
const hooks = await import(pathToFileURL(join(process.cwd(), 'lib/hooks/run.js')).href)
const settings = await import(pathToFileURL(join(process.cwd(), 'lib/settings.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function textFromInjected(value) {
  const content = value?.content
  if (!Array.isArray(content)) return JSON.stringify(value)
  return content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n')
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(label)
}

const source = join(process.cwd(), 'fixtures', 'cursor-workspace')
const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-fixture-'))
const userDir = join(root, 'nouser')
try {
  await cp(source, root, { recursive: true })
  await mkdir(join(root, '.git'))
  await mkdir(userDir, { recursive: true })

  const injected = []
  const agent = {
    inject: (message) => injected.push(message),
    session: { id: 'fixture', header: { cwd: root } },
  }
  const listeners = new Map()
  let skillProvider
  const logs = []
  lib.apply(
    {
      get: (name) => {
        if (name === 'logger') return { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
        if (name === 'skills') {
          return {
            registerProvider: (create) => {
              skillProvider = create({
                invalidate: () => {},
                signal: new AbortController().signal,
              })
              return skillProvider
            },
          }
        }
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
    {
      models: false,
      watch: false,
      mcp: false,
      permissions: false,
      userCursorDir: userDir,
    },
  )

  assert(skillProvider, 'skill provider registered')
  const listed = await skillProvider.list({ cwd: root })
  const candidates = Array.isArray(listed) ? listed : listed.candidates
  const names = candidates.map((c) => c.name)
  assert(names.includes('fixture-skill'), `catalog skill load: ${names}`)
  assert(names.includes('named'), `description-only rule in catalog: ${names}`)

  for (const listener of listeners.get('agent/session-start') ?? []) {
    listener({ agent })
  }
  await waitFor(
    () => injected.some((message) => textFromInjected(message).includes('fixture-always') || textFromInjected(message).includes('Always apply this fixture rule')),
    `always-apply did not inject: ${injected.map(textFromInjected).join(' | ')}`,
  )

  const touch = join(root, 'src', 'example.ts')
  for (const listener of listeners.get('tools/result') ?? []) {
    listener({
      name: 'read',
      arguments: { file_path: touch },
      agent,
    })
  }
  await waitFor(
    () => injected.some((message) => textFromInjected(message).includes('Glob fixture rule')),
    `glob attach missing: ${injected.map(textFromInjected).join(' | ')}`,
  )
  await waitFor(
    () => injected.some((message) => textFromInjected(message).includes('Fixture skill body')),
    `skill path attach missing: ${injected.map(textFromInjected).join(' | ')}`,
  )

  const pre = listeners.get('tools/pre-execute') ?? []
  assert(pre.length > 0, 'tools/pre-execute listener')
  const decision = await pre[0](
    { name: 'bash', arguments: { command: 'echo fixture' }, agent },
    async () => ({ kind: 'allow' }),
  )
  assert(decision?.kind === 'deny', `hook deny: ${JSON.stringify(decision)}`)
  assert(String(decision.reason).includes('fixture hook denied'), `deny reason: ${JSON.stringify(decision)}`)

  const loaded = await new settings.CursorSettingsLoader({}, userDir).load(root)
  const groups = loaded.byEvent.get('preToolUse') ?? []
  const outcomes = await hooks.runEventHooks(
    {
      event: 'preToolUse',
      groups,
      matchedValue: 'Shell',
      input: { tool_name: 'Shell', cwd: root },
      cwd: root,
      defaultTimeoutMs: 5000,
    },
    {},
  )
  assert(
    outcomes.some((outcome) => outcome.output?.permission === 'deny'),
    `shell hook json deny: ${JSON.stringify(outcomes)}`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('verify-fixture: ok')
