import { homedir } from 'node:os';
import { basename } from 'node:path';
export function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/'))
        return homedir() + path.slice(1);
    return path;
}
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function capString(value, max) {
    if (value.length <= max)
        return value;
    return value.slice(0, Math.max(0, max - 1)) + '…';
}
export function escapeReminderClose(text) {
    return text.replaceAll('</system-reminder>', '<\\/system-reminder>');
}
export function isKebabCase(name) {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
export function slugify(name) {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'untitled';
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function isAbort(error) {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
export function isMissing(error) {
    const code = error?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}
/** Convert a glob (`**`, `*`, `?`) to an unanchored-or-full-path matcher. */
export function matchGlob(pattern, filePath) {
    const path = filePath.replace(/\\/g, '/');
    const glob = pattern.replace(/\\/g, '/').trim();
    if (glob === '' || glob === '*')
        return true;
    const regex = globToRegExp(glob);
    if (regex.test(path))
        return true;
    if (!glob.includes('/'))
        return regex.test(basename(path));
    return false;
}
function globToRegExp(glob) {
    let out = '(?:^|/)';
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        const next = glob[i + 1];
        if (char === '*' && next === '*') {
            const after = glob[i + 2];
            if (after === '/') {
                out += '(?:.*/)?';
                i += 2;
            }
            else {
                out += '.*';
                i += 1;
            }
            continue;
        }
        if (char === '*') {
            out += '[^/]*';
            continue;
        }
        if (char === '?') {
            out += '[^/]';
            continue;
        }
        if ('\\^$+()[]{}|.'.includes(char))
            out += `\\${char}`;
        else
            out += char;
    }
    out += '$';
    return new RegExp(out);
}
export function toolFilePath(args) {
    if (!isPlainObject(args))
        return undefined;
    if (typeof args.file_path === 'string' && args.file_path.trim() !== '')
        return args.file_path;
    if (typeof args.path === 'string' && args.path.trim() !== '')
        return args.path;
    return undefined;
}
export function toolCommand(args) {
    if (!isPlainObject(args))
        return undefined;
    if (typeof args.command === 'string')
        return args.command;
    return undefined;
}
export function pluginUserMessage(plugin, text, form = 'instructions') {
    return {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: form === 'notice'
            ? { kind: 'plugin', plugin, form: 'notice', summary: capString(text.replace(/\s+/g, ' ').trim(), 120) }
            : { kind: 'plugin', plugin, form: 'instructions' },
    };
}
export function reminder(plugin, body) {
    return pluginUserMessage(plugin, `<system-reminder>\n${escapeReminderClose(body)}\n</system-reminder>`);
}
