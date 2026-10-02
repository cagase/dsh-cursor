import { type ChildProcess } from 'node:child_process';
import type { MatcherGroup, PluginLogger } from '../types.js';
export interface HookOutcome {
    ran: boolean;
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    output?: HookJson;
    failClosed: boolean;
    loopLimit?: number;
}
export interface HookJson {
    permission?: string;
    additional_context?: string;
    agent_message?: string;
    user_message?: string;
    continue?: boolean;
    followup_message?: string;
    updated_input?: unknown;
}
export interface HookRunSpec {
    event: string;
    groups: readonly MatcherGroup[];
    matchedValue: string | undefined;
    input: Record<string, unknown>;
    cwd: string;
    defaultTimeoutMs: number;
    signal?: AbortSignal;
    onSpawn?: (child: ChildProcess) => void;
}
export declare function matcherHits(matcher: string | undefined, value: string | undefined): boolean;
export declare function runEventHooks(spec: HookRunSpec, logger: PluginLogger): Promise<HookOutcome[]>;
export declare function parseHookJson(stdout: string): HookJson | undefined;
export declare function firstNonEmpty(...values: Array<string | undefined>): string;
export declare function collectAdditionalContext(outcomes: readonly HookOutcome[], maxChars: number): string[];
