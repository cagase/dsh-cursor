import type { HostContext } from './types.js';
import type { PluginLogger } from './types.js';
import type { CursorSettingsLoader, RawCursorMcpServer } from './settings.js';
export declare function interpolateCursor(value: string, workspaceFolder: string): string;
export declare function sanitizeServerName(name: string): string | undefined;
export declare function normalizeCursorServer(name: string, entry: RawCursorMcpServer, workspaceFolder: string, toolCallTimeoutMs: number): Promise<{
    serverName: string;
    config: Record<string, unknown>;
} | undefined>;
export declare function registerMcp(ctx: HostContext, logger: PluginLogger, loader: CursorSettingsLoader, toolCallTimeoutMs: number): void;
