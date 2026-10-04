import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { dirExists, fileExists, listDir, readText } from '../fs.js'
import { FrontmatterError, parseRuleFile, type ParsedRuleFile } from '../parse.js'
import { findRepoRoot, projectRulesDir, relativeLabel } from '../roots.js'
import type { AgentLike, PluginLogger, SkillCandidate } from '../types.js'
import { capString, errorMessage, isAbort, isMissing, matchGlob, reminder } from '../util.js'
import { catalogName, PROVIDER_NAME } from '../skills/provider.js'

const PLUGIN_SOURCE = 'dsh-cursor:.cursor/rules'
const MAX_WALK = 32
const MAX_READ_CHARS = 1024 * 1024
const MAX_DESCRIPTION_CHARS = 1024
const RANK_PROJECT_RULE_SKILLS = 227

export type RuleKind = 'always' | 'glob' | 'description' | 'manual'

export interface LoadedRule {
  kind: RuleKind
  name: string
  file: string
  label: string
  description?: string
  globs?: string[]
  body: string
}

export function classifyRule(rule: ParsedRuleFile, file: string): RuleKind {
  if (rule.alwaysApply) return 'always'
  if (rule.globs && rule.globs.length > 0) return 'glob'
  if (rule.description && rule.description.trim() !== '') return 'description'
  return 'manual'
}

export async function collectRules(cwd: string, logger: PluginLogger, signal?: AbortSignal): Promise<LoadedRule[]> {
  const rulesDir = projectRulesDir(cwd)
  return walkRules(rulesDir, cwd, logger, 0, signal)
}

async function walkRules(
  dir: string,
  cwd: string,
  logger: PluginLogger,
  depth: number,
  signal?: AbortSignal,
): Promise<LoadedRule[]> {
  if (depth > MAX_WALK) return []
  let entries
  try {
    entries = await listDir(dir, signal)
  } catch (error) {
    if (isAbort(error)) throw error
    if (isMissing(error)) return []
    logger.warn?.(`cursor: cannot read rules dir ${dir}: ${errorMessage(error)}`)
    return []
  }
  const rules: LoadedRule[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDir) {
      rules.push(...(await walkRules(join(dir, entry.name), cwd, logger, depth + 1, signal)))
      continue
    }
    if (!entry.name.toLowerCase().endsWith('.mdc')) continue
    const file = join(dir, entry.name)
    try {
      const text = await readText(file, signal)
      const parsed = parseRuleFile(text)
      const stem = basename(entry.name).replace(/\.mdc$/i, '')
      const name = catalogName(parsed.name ?? stem, stem)
      rules.push({
        kind: classifyRule(parsed, file),
        name,
        file,
        label: relativeLabel(cwd, file),
        description: parsed.description,
        globs: parsed.globs,
        body: parsed.body,
      })
    } catch (error) {
      if (isAbort(error)) throw error
      if (error instanceof FrontmatterError) {
        logger.warn?.(`cursor: skipping invalid rule ${file}: ${error.message}`)
      } else {
        logger.warn?.(`cursor: cannot read rule ${file}: ${errorMessage(error)}`)
      }
    }
  }
  return rules
}

export async function loadCursorrules(cwd: string): Promise<string | undefined> {
  const file = join(cwd, '.cursorrules')
  if (!(await fileExists(file))) return undefined
  const text = await readText(file)
  return text.trim() === '' ? undefined : text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) : text
}

export async function collectSubdirAgentsMd(cwd: string, logger: PluginLogger): Promise<{ label: string; content: string }[]> {
  const repoRoot = findRepoRoot(cwd)
  const dirs: string[] = [cwd]
  let dir = cwd
  for (let depth = 0; depth < MAX_WALK; depth++) {
    if (normalize(dir) === normalize(repoRoot)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    dirs.unshift(dir)
  }
  if (dirs.length > 0 && normalize(dirs[0]!) === normalize(repoRoot)) dirs.shift()
  const sections: { label: string; content: string }[] = []
  for (const dirEntry of dirs) {
    const file = join(dirEntry, 'AGENTS.md')
    try {
      if (!(await fileExists(file))) continue
      const text = await readText(file)
      if (text.trim() === '') continue
      sections.push({
        label: relativeLabel(cwd, file),
        content: text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) : text,
      })
    } catch (error) {
      logger.warn?.(`cursor: cannot read ${file}: ${errorMessage(error)}`)
    }
  }
  return sections
}

