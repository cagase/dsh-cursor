const cwdBySession = new Map<string, string>()

export function noteSessionCwd(id: unknown, cwd: string | undefined): void {
  if (id === undefined || String(id) === '' || cwd === undefined || cwd === '') return
  cwdBySession.set(String(id), cwd)
}

export function forgetSessionCwd(id: unknown): void {
  if (id === undefined || String(id) === '') return
  cwdBySession.delete(String(id))
}

export function sessionCwd(id: unknown): string | undefined {
  if (id === undefined || String(id) === '') return undefined
  return cwdBySession.get(String(id))
}
