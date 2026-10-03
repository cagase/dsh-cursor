/**
 * @cagase/dsh-cursor — HOST-plane DeepSeek Harness plugin.
 *
 * Maps `.cursor/`, `~/.cursor/`, and `$CURSOR_CONFIG_DIR` skills, rules, hooks,
 * and compatible cli/mcp config onto DSH. Registers the Cursor `agent` CLI as
 * picker + AgentTeams provider `cursor`.
 */
import { join } from 'node:path'
import { registerHooks } from './hooks/index.js'
import { isFileTouchTool } from './hooks/names.js'
import { registerMcp } from './mcp.js'
import { registerCursorAdapter } from './models/adapter.js'
import { createPermissionsGate } from './permissions.js'
import { attachGlobRules, collectRules, injectSessionRules, ruleCatalogCandidates, ruleWatchRoots } from './rules/index.js'
import { CursorSettingsLoader } from './settings.js'
import { attachMatchingSkills } from './skills/attach.js'
import { CursorSkillProvider, PROVIDER_NAME } from './skills/provider.js'
import type { AgentLike, HostContext, PluginLogger, SkillCandidate, SkillProviderControl, ToolExecutionLike } from './types.js'
import { errorMessage, toolFilePath } from './util.js'
import { watchPaths } from './watch.js'
import { projectCursorDir, userCursorDir } from './roots.js'

export const name = 'dsh-cursor'

/** Soft deps: activate even if a minimal profile omitted one of these. */
export const inject = [] as const

export interface DshCursorConfig {
  /** Discover and map Cursor skills / agents / rules / hooks / mcp / permissions. */
  assets?: boolean
  /** Register the `cursor` LLM adapter for picker + AgentTeams routes. */
  models?: boolean
  /** Include `~/.cursor/skills-cursor` (default off). */
  skillsCursor?: boolean
  /** Watch Cursor asset files and invalidate catalogs. */
  watch?: boolean
  /** Apply cli.json / cli-config.json deny tokens at tools/pre-execute. */
  permissions?: boolean
  /** Mount mcp.json servers via @deepseek-ai/dsh-mcp-client. */
  mcp?: boolean
  /** User-level Cursor directory (usually `~/.cursor`; `CURSOR_CONFIG_DIR` wins). */
  userCursorDir?: string
  /** Default hook timeout (ms). */
  hookTimeoutMs?: number
  /** Cap on hook-injected context characters. */
  maxHookOutputChars?: number
  /** Per-tool-call timeout for bridged MCP servers (ms). */
  mcpToolCallTimeoutMs?: number
}

export const DEFAULT_CONFIG = {
  assets: true,
  models: true,
  skillsCursor: false,
  watch: true,
  permissions: true,
  mcp: true,
  userCursorDir: '~/.cursor',
  hookTimeoutMs: 30_000,
  maxHookOutputChars: 10_000,
  mcpToolCallTimeoutMs: 120_000,
} as const satisfies Required<DshCursorConfig>

export function apply(ctx: HostContext, config: DshCursorConfig = {}): void {
  const host = ctx
  const resolved = { ...DEFAULT_CONFIG, ...config }
  const logger = (host.get('logger') ?? {}) as PluginLogger

  if (resolved.models) {
    registerCursorAdapter(host, logger)
  }

  if (!resolved.assets) {
    logger.info?.(`@cagase/dsh-cursor mounted (assets=false models=${resolved.models})`)
    return
  }

  const loader = new CursorSettingsLoader(logger, resolved.userCursorDir)
  const extraRules = async (cwd: string | undefined, signal?: AbortSignal): Promise<SkillCandidate[]> => {
    if (!cwd) return []
    return ruleCatalogCandidates(await collectRules(cwd, logger, signal))
  }

  const skills = host.get('skills') as
    | { registerProvider: (create: (control: SkillProviderControl) => CursorSkillProvider) => unknown }
    | undefined
  let invalidateSkills: (() => void) | undefined
  let provider: CursorSkillProvider | undefined
  if (skills && typeof skills.registerProvider === 'function') {
    skills.registerProvider((control) => {
      invalidateSkills = control.invalidate
      provider = new CursorSkillProvider(
        logger,
        { userCursorDir: resolved.userCursorDir, skillsCursor: resolved.skillsCursor, agents: true },
        extraRules,
      )
      return provider
    })
    logger.info?.(`cursor: skill provider ${JSON.stringify(PROVIDER_NAME)} registered`)
  } else {
    logger.warn?.('cursor: ctx.skills is missing; catalog mapping skipped')
  }

  host.on('agent/session-start', (payload: { agent: AgentLike }) => {
    void injectSessionRules(payload.agent, logger).catch((error) => {
      logger.warn?.(`cursor: session rule inject failed: ${errorMessage(error)}`)
    })
  })

  host.on('tools/result', (exec: ToolExecutionLike) => {
    if (!isFileTouchTool(exec.name)) return
    const agent = exec.agent
    const filePath = toolFilePath(exec.arguments)
    if (!agent || !filePath) return
    void (async () => {
      if (provider) {
        const listed = await provider.list({ cwd: agent.session.header.cwd })
        const candidates = Array.isArray(listed) ? listed : listed.candidates
        await attachMatchingSkills(agent, filePath, candidates, logger)
      }
      await attachGlobRules(agent, filePath, logger)
    })().catch((error) => {
      logger.warn?.(`cursor: file attach failed: ${errorMessage(error)}`)
    })
  })

  const permissionGate = resolved.permissions ? createPermissionsGate(logger, loader) : undefined
  registerHooks(
    host,
    logger,
    loader,
    { hookTimeoutMs: resolved.hookTimeoutMs, maxHookOutputChars: resolved.maxHookOutputChars },
    permissionGate,
  )
  if (resolved.mcp) {
    registerMcp(host, logger, loader, resolved.mcpToolCallTimeoutMs)
  }

  if (resolved.watch) {
    const stoppers: Array<() => void> = []
    const refresh = () => {
      loader.invalidate()
      invalidateSkills?.()
    }
    let watchGeneration = 0
    const ensure = (cwd?: string) => {
      const generation = ++watchGeneration
      for (const stop of stoppers.splice(0)) stop()
      const roots = [userCursorDir(resolved.userCursorDir)]
      if (cwd) roots.push(projectCursorDir(cwd), join(cwd, '.cursorrules'))
      void ruleWatchRoots(cwd).then((ruleRoots) => {
        if (generation !== watchGeneration) return
        stoppers.push(watchPaths([...roots, ...ruleRoots], logger, refresh))
      }).catch((error) => {
        logger.warn?.(`cursor: asset watch setup failed: ${errorMessage(error)}`)
      })
    }
    host.on('agent/session-start', (payload: { agent: AgentLike }) => {
      ensure(payload.agent.session.header.cwd)
    })
    host.effect(
      () => () => {
        for (const stop of stoppers) stop()
      },
      'cursor asset watchers',
    )
  }

  logger.info?.(
    `@cagase/dsh-cursor assets mapped (skillsCursor=${resolved.skillsCursor} watch=${resolved.watch} permissions=${resolved.permissions} mcp=${resolved.mcp} models=${resolved.models})`,
  )
}

export { PROVIDER_ID } from './models/adapter.js'
export { registerCursorAdapter } from './models/adapter.js'
