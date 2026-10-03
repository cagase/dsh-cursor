const sessions = new Map();
function sessionKey(id) {
    if (id === undefined || String(id) === '')
        return '';
    return String(id);
}
export function noteLiveSession(id, cwd) {
    const key = sessionKey(id);
    if (key === '' || cwd === undefined || cwd === '')
        return;
    sessions.set(key, cwd);
}
export function forgetLiveSession(id, _cwd) {
    const key = sessionKey(id);
    if (key !== '')
        sessions.delete(key);
}
/** Directories of sessions that are still running. */
export function liveCwds() {
    return [...new Set(sessions.values())];
}
