import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { readText } from '../fs.js'
import { parseSkillFile } from '../parse.js'
import type { AgentLike, PluginLogger, SkillCandidate } from '../types.js'
import { errorMessage, matchGlob, reminder } from '../util.js'
import { catalogName, PROVIDER_NAME } from './provider.js'

const PLUGIN_SOURCE = `dsh-cursor:${PROVIDER_NAME}/attach`
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

function skillGlobMatches(pattern: string, filePath: string, cwd?: string): boolean {
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

export function skillMatchesPath(candidate: SkillCandidate, filePath: string, cwd?: string): boolean {
  const metadata = candidate.metadata
  const paths = Array.isArray(metadata?.paths) ? metadata.paths.filter((entry): entry is string => typeof entry === 'string') : []
  const globs = Array.isArray(metadata?.globs) ? metadata.globs.filter((entry): entry is string => typeof entry === 'string') : []
  if (paths.length === 0 && globs.length === 0) return false
  return [...paths, ...globs].some((pattern) => skillGlobMatches(pattern, filePath, cwd))
}

export async function attachMatchingSkills(
  agent: AgentLike,
  filePath: string,
  candidates: readonly SkillCandidate[],
  logger: PluginLogger,
): Promise<void> {
  const cwd = agent.session.header.cwd
  for (const candidate of candidates) {
    if (!skillMatchesPath(candidate, filePath, cwd)) continue
    const locator = candidate.locator as { file?: string; kind?: string } | undefined
    const file = locator?.file ?? candidate.path
    if (!file || locator?.kind === 'rule' || locator?.kind === 'agent') continue
    try {
      const read = await readText(file)
      if (read.truncated) {
        logger.warn?.(`cursor: cannot read skill ${file}: file exceeds the read cap`)
        continue
      }
      const parsed = parseSkillFile(read.text, candidate.name)
      const hash = createHash('sha256').update(parsed.body).digest('hex').slice(0, 16)
      if (!remember(agent, `skill:${file}:${hash}`)) continue
      const name = catalogName(parsed.frontmatter.name, candidate.name)
      agent.inject(
        reminder(
          PLUGIN_SOURCE,
          `Cursor skill \`${name}\` applies because \`${filePath}\` matched its paths/globs.\n\n${parsed.body}`,
        ),
      )
    } catch (error) {
      logger.warn?.(`cursor: skill path attach failed for ${file}: ${errorMessage(error)}`)
    }
  }
}

export function resourceDir(file: string): string {
  return dirname(file)
}
