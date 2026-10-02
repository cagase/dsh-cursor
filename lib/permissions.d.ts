import type { PluginLogger, PreToolDecision, ToolExecutionLike } from './types.js';
import type { CursorSettingsLoader } from './settings.js';
type TokenKind = 'shell' | 'read' | 'write' | 'webfetch' | 'mcp';
interface ParsedToken {
    kind: TokenKind;
    pattern: string;
    argsPart?: string;
}
export type PermissionVerdict = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
} | undefined;
export declare function parseToken(raw: string): ParsedToken | undefined;
export declare function evaluateCursorPermissions(allow: readonly string[], deny: readonly string[], exec: ToolExecutionLike): PermissionVerdict;
/**
 * Deny-wins only. `allow` does not skip DSH approval — unmatched and allowed
 * calls fall through to `next()`.
 */
export declare function createPermissionsGate(logger: PluginLogger, loader: CursorSettingsLoader): (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>;
export {};
