import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Live counterpart of verify-models.mjs: it re-checks the Grok contract against
 * the real Cursor agent CLI and account. Everything it asserts is also asserted
 * offline against fixtures/live/, so a SKIP here (no binary / not logged in —
 * the bash sandbox cannot read the login keychain, see docs/live-cli-contract.md
 * §0) never hides a regression.
 */

const root = process.cwd()
const load = (rel) => import(pathToFileURL(join(root, rel)).href)
const adapter = await load('lib/models/adapter.js')
const cli = await load('lib/models/cli.js')
const grok = await load('lib/models/grok.js')

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`timed out: ${bin} ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

const session = await load('lib/models/session.js')

const profile = await readFile(join(root, 'examples/teams/cursor-member.yml'), 'utf8')
assert(/provider:\s*cursor/.test(profile), 'teams profile provider')
assert(/model:\s*cursor-grok-4\.6(-high)?\b/.test(profile), 'teams profile model')
assert(/- mailbox/.test(profile) && /- task/.test(profile), 'teams mailbox/task')
assert(!/^\s*-\s*cursor_agent_/m.test(profile), 'teams has no ACP tools')

const probe = await cli.probeCursorCli()
if (!probe.bin) {
  console.log('verify-models-live: FAIL (MISSING_CREDENTIAL) — install the Cursor agent CLI, then:')
  console.log('  agent login')
  console.log('  npm run verify:live')
  console.log('Human picker/teams commands: fixtures/VERIFY.md')
  process.exit(1)
}
if (!probe.authenticated) {
  console.log('verify-models-live: FAIL (AUTH) — run `agent login`, then:')
  console.log('  npm run verify:live')
  console.log('Human picker/teams commands: fixtures/VERIFY.md')
  process.exit(1)
}

const catalog = await cli.listCursorModelCatalog(probe.bin)
assert(catalog.length > 0, 'picker catalog empty')
const liveIds = new Set(catalog.map((entry) => entry.id))
const vocabulary = grok.grokSlugVocabulary([...liveIds])

const instance = new adapter.CursorLlmAdapter()
const models = await instance.listModels('cursor')
assert(models.length > 0, 'picker catalog empty')
assert(models.every((model) => model.provider === 'cursor' && model.id && model.name), 'picker catalog fields')
assert(!models.some((model) => model.id.includes('[')), 'picker published a bracketed id')

const grokRoutes = models.filter((model) => /^(?:cursor-)?grok/i.test(model.id))
assert(grokRoutes.length > 0, 'picker lists no Grok route')
assert(
  grokRoutes.every((model) => !model.id.endsWith('-xhigh') && !model.id.endsWith('-max')),
  `picker invented an effort-suffixed Grok entry: ${grokRoutes.map((model) => model.id).join(', ')}`,
)
// A picker id is a DSH route name; the string that must be advertised is the wire
// it composes for every effort (asserted in the loop below). A route id is one of
// the live catalog slugs, a captured accepted slug, or a captured family base
// whose no-effort wire is the capture's bare base (`cursor-grok-4.6` -> `grok-4.6`).
assert(
  grokRoutes.every((model) => liveIds.has(model.id)
    || grok.GROK_CAPTURE_SLUGS.includes(model.id)
    || grok.GROK_CAPTURE_FAMILIES.some((family) => family.base === model.id)),
  'a Grok picker id is not a live slug, a captured slug, or a captured family base: '
    + grokRoutes
      .map((model) => `${model.id}(live=${liveIds.has(model.id)},capture=${grok.GROK_CAPTURE_SLUGS.includes(model.id)})`)
      .join(', '),
)
assert(
  grokRoutes.every((model) => model.name === undefined || !/[\u200B-\u200D\uFEFF]/.test(model.name)),
  'a Grok picker display name leaked a zero-width character',
)

let checked = 0
for (const model of models) {
  const resolved = await instance.resolveModel('cursor', model.id)
  const efforts = [undefined, ...(resolved.reasoning?.efforts ?? []).map((effort) => effort.id)]
  for (const effort of efforts) {
    const wire = cli.wireCursorModel(model.id, effort, { vocabulary })
    assert(!wire.includes('['), `advertised ${model.id}/${effort} synthesised ${wire}`)
    assert(
      liveIds.has(wire) || grok.GROK_CAPTURE_SLUGS.includes(wire),
      `advertised ${model.id}/${effort} -> "${wire}" is neither a live catalog slug nor a captured accepted slug`,
    )
    checked++
  }
}
console.log(`verify-models-live: catalog ${models.length} routes; ${checked} advertised (model, effort) pairs all resolve to live slugs`)

// Two live sessions, as the t2 verification contract asks: one Grok base with a
// non-default effort, one Fast route with Extra High.
const liveRoutes = [
  { model: 'cursor-grok-4.6', effort: 'medium' },
  { model: models.find((entry) => entry.id.endsWith('-fast'))?.id ?? 'grok-4.7-high-fast', effort: 'xhigh' },
].filter((entry) => models.some((model) => model.id === entry.model))

assert(liveRoutes.length >= 1, 'no selectable Cursor route')
for (const { model, effort } of liveRoutes) {
  const wire = cli.wireCursorModel(model, effort, { vocabulary })
  assert(
    liveIds.has(wire) || grok.GROK_CAPTURE_SLUGS.includes(wire),
    `composed wire ${wire} is not an advertised slug`,
  )
  console.log(`verify-models-live: using ${model} at ${effort} -> --model ${wire}`)
  const printed = await run(probe.bin, [
    '--print',
    '--mode',
    'ask',
    '--trust',
    '--output-format',
    'text',
    '--model',
    wire,
    'Reply with exactly pong and nothing else.',
  ], 60_000)
  const output = `${printed.stdout}\n${printed.stderr}`
  assert(printed.code === 0, `ask-mode session failed (${printed.code}): ${output.slice(0, 800)}`)
  assert(/pong/i.test(output), `ask-mode session had no pong: ${output.slice(0, 800)}`)
  assert(!/cannot use this model/i.test(output), `the CLI rejected the composed wire string: ${output.slice(0, 400)}`)
  console.log(`verify-models-live: ask-mode session on ${wire} returned pong`)
}

// t3 F1: the per-session chat id the adapter mints must pass the CLI's live
// UUIDv4 validator on a real `--new-session-id` run.
const liveSeed = `verify-models-live-${Date.now()}`
const mintedId = session.sessionUuidFor(`${liveSeed}#0`)
assert(session.isSessionUuidV4(mintedId), `minted id is not a UUIDv4: ${mintedId}`)
const mintedSession = await run(probe.bin, [
  '--print',
  '--mode',
  'ask',
  '--trust',
  '--model',
  'grok-4.7',
  '--new-session-id',
  mintedId,
  'Reply with exactly: OK',
], 90_000)
const mintedOut = `${mintedSession.stdout}\n${mintedSession.stderr}`
assert(mintedSession.code === 0, `--new-session-id ${mintedId} failed (${mintedSession.code}): ${mintedOut.slice(0, 400)}`)
assert(/ok/i.test(mintedSession.stdout), `no OK from the minted-id session: ${mintedOut.slice(0, 400)}`)
console.log(`verify-models-live: --new-session-id ${mintedId} accepted (exit 0)`)

console.log('verify-models-live: adapter catalog + composed wire string + ask-mode session ok')
console.log('verify-models-live: AgentTeams UI member completion is not claimed here — see fixtures/VERIFY.md')
