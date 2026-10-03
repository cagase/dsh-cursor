import type { HostContext, PluginLogger } from '../types.js';
import { renderAgentContext, type CursorGenerateOptions } from './session.js';
export declare const PROVIDER_ID = "cursor";
export type { CursorContentBlock, CursorGenerateOptions, CursorMessage } from './session.js';
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
export interface CursorEffortInfo {
    id: string;
    name: string;
    description?: string;
}
export interface CursorResolvedModelInfo extends CursorModelInfo {
    reasoning?: {
        efforts: readonly CursorEffortInfo[];
        defaultEffort?: string;
    };
}
/**
 * Publish the DSH picker catalog.
 *
 * Non-Grok models are listed verbatim from the CLI catalog: no renamed entry,
 * no synthetic suffix and no synthetic effort. Every Grok family gets exactly
 * one base entry plus its own `<base>-fast` entry (DSH has no boolean model
 * parameter), both carrying only the efforts whose composed slug exists. The
 * fallback path (AUTH or a missing binary) keeps the CLI help slugs verbatim
 * and uses the captured Grok matrix — it never invents an effort or a Fast
 * entry.
 */
export declare function expandModelCatalog(slugs: readonly string[], fallback: boolean, labels?: ReadonlyMap<string, string>): CursorModelInfo[];
export declare class CursorLlmAdapter {
    private readonly logger?;
    private readonly sessions;
    private catalog?;
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
    /** A failed continuation drops its checkpoint so the next turn re-anchors. */
    private recoverSession;
    private entryName;
    /** Slugs the CLI advertises right now, plus the captured Grok vocabulary. */
    private grokVocabulary;
    private cacheCatalog;
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
export { renderAgentContext };
