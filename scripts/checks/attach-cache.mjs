import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const fs = await import(pathToFileURL(join(process.cwd(), 'lib/fs.js')).href)
const providerMod = await import(pathToFileURL(join(process.cwd(), 'lib/skills/provider.js')).href)
const attachMod = await import(pathToFileURL(join(process.cwd(), 'lib/skills/attach.js')).href)
const rules = await import(pathToFileURL(join(process.cwd(), 'lib/rules/index.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const savedConfigDir = process.env.CURSOR_CONFIG_DIR
delete process.env.CURSOR_CONFIG_DIR

const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-cache-'))
const userDir = join(root, 'user')
try {
  const big = join(root, 'big.txt')
  await writeFile(big, 'abcdefghij')
  const capped = await fs.readText(big, undefined, 4)
  assert(capped.truncated === true && capped.text === 'abcd', `read cap failed: ${JSON.stringify(capped)}`)
  const whole = await fs.readText(big, undefined, 100)
  assert(whole.truncated === false && whole.text === 'abcdefghij', `short read was marked truncated`)

  await mkdir(join(root, '.cursor', 'skills', 'broken'), { recursive: true })
  await mkdir(join(root, '.cursor', 'skills', 'healthy'), { recursive: true })
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true })
  await mkdir(userDir, { recursive: true })
  await symlink('SKILL.md', join(root, '.cursor', 'skills', 'broken', 'SKILL.md'))
  await writeFile(
    join(root, '.cursor', 'skills', 'healthy', 'SKILL.md'),
    '---\nname: healthy\ndescription: ok\n---\nhealthy body\n',
  )
  await writeFile(join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\ncached rule\n')

  const warnings = []
  const provider = new providerMod.CursorSkillProvider(
    { warn: (message) => warnings.push(message), info() {} },
    { userCursorDir: userDir, skillsCursor: false, agents: false },
  )
  const listed = await provider.list({ cwd: root })
  const names = listed.candidates.map((candidate) => candidate.name)
  assert(names.includes('healthy'), `broken skill hid its sibling: ${names.join(', ')}`)
  assert(warnings.some((message) => message.includes('broken')), `broken skill was not warned: ${warnings.join(' | ')}`)

  const first = await rules.collectRules(root, {})
  const second = await rules.collectRules(root, {})
  assert(first === second, 'rules snapshot was not reused for the same tree')
  await writeFile(join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\ncached rule changed\n')
  const third = await rules.collectRules(root, {})
  assert(third !== first, 'rules snapshot ignored a body change')
  assert(third.some((rule) => rule.body.includes('changed')), 'refreshed rules missed the edit')

  await writeFile(join(root, '.cursor', 'rules', 'locked.mdc'), '---\nalwaysApply: true\n---\nlocked body\n')
  await chmod(join(root, '.cursor', 'rules', 'locked.mdc'), 0)
  const lockedA = await rules.collectRules(root, {})
  const lockedB = await rules.collectRules(root, {})
  if (process.getuid?.() !== 0) {
    assert(!lockedA.some((rule) => rule.body.includes('locked body')), 'unreadable rule was loaded')
    assert(lockedA !== lockedB, 'rules snapshot was cached after a skipped read')
  }
  await chmod(join(root, '.cursor', 'rules', 'locked.mdc'), 0o644)

  await writeFile(
    join(root, '.cursor', 'rules', 'huge.mdc'),
    `---\nalwaysApply: true\n---\n${'x'.repeat(1024 * 1024)}`,
  )
  const hugeA = await rules.collectRules(root, {})
  const hugeB = await rules.collectRules(root, {})
  assert(!hugeA.some((rule) => rule.file.endsWith('huge.mdc')), 'truncated rule was treated as complete')
  assert(hugeA !== hugeB, 'rules snapshot was cached after a truncated read')

  await mkdir(join(root, '.cursor', 'skills', 'huge'), { recursive: true })
  await writeFile(
    join(root, '.cursor', 'skills', 'huge', 'SKILL.md'),
    `---\nname: huge\ndescription: too big\n---\n${'y'.repeat(1024 * 1024)}`,
  )
  const hugeProvider = new providerMod.CursorSkillProvider(
    { warn() {}, info() {} },
    { userCursorDir: userDir, skillsCursor: false, agents: false },
  )
  const hugeListed = await hugeProvider.list({ cwd: root })
  assert(!hugeListed.candidates.some((candidate) => candidate.name === 'huge'), 'truncated skill was listed')
  assert(hugeListed.complete === false, 'truncated skill walk was treated as complete')

  const skillFile = join(root, 'attach-skill', 'SKILL.md')
  await mkdir(join(root, 'attach-skill'), { recursive: true })
  const candidate = {
    name: 'attach-skill',
    description: 'd',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-cursor',
    provider: 'cursor',
    rank: 1,
    path: skillFile,
    locator: { kind: 'bundle', file: skillFile },
    metadata: { globs: ['src/**'] },
  }
  const messages = []
  const warningsAttach = []
  const agent = {
    session: { header: { cwd: root } },
    inject(message) {
      messages.push(message)
    },
  }
  const logger = { warn: (message) => warningsAttach.push(message), info() {} }
  await attachMod.attachMatchingSkills(agent, join('/other', 'src', 'a.ts'), [candidate], logger)
  assert(messages.length === 0, 'skill glob matched a path outside the session')

  await writeFile(skillFile, `---\nname: attach-skill\ndescription: d\n---\n${'z'.repeat(1024 * 1024)}`)
  await attachMod.attachMatchingSkills(agent, join(root, 'src', 'a.ts'), [candidate], logger)
  assert(messages.length === 0, 'truncated skill was injected')
  await writeFile(skillFile, '---\nname: attach-skill\ndescription: d\n---\nshort body\n')
  await attachMod.attachMatchingSkills(agent, join(root, 'src', 'a.ts'), [candidate], logger)
  assert(messages.length === 1 && JSON.stringify(messages[0]).includes('short body'), 'shortened skill did not attach')
  await writeFile(skillFile, '---\nname: attach-skill\ndescription: d\n---\nedited body\n')
  await attachMod.attachMatchingSkills(agent, join(root, 'src', 'a.ts'), [candidate], logger)
  assert(messages.length === 2 && JSON.stringify(messages[1]).includes('edited body'), 'edited skill did not reattach')
} finally {
  if (savedConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = savedConfigDir
  await rm(root, { recursive: true, force: true })
}

console.log('checks/attach-cache: ok')
