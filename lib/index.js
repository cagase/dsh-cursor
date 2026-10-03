/**
 * @cagase/dsh-cursor — HOST-plane DeepSeek Harness plugin.
 *
 * Maps `.cursor/`, `~/.cursor/`, and `$CURSOR_CONFIG_DIR` skills, rules, hooks,
 * and compatible cli/mcp config onto DSH. Registers the Cursor `agent` CLI as
 * picker + AgentTeams provider `cursor`.
 */
import { join } from 'node:path';
import { registerHooks } from './hooks/index.js';
import { isFileTouchTool } from './hooks/names.js';
import { registerMcp } from './mcp.js';
import { registerCursorAdapter } from './models/adapter.js';
import { createPermissionsGate } from './permissions.js';
import { forgetLiveSession, liveCwds, noteLiveSession } from './live-sessions.js';
import { attachGlobRules, collectRules, injectSessionRules, ruleCatalogCandidates, ruleWatchRoots } from './rules/index.js';
import { CursorSettingsLoader } from './settings.js';
import { attachMatchingSkills } from './skills/attach.js';
import { CursorSkillProvider, PROVIDER_NAME } from './skills/provider.js';
import { errorMessage, toolFilePath } from './util.js';
import { watchPaths } from './watch.js';
import { projectCursorDir, userCursorDir } from './roots.js';
export const name = 'dsh-cursor';
/** Soft deps: activate even if a minimal profile omitted one of these. */
export const inject = [];
export const DEFAULT_CONFIG = {
    assets: true,
    models: true,
    skillsCursor: false,
    watch: true,
    permissions: true,
    mcp: true,
    userCursorDir: '~/.cursor',
    hookTimeoutMs: 30_000,
    maxHookOutputChars: 10_000,
    mcpToolCallTimeoutMs: 120_000,
};
export function apply(ctx, config = {}) {
    const host = ctx;
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const logger = (host.get('logger') ?? {});
    if (resolved.models) {
        registerCursorAdapter(host, logger);
    }
    if (!resolved.assets) {
        logger.info?.(`@cagase/dsh-cursor mounted (assets=false models=${resolved.models})`);
        return;
    }
    const loader = new CursorSettingsLoader(logger, resolved.userCursorDir);
    const extraRules = async (cwd, signal) => {
        if (!cwd)
            return [];
        return ruleCatalogCandidates(await collectRules(cwd, logger, signal));
    };
    const skills = host.get('skills');
    let invalidateSkills;
    let provider;
    if (skills && typeof skills.registerProvider === 'function') {
        skills.registerProvider((control) => {
            invalidateSkills = control.invalidate;
            provider = new CursorSkillProvider(logger, { userCursorDir: resolved.userCursorDir, skillsCursor: resolved.skillsCursor, agents: true }, extraRules);
            return provider;
        });
        logger.info?.(`cursor: skill provider ${JSON.stringify(PROVIDER_NAME)} registered`);
    }
    else {
        logger.warn?.('cursor: ctx.skills is missing; catalog mapping skipped');
    }
    host.on('agent/session-start', (payload) => {
        noteLiveSession(payload.agent.session.id, payload.agent.session.header.cwd);
        void injectSessionRules(payload.agent, logger, payload.source).catch((error) => {
            logger.warn?.(`cursor: session rule inject failed: ${errorMessage(error)}`);
        });
    });
    host.on('agent/disposed', (payload) => {
        forgetLiveSession(payload.agent.session.id, payload.agent.session.header.cwd);
    });
    host.on('tools/result', (exec) => {
        if (!isFileTouchTool(exec.name))
            return;
        const agent = exec.agent;
        const filePath = toolFilePath(exec.arguments);
        if (!agent || !filePath)
            return;
        void attachGlobRules(agent, filePath, logger).catch((error) => {
            logger.warn?.(`cursor: glob rule attach failed: ${errorMessage(error)}`);
        });
        void (async () => {
            if (!provider)
                return;
            const listed = await provider.list({ cwd: agent.session.header.cwd });
            const candidates = Array.isArray(listed) ? listed : listed.candidates;
            await attachMatchingSkills(agent, filePath, candidates, logger);
        })().catch((error) => {
            logger.warn?.(`cursor: skill attach failed: ${errorMessage(error)}`);
        });
    });
    const permissionGate = resolved.permissions ? createPermissionsGate(logger, loader) : undefined;
    registerHooks(host, logger, loader, { hookTimeoutMs: resolved.hookTimeoutMs, maxHookOutputChars: resolved.maxHookOutputChars }, permissionGate);
    if (resolved.mcp) {
        registerMcp(host, logger, loader, resolved.mcpToolCallTimeoutMs);
    }
    if (resolved.watch) {
        const stoppers = [];
        const refresh = () => {
            loader.invalidate();
            invalidateSkills?.();
        };
        let watchGeneration = 0;
        const ensure = () => {
            const generation = ++watchGeneration;
            for (const stop of stoppers.splice(0))
                stop();
            const cwds = liveCwds();
            const roots = [userCursorDir(resolved.userCursorDir)];
            for (const cwd of cwds)
                roots.push(projectCursorDir(cwd), join(cwd, '.cursorrules'));
            void Promise.all(cwds.map((cwd) => ruleWatchRoots(cwd))).then((ruleRootLists) => {
                if (generation !== watchGeneration)
                    return;
                stoppers.push(watchPaths([...roots, ...ruleRootLists.flat()], logger, refresh));
            }).catch((error) => {
                logger.warn?.(`cursor: asset watch setup failed: ${errorMessage(error)}`);
            });
        };
        host.on('agent/session-start', (payload) => {
            noteLiveSession(payload.agent.session.id, payload.agent.session.header.cwd);
            ensure();
        });
        host.on('agent/disposed', (payload) => {
            forgetLiveSession(payload.agent.session.id, payload.agent.session.header.cwd);
            ensure();
        });
        host.effect(() => () => {
            for (const stop of stoppers)
                stop();
        }, 'cursor asset watchers');
    }
    logger.info?.(`@cagase/dsh-cursor assets mapped (skillsCursor=${resolved.skillsCursor} watch=${resolved.watch} permissions=${resolved.permissions} mcp=${resolved.mcp} models=${resolved.models})`);
}
export { PROVIDER_NAME } from './skills/provider.js';
export { PROVIDER_ID } from './models/adapter.js';
export { userCursorDir, projectCursorDir, findRepoRoot } from './roots.js';
export { matchGlob } from './util.js';
export { classifyRule } from './rules/index.js';
export { evaluateCursorPermissions } from './permissions.js';
export { matcherHits } from './hooks/run.js';
export { registerCursorAdapter, CursorLlmAdapter } from './models/adapter.js';
export { wireCursorModel, parseCursorModelId, probeCursorCli } from './models/cli.js';
