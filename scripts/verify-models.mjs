import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)
const adapter = await import(pathToFileURL(join(process.cwd(), 'lib/models/adapter.js')).href)
const cli = await import(pathToFileURL(join(process.cwd(), 'lib/models/cli.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

assert(lib.PROVIDER_ID === 'cursor', 'PROVIDER_ID')
assert(typeof lib.registerCursorAdapter === 'function', 'registerCursorAdapter export')
assert(typeof lib.apply === 'function', 'apply')

assert(cli.wireCursorModel('grok-4.6') === 'grok-4.6', 'wire base')
assert(cli.wireCursorModel('grok-4.6-fast') === 'grok-4.6-fast', 'wire fast passthrough')
assert(cli.wireCursorModel('grok-4.6-xhigh') === 'grok-4.6-xhigh', 'wire xhigh passthrough')
assert(cli.wireCursorModel('grok-4.6', 'high') === 'grok-4.6[effort=high]', 'wire effort')
assert(cli.wireCursorModel('grok-4.6-fast', 'xhigh') === 'grok-4.6[effort=max,fast=true]', 'wire fast+xhigh')
assert(cli.wireCursorModel('claude-opus-4-8[context=1m,effort=high]') === 'claude-opus-4-8[context=1m,effort=high]', 'passthrough')
assert(cli.parseCursorModelId('grok-4.6-fast').base === 'grok-4.6', 'parse fast base')
assert(cli.parseModelList('gpt-5\nsonnet-4-thinking\n').join(',') === 'gpt-5,sonnet-4-thinking', 'parse list')
assert(cli.parseModelList('Available models\ncursor-grok-4.6-high - Grok 4.6\n').join(',') === 'cursor-grok-4.6-high', 'parse labeled list')
assert(cli.classifyCliFailure("Error: Authentication required. Run 'agent login'").code === 'AUTH', 'classify AUTH')
assert(cli.classifyCliFailure('Not logged in').code === 'AUTH', 'classify not logged in')
assert(cli.classifyCliFailure('Cannot use this model: gpt-5. Available models: auto').code === 'INVALID_ARGS', 'classify unknown model')

const prompt = adapter.flattenGeneratePrompt({
  provider: 'cursor',
  model: 'grok-4.6',
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
})
assert(prompt.includes('System:'), 'flatten system')
assert(prompt.includes('hello'), 'flatten user')

const catalog = adapter.expandModelCatalog(['gpt-5'], true)
assert(catalog.some((m) => m.id === 'gpt-5'), 'catalog base')
assert(catalog.some((m) => m.id === 'gpt-5-fast'), 'catalog fast')
assert(catalog.some((m) => m.id === 'gpt-5-xhigh'), 'catalog xhigh')
assert(catalog.every((m) => m.provider === 'cursor' && m.name), 'catalog fields')
const live = adapter.expandModelCatalog(['cursor-grok-4.6-high'], false)
assert(live.length === 1 && live[0].id === 'cursor-grok-4.6-high', 'live catalog does not invent suffixes')

const resolved = await new adapter.CursorLlmAdapter().resolveModel('cursor', 'grok-4.6-fast')
assert(resolved.provider === 'cursor' && resolved.id === 'grok-4.6-fast', 'resolve id')
assert(resolved.reasoning.efforts.some((e) => e.id === 'xhigh' && e.name === 'Extra High'), 'extra high effort')

const registered = []
const directory = []
const logs = []
lib.apply(
  {
    get: (name) => {
      if (name === 'logger') return { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
      if (name === 'llm') {
        return {
          registerAdapter: (providers, instance) => {
            registered.push({ providers, instance })
          },
          registerConfigurableProviders: (entries) => {
            directory.push(...entries)
            return { replace: (next) => { directory.splice(0, directory.length, ...next) } }
          },
        }
      }
      return undefined
    },
    on: () => {},
    effect: () => {},
    plugin: () => {},
  },
  { assets: false, models: true },
)
assert(registered.length === 1 && registered[0].providers[0] === 'cursor', `registerAdapter: ${JSON.stringify(registered.map((r) => r.providers))}`)
assert(typeof registered[0].instance.stream === 'function', 'adapter.stream')
assert(directory.some((e) => e.provider === 'cursor'), 'configurable provider')
assert(logs.some((line) => String(line).includes('LLM adapter registered')), `register log: ${logs.join(' | ')}`)

const previousBin = process.env.CURSOR_AGENT_BIN
process.env.CURSOR_AGENT_BIN = '/no/such/cursor-agent-bin'
delete process.env.CURSOR_API_KEY
delete process.env.CURSOR_AUTH_TOKEN
const started = Date.now()
const chunks = []
for await (const chunk of new adapter.CursorLlmAdapter().stream({
  provider: 'cursor',
  model: 'gpt-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})) {
  chunks.push(chunk)
}
if (previousBin === undefined) delete process.env.CURSOR_AGENT_BIN
else process.env.CURSOR_AGENT_BIN = previousBin
const elapsed = Date.now() - started
const finish = chunks.find((c) => c.type === 'finish')
assert(finish?.reason?.kind === 'error', `missing-bin finish kind: ${JSON.stringify(finish)}`)
assert(finish.reason.failure.code === 'MISSING_CREDENTIAL', `missing-bin code: ${JSON.stringify(finish.reason.failure)}`)
assert(elapsed < 8_000, `missing-bin hung: ${elapsed}ms`)

const authChunks = []
const authStarted = Date.now()
for await (const chunk of new adapter.CursorLlmAdapter().stream({
  provider: 'cursor',
  model: 'gpt-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})) {
  authChunks.push(chunk)
}
const authElapsed = Date.now() - authStarted
const authFinish = authChunks.find((c) => c.type === 'finish')
assert(authFinish?.reason?.kind === 'error', `auth finish kind: ${JSON.stringify(authFinish)}`)
assert(
  ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_ARGS'].includes(authFinish.reason.failure.code),
  `auth code: ${JSON.stringify(authFinish.reason.failure)}`,
)
assert(
  authFinish.reason.failure.code === 'MISSING_CREDENTIAL'
    || String(authFinish.reason.failure.message).includes('agent login')
    || /cannot use this model|available models/i.test(String(authFinish.reason.failure.message)),
  `auth message: ${JSON.stringify(authFinish.reason.failure)}`,
)
assert(authElapsed < 15_000, `auth hung: ${authElapsed}ms`)

const profile = await readFile(join(process.cwd(), 'examples/teams/cursor-member.yml'), 'utf8')
assert(/provider:\s*cursor/.test(profile), 'profile provider')
assert(/model:\s*cursor-grok-4\.6-high/.test(profile), 'profile model')
assert(/reasoningEffort:\s*high/.test(profile), 'profile effort')
assert(/- mailbox/.test(profile) && /- task/.test(profile), 'profile mailbox/task tools')
assert(!/^\s*-\s*cursor_agent_/m.test(profile), 'profile has no ACP tools')

console.log('verify-models: ok')
