import type { MatcherGroup, PluginLogger } from './types.js';
export interface RawCursorMcpServer {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    envFile?: string;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    auth?: unknown;
    baseDir: string;
}
export interface LoadedCursorSettings {
    byEvent: ReadonlyMap<string, readonly MatcherGroup[]>;
    permissionAllow: readonly string[];
    permissionDeny: readonly string[];
    approvalMode?: string;
    mcpServers: ReadonlyMap<string, RawCursorMcpServer>;
    mcpAllowlist: readonly string[];
    terminalAllowlist: readonly string[];
}
export declare class CursorSettingsLoader {
    private readonly logger;
    private readonly configuredUserDir;
    private readonly cache;
    private notedUnsupported;
    constructor(logger: PluginLogger, configuredUserDir: string);
    userDir(): string;
    sourcePaths(cwd?: string): Promise<string[]>;
    invalidate(): void;
    private sources;
    load(cwd?: string): Promise<LoadedCursorSettings>;
    private noteUnsupported;
    private loadFresh;
    private readLayer;
}
