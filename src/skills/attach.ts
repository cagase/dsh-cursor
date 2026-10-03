import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
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

export function skillMatchesPath(candidate: SkillCandidate, filePath: string, root?: string): boolean {
  const metadata = candidate.metadata
  const paths = Array.isArray(metadata?.paths) ? metadata.paths.filter((entry): entry is string => typeof entry === 'string') : []
  const globs = Array.isArray(metadata?.globs) ? metadata.globs.filter((entry): entry is string => typeof entry === 'string') : []
  if (paths.length === 0 && globs.length === 0) return false
  return [...paths, ...globs].some((pattern) => matchGlob(pattern, filePath, root))
}

export async function attachMatchingSkills(
  agent: AgentLike,
  filePath: string,
  candidates: readonly SkillCandidate[],
  logger: PluginLogger,
): Promise<void> {
  for (const candidate of candidates) {
    const cwd = agent.session.header.cwd
    if (!skillMatchesPath(candidate, filePath, cwd)) continue
    const locator = candidate.locator as { file?: string; kind?: string } | undefined
    const file = locator?.file ?? candidate.path
    if (!file || locator?.kind === 'rule' || locator?.kind === 'agent') continue
    try {
      const parsed = parseSkillFile(await readText(file), candidate.name)
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
