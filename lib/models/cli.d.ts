import type { AgentTurnPlan } from './session.js';
export declare const AUTH_CODE = "AUTH";
export declare const TIMEOUT_CODE = "TIMEOUT";
export declare const EMPTY_CATALOG_CODE = "EMPTY_CATALOG";
export declare const MISSING_CREDENTIAL_CODE = "MISSING_CREDENTIAL";
export declare const INVALID_CREDENTIAL_CODE = "INVALID_CREDENTIAL";
export declare const INVALID_ARGS_CODE = "INVALID_ARGS";
export declare const INVALID_SESSION_ID_CODE = "INVALID_SESSION_ID";
export declare const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
export declare class CursorCliError extends Error {
    readonly code: string;
    readonly failure: {
        readonly message: string;
        readonly code: string;
    };
    constructor(message: string, code: string);
}
export interface CursorCliProbe {
    bin?: string;
    authenticated: boolean;
    error?: string;
    code?: string;
}
export interface CursorModelRoute {
    id: string;
    base: string;
    fast?: boolean;
    effort?: string;
    passthrough?: string;
}
export declare function hasEnvCredential(): boolean;
export declare function classifyCliFailure(detail: string): {
    code: string;
    message: string;
} | undefined;
export declare function missingBinaryError(): CursorCliError;
export declare function authError(message?: string): CursorCliError;
export declare function resolveAgentBin(): Promise<string | undefined>;
/**
 * Absolute root of the CLI's local chat store. Production uses the CLI default
 * `~/.cursor/chats` (capture §6); `CURSOR_CHATS_DIR` overrides it so the
 * offline suite can point the adapter and its stand-in at one directory.
 */
export declare function cursorChatsRoot(): string;
/**
 * The `store.db` the CLI resumes for this session under the spawn cwd:
 * `<chats root>/<md5(resolve(cwd))>/<id>/store.db`.
 * Returns undefined when the path cannot be established. Callers treat that
 * as not confirmed and keep the full bootstrap.
 */
export declare function cursorChatStorePath(sessionId: string, cwd?: string): string | undefined;
/** True only when this workspace's chat store exists and is non-empty. */
export declare function hasCursorChatStore(sessionId: string, cwd?: string): Promise<boolean>;
/** True when that chat's store file exists and is non-empty. */
export declare function cursorChatHasTranscript(sessionId: string, cwd?: string): Promise<boolean>;
export declare function probeCursorCli(signal?: AbortSignal): Promise<CursorCliProbe>;
/** One advertised catalog entry: the id handed to `--model` plus its label. */
export interface CursorCatalogEntry {
    id: string;
    label?: string;
}
export declare function listCursorModelCatalog(bin: string, signal?: AbortSignal): Promise<CursorCatalogEntry[]>;
export declare function listCursorModelSlugs(bin: string, signal?: AbortSignal): Promise<string[]>;
/**
 * Parse a catalog listing into id/label pairs. `agent models` is line-oriented
 * text (`<id> - <label>`) with no JSON form; JSON is still accepted first for
 * forward compatibility.
 */
export declare function parseModelCatalog(text: string): CursorCatalogEntry[];
export declare function parseModelList(text: string): string[];
/** CLI help examples used only when `agent models` cannot run (AUTH). */
export declare const FALLBACK_MODEL_SLUGS: readonly ["gpt-5", "sonnet-4-thinking"];
/** Split a route id into its base and any encoded effort / Fast suffix. */
export declare function parseCursorModelId(model: string): CursorModelRoute;
/**
 * Normalize a caller effort into the CLI's own slug vocabulary. `xhigh` is the
 * catalog spelling; there is no `max` level for any Grok base (capture §2), so
 * nothing is rewritten into `max` here.
 */
export declare function mapReasoningEffort(effort: string | undefined): string | undefined;
export interface CursorWireOptions {
    /** Slugs the CLI advertises for this account (live catalog ∪ captured set). */
    vocabulary?: ReadonlySet<string> | readonly string[];
    /** Live catalog slugs, so a family the capture does not know still composes. */
    liveSlugs?: readonly string[];
    /** Route default effort materialized when the caller omits one. */
    defaultEffort?: string;
}
/**
 * Compose the exact string handed to `agent --model`.
 *
 * Grok routes are composed from the CLI's own advertised slug vocabulary
 * (`<base>-<effort>`, `<base>-<effort>-fast`) — never from `base[param=value]`
 * overrides, which the CLI rejects (capture §3.2). A caller-supplied bracketed
 * id passes through byte-identical, and every non-Grok provider keeps its
 * catalog id verbatim: no synthetic suffix and no synthetic effort. A pair with
 * no advertised slug fails with INVALID_ARGS instead of guessing.
 */
export declare function wireCursorModel(model: string, reasoningEffort?: string, options?: CursorWireOptions): string;
export interface AgentRunResult {
    stdout: string;
    stderr: string;
    code: number | null;
}
export declare function runAgent(bin: string, args: readonly string[], options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    cwd?: string;
    stdin?: string;
}): Promise<AgentRunResult>;
export type AgentStreamEvent = {
    type: 'text';
    text: string;
} | {
    type: 'reasoning';
    text: string;
}
/** The CLI's own tool activity: a turn boundary, never transcript content. */
 | {
    type: 'tool';
} | {
    type: 'result';
    text?: string;
    done: true;
    success: boolean;
} | {
    type: 'error';
    error: string;
    done: true;
    success: false;
} | {
    type: 'ignored';
};
export declare function interpretAgentStreamLine(line: string): AgentStreamEvent;
/**
 * Map one `--output-format stream-json` object to a transcript event.
 *
 * Only `assistant` carries assistant text and only `thinking`/`reasoning`
 * carries thinking. `system` init, the `user` prompt echo, `tool_call`,
 * `retry`, `connection` and `interaction_query` are dropped: none of them is
 * part of the DSH transcript (capture §7).
 */
export declare function interpretAgentStreamObject(value: Record<string, unknown>): AgentStreamEvent;
/**
 * Full `agent` argument list for one planned shim turn. Exactly one positional
 * prompt travels; the session store is selected by `--new-session-id` once and
 * `--resume` afterwards (capture §6).
 */
export declare function buildAgentArgs(wireModel: string, plan: AgentTurnPlan, cwd?: string): string[];
/** Mutable holder so a recovery inside {@link streamAgentTurn} is the plan the caller commits. */
export interface AgentTurnHolder {
    plan: AgentTurnPlan;
}
/**
 * Stream one planned turn, yielding transcript events only. Terminal failures
 * are yielded last so the caller can classify them. Two recoveries keep the
 * turn alive without ever failing the DSH request:
 *   - a single-use `--new-session-id` collision (the DSH session's CLI chat
 *     already exists, e.g. after a plugin restart) resumes that chat;
 *   - a failed `--resume` (the CLI no longer has the chat) degrades to a fresh
 *     session that carries the full DSH context again.
 * `turn.plan` is updated to whichever session actually served the turn.
 */
export declare function streamAgentTurn(bin: string, wireModel: string, turn: AgentTurnHolder, options?: {
    cwd?: string;
    signal?: AbortSignal;
}): AsyncGenerator<AgentStreamEvent>;
