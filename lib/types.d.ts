/** Minimal shapes borrowed from DSH so this package typechecks without every peer installed. */
export type HostContext = {
    get(name: string): unknown;
    on(event: string, listener: (...args: any[]) => unknown): unknown;
    effect(callback: () => () => void, name?: string): unknown;
    plugin(plugin: unknown, config?: unknown): unknown;
};
export interface PluginLogger {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
}
export interface AgentSession {
    id?: unknown;
    header: {
        cwd?: string;
        delegationDepth?: number;
    };
}
export interface AgentLike {
    inject(message: unknown): void;
    steer?(message: unknown): void;
    session: AgentSession;
}
export interface ToolExecutionLike {
    name: string;
    arguments: unknown;
    callId?: unknown;
    agent?: AgentLike;
}
export interface SkillInvocationPolicy {
    modelInvocable: boolean;
    userInvocable: boolean;
}
export interface SkillCandidate {
    name: string;
    description: string;
    invocation: SkillInvocationPolicy;
    source: string;
    provider: string;
    resourceBase?: {
        kind: 'directory';
        path: string;
    };
    rank: number;
    locator: unknown;
    path?: string;
    metadata?: Readonly<Record<string, unknown>>;
}
export interface SkillDefinition {
    name: string;
    description: string;
    invocation: SkillInvocationPolicy;
    source: string;
    provider: string;
    resourceBase?: {
        kind: 'directory';
        path: string;
    };
    content: string;
    path?: string;
    metadata?: Readonly<Record<string, unknown>>;
}
export interface SkillLookupOptions {
    cwd?: string;
    signal?: AbortSignal;
}
export interface SkillProvider {
    name: string;
    list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | {
        candidates: readonly SkillCandidate[];
        complete: boolean;
    }>;
    get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
}
export interface SkillProviderControl {
    signal: AbortSignal;
    invalidate: () => void;
}
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
} | {
    kind: 'ask';
    reason?: string;
};
export type PostToolDecision = {
    kind: 'accept';
    additionalContexts?: unknown[];
} | {
    kind: 'block';
    feedback: unknown[];
    additionalContexts?: unknown[];
};
export interface CommandHook {
    type?: string;
    command: string;
    timeout?: number;
    loop_limit?: number | null;
    failClosed?: boolean;
    matcher?: string;
}
export interface MatcherGroup {
    matcher?: string;
    cwd?: string;
    hooks: CommandHook[];
}
