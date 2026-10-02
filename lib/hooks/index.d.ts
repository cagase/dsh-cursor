import type { HostContext } from '../types.js';
import type { AgentLike, PluginLogger, PreToolDecision, ToolExecutionLike } from '../types.js';
import type { CursorSettingsLoader } from '../settings.js';
export interface HookBridgeConfig {
    hookTimeoutMs: number;
    maxHookOutputChars: number;
}
export declare function isSubagent(agent: AgentLike): boolean;
export declare function registerHooks(ctx: HostContext, logger: PluginLogger, loader: CursorSettingsLoader, config: HookBridgeConfig, permissionPre?: (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>): void;
