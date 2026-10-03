const sessions = new Map<string, string>()

function sessionKey(id: unknown, cwd: string | undefined): string {
  if (id !== undefined && String(id) !== '') return String(id)
  return cwd ?? ''
}

export function noteLiveSession(id: unknown, cwd: string | undefined): void {
  const key = sessionKey(id, cwd)
  if (key === '') return
  if (cwd === undefined || cwd === '') {
    sessions.delete(key)
    return
  }
  sessions.set(key, cwd)
}

export function forgetLiveSession(id: unknown, cwd: string | undefined): void {
  const key = sessionKey(id, cwd)
  if (key !== '') sessions.delete(key)
}

/** Directories of sessions that are still running. */
export function liveCwds(): string[] {
  return [...new Set(sessions.values())]
}
