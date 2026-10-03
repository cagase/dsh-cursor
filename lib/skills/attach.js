import { dirname } from 'node:path';
import { readText } from '../fs.js';
import { parseSkillFile } from '../parse.js';
import { errorMessage, matchGlob, reminder } from '../util.js';
import { catalogName, PROVIDER_NAME } from './provider.js';
const PLUGIN_SOURCE = `dsh-cursor:${PROVIDER_NAME}/attach`;
const injected = new WeakMap();
function remember(agent, key) {
    let set = injected.get(agent);
    if (!set) {
        set = new Set();
        injected.set(agent, set);
    }
    if (set.has(key))
        return false;
    set.add(key);
    return true;
}
export function skillMatchesPath(candidate, filePath) {
    const metadata = candidate.metadata;
    const paths = Array.isArray(metadata?.paths) ? metadata.paths.filter((entry) => typeof entry === 'string') : [];
    const globs = Array.isArray(metadata?.globs) ? metadata.globs.filter((entry) => typeof entry === 'string') : [];
    if (paths.length === 0 && globs.length === 0)
        return false;
    return [...paths, ...globs].some((pattern) => matchGlob(pattern, filePath));
}
export async function attachMatchingSkills(agent, filePath, candidates, logger) {
    for (const candidate of candidates) {
        if (!skillMatchesPath(candidate, filePath))
            continue;
        const locator = candidate.locator;
        const file = locator?.file ?? candidate.path;
        if (!file || locator?.kind === 'rule' || locator?.kind === 'agent')
            continue;
        if (!remember(agent, `skill:${file}`))
            continue;
        try {
            const read = await readText(file);
            if (read.truncated)
                throw new Error(`skill file exceeds the read cap: ${file}`);
            const parsed = parseSkillFile(read.text, candidate.name);
            const name = catalogName(parsed.frontmatter.name, candidate.name);
            agent.inject(reminder(PLUGIN_SOURCE, `Cursor skill \`${name}\` applies because \`${filePath}\` matched its paths/globs.\n\n${parsed.body}`));
        }
        catch (error) {
            logger.warn?.(`cursor: skill path attach failed for ${file}: ${errorMessage(error)}`);
        }
    }
}
export function resourceDir(file) {
    return dirname(file);
}
