const cwdBySession = new Map();
export function noteSessionCwd(id, cwd) {
    if (id === undefined || String(id) === '' || cwd === undefined || cwd === '')
        return;
    cwdBySession.set(String(id), cwd);
}
export function forgetSessionCwd(id) {
    if (id === undefined || String(id) === '')
        return;
    cwdBySession.delete(String(id));
}
export function sessionCwd(id) {
    if (id === undefined || String(id) === '')
        return undefined;
    return cwdBySession.get(String(id));
}
