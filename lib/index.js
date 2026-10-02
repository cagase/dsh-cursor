/**
 * @cagase/dsh-cursor — HOST-plane DeepSeek Harness plugin.
 * Stub only. Mapping and model routes are later tasks.
 */
export const name = 'dsh-cursor'
export const inject = []
export const DEFAULT_CONFIG = {
  assets: true,
  models: true,
  skillsCursor: false,
  watch: true,
}
export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULT_CONFIG, ...config }
  const logger = ctx.get?.('logger')
  logger?.info?.(
    `@cagase/dsh-cursor stub mounted (assets=${resolved.assets} models=${resolved.models} skillsCursor=${resolved.skillsCursor} watch=${resolved.watch}); mapping and model routes are not implemented yet`,
  )
}
