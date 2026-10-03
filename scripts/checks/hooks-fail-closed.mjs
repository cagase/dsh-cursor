import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const permissions = await import(pathToFileURL(join(process.cwd(), 'lib/permissions.js')).href)
const hooks = await import(pathToFileURL(join(process.cwd(), 'lib/hooks/index.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const agent = { inject() {}, session: { id: 'fail', header: { cwd: '/tmp' } } }
const exec = { name: 'read', arguments: { file_path: '/tmp/a.ts' }, agent, callId: '1' }

let allowed = false
const gate = permissions.createPermissionsGate(
  { warn() {} },
  { load: async () => { throw new Error('permissions unreadable') } },
)
const denied = await gate(exec, async () => {
  allowed = true
  return { kind: 'allow' }
})
assert(denied?.kind === 'deny', `permission failure was allowed: ${JSON.stringify(denied)}`)
assert(allowed === false, 'permission failure called next()')
assert(String(denied.reason).includes('permissions unreadable'), `deny reason: ${denied.reason}`)

let mailboxAllowed = false
const mailbox = await gate(
  { name: 'mailbox', arguments: {}, agent, callId: 'mb' },
  async () => {
    mailboxAllowed = true
    return { kind: 'allow' }
  },
)
assert(mailbox?.kind === 'allow', `mailbox was denied when permissions threw: ${JSON.stringify(mailbox)}`)
assert(mailboxAllowed === true, 'mailbox did not call next()')

const warnings = []
const listeners = new Map()
hooks.registerHooks(
  {
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    effect: () => {},
  },
  { warn: (message) => warnings.push(message), info() {} },
  { load: async () => { throw new Error('hooks unreadable') } },
  { hookTimeoutMs: 1000, maxHookOutputChars: 1000 },
)
const pre = listeners.get('tools/pre-execute') ?? []
assert(pre.length === 1, 'pre-execute listener missing')
let hooked = false
const hookDenied = await pre[0](exec, async () => {
  hooked = true
  return { kind: 'allow' }
})
assert(hookDenied?.kind === 'deny', `hook failure was allowed: ${JSON.stringify(hookDenied)}`)
assert(hooked === false, 'hook failure called next()')
assert(warnings.some((message) => message.includes('hooks unreadable')), `hook failure was not logged: ${warnings.join(' | ')}`)
let taskAllowed = false
const taskAllowedDecision = await pre[0](
  { name: 'task', arguments: {}, agent, callId: 'task' },
  async () => {
    taskAllowed = true
    return { kind: 'allow' }
  },
)
assert(taskAllowedDecision?.kind === 'allow', `task was denied when hooks threw: ${JSON.stringify(taskAllowedDecision)}`)
assert(taskAllowed === true, 'task did not call next()')

const approvalWarnings = []
const approvalGate = permissions.createPermissionsGate(
  { warn: (message) => approvalWarnings.push(message) },
  {
    load: async () => ({
      permissionAllow: [],
      permissionDeny: [],
      approvalMode: 'unrestricted',
      mcpAllowlist: [],
      terminalAllowlist: [],
    }),
  },
)
await approvalGate(exec, async () => ({ kind: 'allow' }))
await approvalGate(exec, async () => ({ kind: 'allow' }))
assert(approvalWarnings.length === 1, `approvalMode warned ${approvalWarnings.length} times`)

const inside = permissions.evaluateCursorPermissions(
  [],
  ['Read(src/**)'],
  { name: 'read', arguments: { file_path: '/repo/src/a.ts' } },
  '/repo',
)
assert(inside?.kind === 'deny', 'session-relative read deny missed')
const outside = permissions.evaluateCursorPermissions(
  [],
  ['Read(src/**)'],
  { name: 'read', arguments: { file_path: '/other/src/a.ts' } },
  '/repo',
)
assert(outside === undefined, `path outside the session was denied: ${JSON.stringify(outside)}`)
const ancestor = permissions.evaluateCursorPermissions(
  [],
  ['Read(src/**)'],
  { name: 'read', arguments: { file_path: '/Users/me/src/app/package.json' } },
  '/Users/me/src/app',
)
assert(ancestor === undefined, `ancestor src segment was denied: ${JSON.stringify(ancestor)}`)

console.log('checks/hooks-fail-closed: ok')
