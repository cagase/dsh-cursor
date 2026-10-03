const sessions = new Map<string, string>()

function sessionKey(id: unknown): string {
  if (id === undefined || String(id) === '') return ''
  return String(id)
}

export function noteLiveSession(id: unknown, cwd: string | undefined): void {
  const key = sessionKey(id)
  if (key === '' || cwd === undefined || cwd === '') return
  sessions.set(key, cwd)
}

export function forgetLiveSession(id: unknown, _cwd?: string): void {
  const key = sessionKey(id)
  if (key !== '') sessions.delete(key)
}

/** Directories of sessions that are still running. */
export function liveCwds(): string[] {
  return [...new Set(sessions.values())]
}
