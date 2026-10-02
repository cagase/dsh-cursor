import type { Context } from '@deepseek-ai/cordis'
export const name: 'dsh-cursor'
export const inject: readonly []
export interface DshCursorConfig {
  assets?: boolean
  models?: boolean
  skillsCursor?: boolean
  watch?: boolean
}
export const DEFAULT_CONFIG: Required<DshCursorConfig>
export function apply(ctx: Context, config?: DshCursorConfig): void
