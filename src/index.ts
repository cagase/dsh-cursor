/**
 * @cagase/dsh-cursor — HOST-plane DeepSeek Harness plugin.
 *
 * Stub only: this package is installable and mounts. Skills/rules/hooks/MCP
 * mapping and the Cursor `agent` LLM adapter are later tasks. Do not register
 * a picker adapter or skill provider here.
 */
import type { Context } from '@deepseek-ai/cordis'

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
}

export const DEFAULT_CONFIG: Required<DshCursorConfig> = {
  assets: true,
  models: true,
  skillsCursor: false,
  watch: true,
}

export function apply(ctx: Context, config: DshCursorConfig = {}): void {
  const resolved = { ...DEFAULT_CONFIG, ...config }
  const logger = ctx.get('logger') as { info?: (m: string) => void } | undefined
  logger?.info?.(
    `@cagase/dsh-cursor stub mounted (assets=${resolved.assets} models=${resolved.models} skillsCursor=${resolved.skillsCursor} watch=${resolved.watch}); mapping and model routes are not implemented yet`,
  )
}
