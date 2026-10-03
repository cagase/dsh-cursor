export interface CursorContentBlock {
    type: string;
    text?: string;
    name?: string;
    arguments?: string;
    content?: CursorContentBlock[];
    toolCallId?: string;
}
export interface CursorMessage {
    role: string;
    /** DSH message identity; stable across calls so a prefix can be matched. */
    id?: string;
    content: readonly CursorContentBlock[] | string;
}
export interface CursorGenerateOptions {
    provider: string;
    model: string;
    reasoningEffort?: string;
    /** DSH session id, when the caller is a loop-built session request. */
    sessionId?: string;
    /** Auxiliary call classification (`compaction`, `session-title`). */
    purpose?: string;
    messages: readonly CursorMessage[];
    system?: string;
    tools?: readonly {
        name: string;
    }[];
    signal?: AbortSignal;
    /** Workspace directory for the CLI chat, when the caller has one. */
    cwd?: string;
}
export interface ShimTurn {
    id?: string;
    role: string;
    text: string;
}
export interface SessionCheckpoint {
    readonly cliSessionId: string;
    readonly systemHash: string;
    readonly deliveredTurns: number;
    readonly turnIds: readonly (string | undefined)[];
    readonly turnHashes: readonly string[];
}
export interface AgentTurnPlan {
    /** Exactly what travels as the CLI's positional prompt. */
    readonly positional: string;
    readonly session: {
        readonly mode: 'new' | 'resume' | 'none';
        readonly id?: string;
    };
    /** The prompt carries the DSH system prompt and prior turns. */
    readonly bootstrap: boolean;
    /**
     * Prompt to send when `--new-session-id` is already a CLI chat. Steady-state
     * text only, so a restart does not dump the bootstrap into that chat again.
     */
    readonly resumePositional?: string;
    /** Turn count delivered once {@link AgentTurnPlan.commit} runs. */
    readonly deliveredTurns: number;
    /** Record the delivery; call only after the CLI turn completed. */
    commit(): void;
    /**
     * Fresh CLI session carrying the full DSH context, replacing a session the
     * CLI no longer has (dropped `--resume`). Drops the dead checkpoint.
     */
    reanchor?: () => AgentTurnPlan;
    /**
     * Fresh CLI session with a random UUIDv4 instead of the derived id, used only
     * if the CLI rejects the derived id's shape.
     */
    reanchorFresh?: () => AgentTurnPlan;
}
/**
 * Deterministic CLI chat id for a DSH session id.
 *
 * The live CLI validates `--new-session-id` as a **UUIDv4** (t3 capture: the
 * previously minted v5-shaped id exits 1 with
 * `Error: Invalid --new-session-id "…": expected a UUIDv4.`, while the same id
 * with version nibble 4 exits 0). The derivation stays deterministic — a plugin
 * restart lands on the same chat, and the `already in use` -> `--resume`
 * recovery still converges on it — but the version nibble and variant bits are
 * forced into the RFC 4122 v4 layout the validator requires.
 */
export declare function sessionUuidFor(seed: string): string;
/** True for the RFC 4122 v4 shape the CLI's `--new-session-id` validator wants. */
export declare function isSessionUuidV4(id: string): boolean;
export declare function fingerprint(text: string): string;
/** Split a request into the system prompt text and its ordered turns. */
export declare function collectTurns(options: CursorGenerateOptions): {
    systemText: string;
    turns: ShimTurn[];
};
/**
 * Bootstrap payload: the DSH system prompt and prior turns delivered once,
 * because the CLI session store starts empty. A single bare user turn stays
 * byte-identical (no wrapper), so a first one-shot call is already one-to-one.
 */
export declare function renderAgentContext(systemText: string, turns: readonly ShimTurn[]): string;
/**
 * Steady-state payload: only what the CLI session has not seen. One new user
 * turn travels byte-identical; a DSH retry with nothing new re-sends the last
 * user turn.
 */
export declare function renderResumePayload(fresh: readonly ShimTurn[], allTurns: readonly ShimTurn[]): string;
/**
 * Per-DSH-session delivery checkpoints. One CLI chat per DSH session, re-anchored
 * (new session id, context delivered once more) when DSH rewrites the prefix or
 * changes the system prompt.
 */
export declare class CursorSessionRegistry {
    private readonly checkpoints;
    private readonly generations;
    size(): number;
    clear(): void;
    plan(options: CursorGenerateOptions): AgentTurnPlan;
    /** A fresh CLI session: full context in the positional prompt, one new id. */
    private bootstrapPlan;
    /** Drop one session's checkpoint so the next call re-anchors. */
    forget(sessionId: string): void;
    private nextAnchorId;
    private commit;
}
