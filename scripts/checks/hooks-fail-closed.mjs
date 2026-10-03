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

console.log('checks/hooks-fail-closed: ok')
