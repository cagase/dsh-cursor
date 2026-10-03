const sessions = new Map();
function sessionKey(id, cwd) {
    if (id !== undefined && String(id) !== '')
        return String(id);
    return cwd ?? '';
}
export function noteLiveSession(id, cwd) {
    const key = sessionKey(id, cwd);
    if (key === '')
        return;
    if (cwd === undefined || cwd === '') {
        sessions.delete(key);
        return;
    }
    sessions.set(key, cwd);
}
export function forgetLiveSession(id, cwd) {
    const key = sessionKey(id, cwd);
    if (key !== '')
        sessions.delete(key);
}
/** Directories of sessions that are still running. */
export function liveCwds() {
    return [...new Set(sessions.values())];
}
