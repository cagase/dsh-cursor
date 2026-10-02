import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-cursor";
/** Soft deps: activate even if a minimal profile omitted one of these. */
export declare const inject: readonly [];
export interface DshCursorConfig {
    /** Discover and map Cursor skills / agents / rules / hooks / mcp / permissions. */
    assets?: boolean;
    /** Register the `cursor` LLM adapter for picker + AgentTeams routes. */
    models?: boolean;
    /** Include `~/.cursor/skills-cursor` (default off). */
    skillsCursor?: boolean;
    /** Watch Cursor asset files and invalidate catalogs. */
    watch?: boolean;
    /** Apply cli.json / cli-config.json deny tokens at tools/pre-execute. */
    permissions?: boolean;
    /** Mount mcp.json servers via @deepseek-ai/dsh-mcp-client. */
    mcp?: boolean;
    /** User-level Cursor directory (usually `~/.cursor`; `CURSOR_CONFIG_DIR` wins). */
    userCursorDir?: string;
    /** Default hook timeout (ms). */
    hookTimeoutMs?: number;
    /** Cap on hook-injected context characters. */
    maxHookOutputChars?: number;
    /** Per-tool-call timeout for bridged MCP servers (ms). */
    mcpToolCallTimeoutMs?: number;
}
export declare const DEFAULT_CONFIG: {
    readonly assets: true;
    readonly models: true;
    readonly skillsCursor: false;
    readonly watch: true;
    readonly permissions: true;
    readonly mcp: true;
    readonly userCursorDir: "~/.cursor";
    readonly hookTimeoutMs: 30000;
    readonly maxHookOutputChars: 10000;
    readonly mcpToolCallTimeoutMs: 120000;
};
export declare function apply(ctx: Context | import('./types.js').HostContext, config?: DshCursorConfig): void;
export { PROVIDER_NAME } from './skills/provider.js';
export { PROVIDER_ID } from './models/adapter.js';
export { userCursorDir, projectCursorDir, findRepoRoot } from './roots.js';
export { matchGlob } from './util.js';
export { classifyRule } from './rules/index.js';
export { evaluateCursorPermissions } from './permissions.js';
export { matcherHits } from './hooks/run.js';
export { registerCursorAdapter, CursorLlmAdapter } from './models/adapter.js';
export { wireCursorModel, parseCursorModelId, probeCursorCli } from './models/cli.js';