export function renderAlwaysApply(sections: { label: string; content: string }[]): string {
  const body = sections
    .map((section) => `Instructions from: ${section.label}\n\n${section.content}`)
    .join('\n\n')
  return (
    'The following Cursor instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.\n\n' +
    body
  )
}

export function ruleCatalogCandidates(rules: readonly LoadedRule[]): SkillCandidate[] {
  const candidates: SkillCandidate[] = []
  for (const rule of rules) {
    if (rule.kind !== 'description' && rule.kind !== 'manual') continue
    const description =
      rule.kind === 'description'
        ? capString(rule.description ?? rule.name, MAX_DESCRIPTION_CHARS)
        : `Manual Cursor rule \`${rule.name}\`. Load only when named or invoked.`
    candidates.push({
      name: rule.name,
      description,
      invocation: {
        modelInvocable: rule.kind === 'description',
        userInvocable: true,
      },
      source: 'project-cursor',
      provider: PROVIDER_NAME,
      rank: RANK_PROJECT_RULE_SKILLS,
      locator: { root: '', rootKind: 'project-skills', entry: rule.name, kind: 'rule', file: rule.file },
      path: rule.file,
      metadata: {
        cursorKind: 'rule',
        ruleKind: rule.kind,
        body: rule.body,
      },
    })
  }
  return candidates
}

export function matchingGlobRules(rules: readonly LoadedRule[], filePath: string, cwd?: string): LoadedRule[] {
  return rules.filter((rule) => rule.kind === 'glob' && rule.globs?.some((glob) => scopedGlobMatch(glob, filePath, cwd)))
}

function scopedGlobMatch(pattern: string, filePath: string, cwd?: string): boolean {
  let glob = pattern.replace(/\\/g, '/').trim()
  while (glob.startsWith('./')) glob = glob.slice(2)
  if (glob.startsWith('/')) glob = glob.slice(1)
  let target = filePath.replace(/\\/g, '/')
  if (cwd !== undefined && cwd !== '') {
    const rel = relative(resolve(cwd), resolve(target)).replace(/\\/g, '/')
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false
    target = rel
  }
  return matchGlob(glob, target)
}

const injected = new WeakMap<object, Set<string>>()

function remember(agent: AgentLike, key: string): boolean {
  let set = injected.get(agent)
  if (!set) {
    set = new Set()
    injected.set(agent, set)
  }
  if (set.has(key)) return false
  set.add(key)
  return true
}

export async function injectSessionRules(
  agent: AgentLike,
  logger: PluginLogger,
  source?: string,
): Promise<void> {
  const cwd = agent.session.header.cwd
  if (!cwd) return
  try {
    const sections: { label: string; content: string }[] = []
    const rules = await collectRules(cwd, logger)
    for (const rule of rules) {
      if (rule.kind !== 'always') continue
      sections.push({ label: rule.label, content: rule.body })
    }
    const legacy = await loadCursorrules(cwd)
    if (legacy) sections.push({ label: '.cursorrules', content: legacy })
    const nested = await collectSubdirAgentsMd(cwd, logger)
    sections.push(...nested)
    if (sections.length === 0) return
    const body = renderAlwaysApply(sections)
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16)
    const key = `always:${hash}`
    if (source === 'resume') {
      if (!remember(agent, key)) return
    } else {
      remember(agent, key)
    }
    agent.inject(reminder(PLUGIN_SOURCE, body))
  } catch (error) {
    logger.warn?.(`cursor: failed to inject always-apply rules: ${errorMessage(error)}`)
  }
}

export async function attachGlobRules(agent: AgentLike, filePath: string, logger: PluginLogger): Promise<void> {
  const cwd = agent.session.header.cwd
  if (!cwd) return
  try {
    const rules = matchingGlobRules(await collectRules(cwd, logger), filePath, cwd)
    for (const rule of rules) {
      const hash = createHash('sha256').update(rule.body).digest('hex').slice(0, 16)
      if (!remember(agent, `rule:${rule.file}:${hash}`)) continue
      agent.inject(
        reminder(
          PLUGIN_SOURCE,
          `Cursor rule \`${rule.name}\` applies because \`${filePath}\` matched ${JSON.stringify(rule.globs)}.\n\n${rule.body}`,
        ),
      )
    }
  } catch (error) {
    logger.warn?.(`cursor: glob rule attach failed: ${errorMessage(error)}`)
  }
}

export async function ruleWatchRoots(cwd?: string): Promise<string[]> {
  if (!cwd) return []
  const dir = projectRulesDir(cwd)
  return (await dirExists(dir)) ? [dir] : []
}
