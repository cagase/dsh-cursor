import { watch } from 'node:fs';
import { errorMessage } from './util.js';
const STABILITY_MS = 200;
const MAX_WATCHERS = 64;
export function watchPaths(paths, logger, onChange) {
    const watchers = new Map();
    let timer;
    const bump = () => {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            onChange();
        }, STABILITY_MS);
    };
    for (const path of paths) {
        if (watchers.size >= MAX_WATCHERS)
            break;
        if (watchers.has(path))
            continue;
        try {
            const watcher = watch(path, { recursive: true, persistent: false }, () => bump());
            watcher.on('error', (error) => {
                logger.warn?.(`cursor: watcher for ${path} failed: ${errorMessage(error)}`);
            });
            watchers.set(path, watcher);
        }
        catch (error) {
            logger.warn?.(`cursor: cannot watch ${path}: ${errorMessage(error)}`);
        }
    }
    return () => {
        if (timer !== undefined)
            clearTimeout(timer);
        for (const watcher of watchers.values())
            watcher.close();
        watchers.clear();
    };
}
