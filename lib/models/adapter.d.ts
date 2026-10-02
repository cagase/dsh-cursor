import type { HostContext, PluginLogger } from '../types.js';
export declare const PROVIDER_ID = "cursor";
declare const REASONING_EFFORTS: readonly [{
    readonly id: "low";
    readonly name: "Low";
}, {
    readonly id: "high";
    readonly name: "High";
}, {
    readonly id: "xhigh";
    readonly name: "Extra High";
    readonly description: "Maps to Cursor CLI effort=max";
}];
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
    content: readonly CursorContentBlock[] | string;
}
export interface CursorGenerateOptions {
    provider: string;
    model: string;
    reasoningEffort?: string;
    messages: readonly CursorMessage[];
    system?: string;
    tools?: readonly {
        name: string;
    }[];
    signal?: AbortSignal;
}
export interface CursorStreamChunk {
    type: 'block-start' | 'text-delta' | 'reasoning-delta' | 'block-end' | 'finish';
    index?: number;
    blockType?: 'text' | 'reasoning';
    text?: string;
    block?: {
        type: 'text' | 'reasoning';
        text: string;
    };
    reason?: {
        kind: 'stop' | 'error' | 'aborted';
        failure?: {
            message: string;
            code: string;
        };
    };
}
export interface CursorModelInfo {
    provider: string;
    id: string;
    name: string;
    description?: string;
    inputModalities?: readonly ['text'];
}
export interface CursorResolvedModelInfo extends CursorModelInfo {
    reasoning: {
        efforts: typeof REASONING_EFFORTS;
        defaultEffort?: 'high';
    };
}
export declare function flattenGeneratePrompt(options: CursorGenerateOptions): string;
export declare function expandModelCatalog(slugs: readonly string[], fallback: boolean): CursorModelInfo[];
export declare class CursorLlmAdapter {
    private readonly logger?;
    constructor(logger?: PluginLogger | undefined);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    providerRetryPolicy(_provider: string): undefined;
    imageRequestPricing(_provider: string, _model: string): undefined;
    listModels(_provider: string): Promise<CursorModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<CursorResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: CursorResolvedModelInfo;
        stream: (options: CursorGenerateOptions) => AsyncGenerator<CursorStreamChunk, any, any>;
    }>;
    stream(options: CursorGenerateOptions): AsyncGenerator<CursorStreamChunk>;
}
export interface LlmLike {
    registerAdapter(providers: string[], adapter: CursorLlmAdapter): {
        replace?: (providers: string[]) => void;
    } | void;
    registerConfigurableProviders?: (entries: Array<{
        provider: string;
        displayName: string;
        settingsNs: string;
        settingsPath: readonly string[];
        declared?: boolean;
        error?: string;
    }>) => {
        replace?: (entries: unknown[]) => void;
    } | void;
}
export declare function registerCursorAdapter(host: HostContext, logger: PluginLogger): void;
export declare function isCursorGenerateOptions(value: unknown): value is CursorGenerateOptions;
export {};
