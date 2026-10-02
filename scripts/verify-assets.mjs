import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)
const parse = await import(pathToFileURL(join(process.cwd(), 'lib/parse.js')).href)
const util = await import(pathToFileURL(join(process.cwd(), 'lib/util.js')).href)
const roots = await import(pathToFileURL(join(process.cwd(), 'lib/roots.js')).href)
const rules = await import(pathToFileURL(join(process.cwd(), 'lib/rules/index.js')).href)
const perms = await import(pathToFileURL(join(process.cwd(), 'lib/permissions.js')).href)
const hooks = await import(pathToFileURL(join(process.cwd(), 'lib/hooks/run.js')).href)
const provider = await import(pathToFileURL(join(process.cwd(), 'lib/skills/provider.js')).href)
const attach = await import(pathToFileURL(join(process.cwd(), 'lib/skills/attach.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

assert(lib.name === 'dsh-cursor', 'export name')
assert(typeof lib.apply === 'function', 'apply')
assert(lib.DEFAULT_CONFIG.skillsCursor === false, 'skills-cursor default off')
assert(lib.DEFAULT_CONFIG.assets === true, 'assets default on')

assert(util.matchGlob('**/*.ts', 'src/index.ts'), 'glob **/*.ts')
assert(util.matchGlob('*.mdc', 'always.mdc'), 'glob basename')
assert(!util.matchGlob('**/*.ts', 'src/index.js'), 'glob miss')

const skill = parse.parseSkillFile(
  '---\nname: demo-skill\ndescription: demo\npaths:\n  - src/**/*.ts\nglobs:\n  - "*.json"\n---\nbody\n',
  'demo-skill',
)
assert(skill.frontmatter.name === 'demo-skill', 'skill name')
assert(skill.frontmatter.paths?.[0] === 'src/**/*.ts', 'skill paths')
assert(skill.body.includes('body'), 'skill body')

const always = parse.parseRuleFile('---\nalwaysApply: true\n---\nalways body')
assert(rules.classifyRule(always, 'x.mdc') === 'always', 'always rule')
const globRule = parse.parseRuleFile('---\nalwaysApply: false\nglobs:\n  - "**/*.ts"\n---\nglob body')
assert(rules.classifyRule(globRule, 'x.mdc') === 'glob', 'glob rule')
const desc = parse.parseRuleFile('---\nalwaysApply: false\ndescription: when reviewing\n---\ndesc body')
assert(rules.classifyRule(desc, 'x.mdc') === 'description', 'description rule')
const manual = parse.parseRuleFile('---\nalwaysApply: false\n---\nmanual body')
assert(rules.classifyRule(manual, 'manual.mdc') === 'manual', 'manual rule')

const deny = perms.evaluateCursorPermissions(
  [],
  ['Shell(rm)'],
  { name: 'bash', arguments: { command: 'rm -rf /' } },
)
assert(deny?.kind === 'deny', 'cli deny wins')
const fallthrough = perms.evaluateCursorPermissions([], [], { name: 'bash', arguments: { command: 'ls' } })
assert(fallthrough === undefined, 'unmatched permissions fall through to DSH')

assert(hooks.matcherHits('Read', 'Read'), 'hook matcher')
assert(!hooks.matcherHits('Write', 'Read'), 'hook matcher miss')
assert(hooks.matcherHits(undefined, 'anything'), 'empty matcher')

const prev = process.env.CURSOR_CONFIG_DIR
process.env.CURSOR_CONFIG_DIR = '/tmp/cursor-config-test'
assert(roots.userCursorDir() === '/tmp/cursor-config-test', 'CURSOR_CONFIG_DIR wins')
if (prev === undefined) delete process.env.CURSOR_CONFIG_DIR
else process.env.CURSOR_CONFIG_DIR = prev

const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-'))
try {
  await mkdir(join(root, '.git'))
  await mkdir(join(root, '.cursor', 'skills', 'fixture-skill'), { recursive: true })
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true })
  await writeFile(
    join(root, '.cursor', 'skills', 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: fixture\npaths:\n  - "**/*.ts"\n---\nskill body\n',
  )
  await writeFile(join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nalways apply\n')
  await writeFile(join(root, '.cursor', 'rules', 'glob.mdc'), '---\nalwaysApply: false\nglobs:\n  - "**/*.ts"\n---\nglob apply\n')
  await writeFile(join(root, '.cursor', 'rules', 'named.mdc'), '---\nalwaysApply: false\ndescription: named review\n---\nnamed\n')
  const listed = await new provider.CursorSkillProvider(
    {},
    { userCursorDir: join(root, 'nouser'), skillsCursor: false, agents: true },
    async (cwd) => rules.ruleCatalogCandidates(await rules.collectRules(cwd, {})),
  ).list({ cwd: root })
  const names = (Array.isArray(listed) ? listed : listed.candidates).map((c) => c.name)
  assert(names.includes('fixture-skill'), `skill catalog has fixture-skill: ${names}`)
  assert(names.includes('named'), `description rule in catalog: ${names}`)
  const collected = await rules.collectRules(root, {})
  assert(collected.some((r) => r.kind === 'always'), 'collect always')
  assert(rules.matchingGlobRules(collected, 'src/index.ts').some((r) => r.name === 'glob'), 'glob attach match')
  const skillCand = (Array.isArray(listed) ? listed : listed.candidates).find((c) => c.name === 'fixture-skill')
  assert(attach.skillMatchesPath(skillCand, 'src/index.ts'), 'skill path match')
} finally {
  await rm(root, { recursive: true, force: true })
}

const logs = []
lib.apply(
  {
    get: () => ({ info: (m) => logs.push(m), warn: (m) => logs.push(m) }),
    on: () => {},
    effect: () => {},
    plugin: () => {},
  },
  { models: false, watch: false, mcp: false },
)
assert(logs.some((line) => String(line).includes('assets mapped')), `apply logs mount: ${logs.join(' | ')}`)

console.log('verify-assets: ok')
