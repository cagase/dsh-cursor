import { dirname, join } from 'node:path';
import { dirExists, fileExists, listDir, readText } from '../fs.js';
import { FrontmatterError, parseAgentFile, parseSkillFile } from '../parse.js';
import { projectCursorDir, userCursorDir } from '../roots.js';
import { capString, errorMessage, isAbort, isKebabCase, isMissing, slugify } from '../util.js';
export const PROVIDER_NAME = 'cursor';
const RANK_PROJECT_SKILLS = 225;
const RANK_PROJECT_AGENTS = 226;
const RANK_USER_SKILLS = 230;
const RANK_USER_AGENTS = 231;
const RANK_USER_SKILLS_CURSOR = 232;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_SKILL_DEPTH = 32;
export class CursorSkillProvider {
    logger;
    options;
    extra;
    name = PROVIDER_NAME;
    constructor(logger, options, extra) {
        this.logger = logger;
        this.options = options;
        this.extra = extra;
    }
    resolveRoots(cwd) {
        const userDir = userCursorDir(this.options.userCursorDir);
        const roots = [{ kind: 'user-skills', path: join(userDir, 'skills'), rank: RANK_USER_SKILLS }];
        if (this.options.skillsCursor) {
            roots.push({ kind: 'user-skills-cursor', path: join(userDir, 'skills-cursor'), rank: RANK_USER_SKILLS_CURSOR });
        }
        if (this.options.agents) {
            roots.push({ kind: 'user-agents', path: join(userDir, 'agents'), rank: RANK_USER_AGENTS });
        }
        if (cwd) {
            const dir = projectCursorDir(cwd);
            roots.push({ kind: 'project-skills', path: join(dir, 'skills'), rank: RANK_PROJECT_SKILLS });
            if (this.options.agents) {
                roots.push({ kind: 'project-agents', path: join(dir, 'agents'), rank: RANK_PROJECT_AGENTS });
            }
        }
        return roots;
    }
    async list(options) {
        const roots = this.resolveRoots(options.cwd);
        const candidates = [];
        let complete = true;
        for (const root of roots) {
            if (options.signal?.aborted)
                return { candidates, complete: false };
            const result = await this.listRoot(root, options, candidates);
            complete = complete && result.complete;
            if (!result.continue)
                return { candidates, complete };
        }
        if (this.extra) {
            try {
                candidates.push(...(await this.extra(options.cwd, options.signal)));
            }
            catch (error) {
                if (isAbort(error))
                    return { candidates, complete: false };
                this.logger.warn?.(`cursor: extra skill catalog failed: ${errorMessage(error)}`);
                complete = false;
            }
        }
        return { candidates, complete };
    }
    async listRoot(root, options, candidates) {
        let entries;
        try {
            entries = await listDir(root.path, options.signal);
        }
        catch (error) {
            if (isAbort(error))
                return { complete: false, continue: false };
            if (isMissing(error))
                return { complete: true, continue: true };
            this.logger.warn?.(`cursor: cannot read asset root ${root.path}: ${errorMessage(error)}`);
            return { complete: false, continue: true };
        }
        for (const entry of entries) {
            if (options.signal?.aborted)
                return { complete: false, continue: false };
            if (root.kind.endsWith('-skills') || root.kind === 'user-skills-cursor') {
                if (!entry.isDir || entry.name.startsWith('.'))
                    continue;
                const result = await this.listBundleDirs(join(root.path, entry.name), root, options, candidates, 1);
                if (!result.complete)
                    return result;
                if (!result.continue)
                    return { complete: false, continue: false };
            }
            else {
                if (!entry.isFile || !entry.name.toLowerCase().endsWith('.md'))
                    continue;
                try {
                    const file = join(root.path, entry.name);
                    const text = await readText(file, options.signal);
                    candidates.push(this.agentSummary(root, entry.name.replace(/\.md$/i, ''), file, text));
                }
                catch (error) {
                    if (isAbort(error))
                        return { complete: false, continue: false };
                    if (isMissing(error))
                        continue;
                    if (error instanceof FrontmatterError) {
                        this.logger.warn?.(`cursor: skipping invalid agent ${root.path}/${entry.name}: ${error.message}`);
                        continue;
                    }
                    this.logger.warn?.(`cursor: cannot read agent entry under ${root.path}: ${errorMessage(error)}`);
                    return { complete: false, continue: true };
                }
            }
        }
        return { complete: true, continue: true };
    }
    async listBundleDirs(dir, root, options, candidates, depth) {
        if (depth > MAX_SKILL_DEPTH)
            return { complete: true, continue: true };
        const skillFile = join(dir, 'SKILL.md');
        try {
            if (await fileExists(skillFile, options.signal)) {
                const text = await readText(skillFile, options.signal);
                try {
                    candidates.push(this.skillSummary(root, dir.split(/[/\\]/).pop() ?? 'skill', skillFile, text));
                }
                catch (error) {
                    if (isAbort(error))
                        return { complete: false, continue: false };
                    if (isMissing(error)) {
                        // vanished mid-scan
                    }
                    else if (error instanceof FrontmatterError) {
                        this.logger.warn?.(`cursor: skipping invalid skill ${skillFile}: ${error.message}`);
                    }
                    else {
                        this.logger.warn?.(`cursor: cannot read skill entry ${skillFile}: ${errorMessage(error)}`);
                        return { complete: false, continue: true };
                    }
                }
            }
        }
        catch (error) {
            if (isAbort(error))
                return { complete: false, continue: false };
            if (!isMissing(error)) {
                this.logger.warn?.(`cursor: cannot read skill entry ${skillFile}: ${errorMessage(error)}`);
                return { complete: false, continue: true };
            }
        }
        let entries;
        try {
            entries = await listDir(dir, options.signal);
        }
        catch (error) {
            if (isAbort(error))
                return { complete: false, continue: false };
            if (isMissing(error))
                return { complete: true, continue: true };
            this.logger.warn?.(`cursor: cannot read skill directory ${dir}: ${errorMessage(error)}`);
            return { complete: false, continue: true };
        }
        for (const entry of entries) {
            if (options.signal?.aborted)
                return { complete: false, continue: false };
            if (!entry.isDir || entry.name.startsWith('.'))
                continue;
            const result = await this.listBundleDirs(join(dir, entry.name), root, options, candidates, depth + 1);
            if (!result.complete)
                return result;
            if (!result.continue)
                return { complete: false, continue: false };
        }
        return { complete: true, continue: true };
    }
    skillSummary(root, fallbackName, file, text) {
        const parsed = parseSkillFile(text, fallbackName);
        const name = catalogName(parsed.frontmatter.name, fallbackName);
        const locator = { root: root.path, rootKind: root.kind, entry: name, kind: 'bundle', file };
        return {
            name,
            description: capString(parsed.frontmatter.description, MAX_DESCRIPTION_CHARS),
            invocation: {
                modelInvocable: !parsed.frontmatter.disableModelInvocation,
                userInvocable: parsed.frontmatter.userInvocable,
            },
            source: root.kind.startsWith('project') ? 'project-cursor' : 'user-cursor',
            provider: PROVIDER_NAME,
            resourceBase: { kind: 'directory', path: dirname(file) },
            rank: root.rank,
            locator,
            path: file,
            metadata: {
                ...(parsed.frontmatter.metadata ?? {}),
                cursorKind: 'skill',
                paths: parsed.frontmatter.paths ?? [],
                globs: parsed.frontmatter.globs ?? [],
            },
        };
    }
    agentSummary(root, fallbackName, file, text) {
        const parsed = parseAgentFile(text, fallbackName);
        const name = catalogName(parsed.name, fallbackName);
        if (parsed.readonly) {
            this.logger.warn?.(`cursor: agent ${JSON.stringify(name)} has readonly mode; registered without a tool filter (stand-in)`);
        }
        if (parsed.background) {
            this.logger.warn?.(`cursor: agent ${JSON.stringify(name)} is a background agent; DSH subagent calls are synchronous`);
        }
        const locator = { root: root.path, rootKind: root.kind, entry: name, kind: 'agent', file };
        return {
            name,
            description: capString(parsed.description, MAX_DESCRIPTION_CHARS),
            invocation: { modelInvocable: true, userInvocable: true },
            source: root.kind.startsWith('project') ? 'project-cursor' : 'user-cursor',
            provider: PROVIDER_NAME,
            rank: root.rank,
            locator,
            path: file,
            metadata: {
                cursorKind: 'agent',
                model: parsed.model ?? '',
                readonly: parsed.readonly ? 'true' : 'false',
                background: parsed.background ? 'true' : 'false',
            },
        };
    }
    async get(candidate, options) {
        const locator = candidate.locator;
        if (locator.kind === 'rule') {
            return {
                name: candidate.name,
                description: candidate.description,
                invocation: candidate.invocation,
                source: candidate.source,
                provider: PROVIDER_NAME,
                content: typeof candidate.metadata?.body === 'string' ? candidate.metadata.body : '',
                path: locator.file,
                metadata: candidate.metadata,
            };
        }
        let text;
        try {
            text = await readText(locator.file, options.signal);
        }
        catch (error) {
            if (isAbort(error))
                throw error;
            return undefined;
        }
        try {
            const source = locator.rootKind.startsWith('project') ? 'project-cursor' : 'user-cursor';
            if (locator.kind === 'agent') {
                const parsed = parseAgentFile(text, locator.entry);
                return {
                    name: catalogName(parsed.name, locator.entry),
                    description: capString(parsed.description, MAX_DESCRIPTION_CHARS),
                    invocation: { modelInvocable: true, userInvocable: true },
                    source,
                    provider: PROVIDER_NAME,
                    content: buildAgentSkillBody(parsed.name, parsed.description, parsed.body, parsed.model),
                    path: locator.file,
                    metadata: candidate.metadata,
                };
            }
            const parsed = parseSkillFile(text, locator.entry);
            return {
                name: catalogName(parsed.frontmatter.name, locator.entry),
                description: capString(parsed.frontmatter.description, MAX_DESCRIPTION_CHARS),
                invocation: {
                    modelInvocable: !parsed.frontmatter.disableModelInvocation,
                    userInvocable: parsed.frontmatter.userInvocable,
                },
                source,
                provider: PROVIDER_NAME,
                resourceBase: { kind: 'directory', path: dirname(locator.file) },
                content: parsed.body,
                path: locator.file,
                metadata: {
                    ...(parsed.frontmatter.metadata ?? {}),
                    cursorKind: 'skill',
                    paths: parsed.frontmatter.paths ?? [],
                    globs: parsed.frontmatter.globs ?? [],
                },
            };
        }
        catch (error) {
            if (error instanceof FrontmatterError) {
                this.logger.warn?.(`cursor: cannot load malformed asset ${locator.file}: ${error.message}`);
                return undefined;
            }
            throw error;
        }
    }
}
export function catalogName(name, fallback) {
    if (isKebabCase(name))
        return name;
    const slug = slugify(name || fallback);
    return isKebabCase(slug) ? slug : slugify(fallback);
}
export function buildAgentSkillBody(name, description, body, model) {
    const lines = [
        `# Delegate: ${name}`,
        '',
        description,
        '',
        'When this skill is invoked, start a DSH subagent with these instructions.',
    ];
    if (model)
        lines.push('', `Preferred model: \`${model}\`.`);
    if (body.trim() !== '')
        lines.push('', body.trim());
    return lines.join('\n');
}
export function registerCursorSkills(ctx, logger, options, extra) {
    if (!ctx.skills) {
        logger.warn?.('cursor: ctx.skills is missing; skill catalog mapping skipped');
        return undefined;
    }
    let provider;
    ctx.skills.registerProvider((control) => {
        provider = new CursorSkillProvider(logger, options, extra);
        control.signal.addEventListener('abort', () => { });
        return provider;
    });
    return provider;
}
export async function skillWatchRoots(configuredUserDir, cwd, skillsCursor = false) {
    const userDir = userCursorDir(configuredUserDir);
    const roots = [join(userDir, 'skills'), join(userDir, 'agents')];
    if (skillsCursor)
        roots.push(join(userDir, 'skills-cursor'));
    if (cwd) {
        const dir = projectCursorDir(cwd);
        roots.push(join(dir, 'skills'), join(dir, 'agents'));
    }
    const existing = [];
    for (const root of roots) {
        if (await dirExists(root))
            existing.push(root);
    }
    return existing;
}
