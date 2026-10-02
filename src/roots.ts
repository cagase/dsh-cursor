import { dirname, join, normalize } from 'node:path'
import { existsSync } from 'node:fs'
import { expandHome } from './util.js'

const MAX_WALK = 32

/** `$CURSOR_CONFIG_DIR` wins; otherwise `~/.cursor`. */
export function userCursorDir(configured = '~/.cursor'): string {
  const envDir = process.env.CURSOR_CONFIG_DIR
  if (envDir !== undefined && envDir.trim() !== '') return expandHome(envDir.trim())
  return expandHome(configured)
}

export function projectCursorDir(cwd: string): string {
  return join(cwd, '.cursor')
}

export function findRepoRoot(cwd: string): string {
  let dir = cwd
  for (let depth = 0; depth < MAX_WALK; depth++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return cwd
}

export function projectRulesDir(cwd: string): string {
  return join(findRepoRoot(cwd), '.cursor', 'rules')
}

export function relativeLabel(cwd: string, path: string): string {
  const normalized = normalize(path)
  const base = normalize(cwd)
  return normalized.startsWith(base + '/') ? normalized.slice(base.length + 1) : normalized
}
