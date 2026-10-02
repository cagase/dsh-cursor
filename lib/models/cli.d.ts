export declare const AUTH_CODE = "AUTH";
export declare const MISSING_CREDENTIAL_CODE = "MISSING_CREDENTIAL";
export declare const INVALID_CREDENTIAL_CODE = "INVALID_CREDENTIAL";
export declare const INVALID_ARGS_CODE = "INVALID_ARGS";
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
export declare function probeCursorCli(signal?: AbortSignal): Promise<CursorCliProbe>;
export declare function listCursorModelSlugs(bin: string, signal?: AbortSignal): Promise<string[]>;
export declare function parseModelList(text: string): string[];
/** CLI help examples used only when `agent models` cannot run (AUTH). */
export declare const FALLBACK_MODEL_SLUGS: readonly ["gpt-5", "sonnet-4-thinking"];
export declare function parseCursorModelId(model: string): CursorModelRoute;
export declare function mapReasoningEffort(effort: string | undefined): string | undefined;
export declare function wireCursorModel(model: string, reasoningEffort?: string): string;
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
export interface AgentStreamEvent {
    type: string;
    text?: string;
    reasoning?: string;
    tool?: string;
    error?: string;
    done?: boolean;
    success?: boolean;
}
export declare function interpretAgentStreamLine(line: string): AgentStreamEvent | undefined;
export declare function streamAgentPrint(bin: string, wireModel: string, prompt: string, options?: {
    cwd?: string;
    signal?: AbortSignal;
}): AsyncGenerator<AgentStreamEvent>;
