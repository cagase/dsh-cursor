import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbort, isMissing } from './util.js';
export async function readText(path, signal) {
    return await readFile(path, { encoding: 'utf8', signal });
}
export async function fileExists(path, signal) {
    if (signal?.aborted)
        throw new DOMException('Aborted', 'AbortError');
    try {
        const info = await stat(path);
        return info.isFile();
    }
    catch (error) {
        if (isAbort(error))
            throw error;
        if (isMissing(error))
            return false;
        throw error;
    }
}
export async function dirExists(path, signal) {
    if (signal?.aborted)
        throw new DOMException('Aborted', 'AbortError');
    try {
        const info = await stat(path);
        return info.isDirectory();
    }
    catch (error) {
        if (isAbort(error))
            throw error;
        if (isMissing(error))
            return false;
        throw error;
    }
}
export async function listDir(path, signal) {
    const entries = await readdir(path, { withFileTypes: true });
    if (signal?.aborted)
        throw new DOMException('Aborted', 'AbortError');
    return entries.map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
        isFile: entry.isFile(),
    }));
}
export async function stamp(path) {
    try {
        const info = await stat(path);
        return `${info.mtimeMs}:${info.size}`;
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
