import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots = await import(pathToFileURL(join(process.cwd(), 'lib/roots.js')).href)
const rules = await import(pathToFileURL(join(process.cwd(), 'lib/rules/index.js')).href)
const settingsMod = await import(pathToFileURL(join(process.cwd(), 'lib/settings.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const savedConfigDir = process.env.CURSOR_CONFIG_DIR
delete process.env.CURSOR_CONFIG_DIR

const repo = await mkdtemp(join(tmpdir(), 'dsh-cursor-root-'))
try {
  const pkg = join(repo, 'pkg')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(join(repo, '.cursor', 'rules'), { recursive: true })
  await mkdir(join(pkg, '.cursor', 'rules'), { recursive: true })
  await mkdir(join(repo, 'user-cursor'), { recursive: true })
  await writeFile(join(repo, '.cursorrules'), 'ROOT LEGACY\n')
  await writeFile(join(pkg, '.cursorrules'), 'PKG LEGACY\n')
  await writeFile(
    join(repo, '.cursor', 'rules', 'root.mdc'),
    '---\nalwaysApply: true\n---\nroot rule body\n',
  )
  await writeFile(
    join(pkg, '.cursor', 'rules', 'pkg.mdc'),
    '---\nalwaysApply: true\n---\npkg rule body\n',
  )
  await writeFile(
    join(repo, 'user-cursor', 'cli-config.json'),
    JSON.stringify({ permissions: { deny: ['Shell(git *)'] } }),
  )
  await writeFile(
    join(pkg, '.cursor', 'cli.json'),
    JSON.stringify({ permissions: { deny: ['Read(**)'] }, approvalMode: 'unrestricted' }),
  )
  await writeFile(
    join(repo, 'user-cursor', 'permissions.json'),
    JSON.stringify({ mcpAllowlist: ['srv'], terminalAllowlist: ['ls'] }),
  )

  assert(
    roots.projectRulesDir(pkg) === join(pkg, '.cursor', 'rules'),
    `rules dir walked to git root: ${roots.projectRulesDir(pkg)}`,
  )
  const loadedRules = await rules.collectRules(pkg, {})
  const names = loadedRules.map((rule) => rule.name)
  assert(names.includes('pkg'), `package rule missing: ${names.join(', ')}`)
  assert(!names.includes('root'), `git-root rule leaked into package cwd: ${names.join(', ')}`)
  const legacy = await rules.loadCursorrules(pkg)
  assert(legacy?.trim() === 'PKG LEGACY', `cursorrules came from the wrong directory: ${JSON.stringify(legacy)}`)

  const warnings = []
  const loader = new settingsMod.CursorSettingsLoader(
    { warn: (message) => warnings.push(message) },
    join(repo, 'user-cursor'),
  )
  const loaded = await loader.load(pkg)
  assert(
    loaded.permissionDeny.includes('Shell(git *)') && loaded.permissionDeny.includes('Read(**)'),
    `deny lists were not merged: ${loaded.permissionDeny.join(', ')}`,
  )
  await loader.load(pkg)
  const unsupported = warnings.filter((message) => message.includes('is not enforced'))
  assert(unsupported.length === 1, `expected one unsupported-config warning, got ${unsupported.length}: ${warnings.join(' | ')}`)
  assert(unsupported[0].includes('approvalMode'), `approvalMode missing from warning: ${unsupported[0]}`)
  assert(unsupported[0].includes('mcpAllowlist'), `mcpAllowlist missing from warning: ${unsupported[0]}`)
  assert(unsupported[0].includes('terminalAllowlist'), `terminalAllowlist missing from warning: ${unsupported[0]}`)
} finally {
  if (savedConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = savedConfigDir
  await rm(repo, { recursive: true, force: true })
}

console.log('checks/project-root: ok')
