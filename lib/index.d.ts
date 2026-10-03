import type { HostContext } from './types.js';
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
export declare function apply(ctx: HostContext, config?: DshCursorConfig): void;
export { PROVIDER_ID } from './models/adapter.js';
export { registerCursorAdapter } from './models/adapter.js';
