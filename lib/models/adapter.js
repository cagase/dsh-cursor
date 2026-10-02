import { isAbort, isPlainObject } from '../util.js';
import { CursorCliError, EMPTY_RESPONSE_CODE, FALLBACK_MODEL_SLUGS, authError, classifyCliFailure, listCursorModelSlugs, missingBinaryError, parseCursorModelId, probeCursorCli, streamAgentPrint, wireCursorModel, } from './cli.js';
export const PROVIDER_ID = 'cursor';
const FALLBACK_DESCRIPTION = 'Cursor CLI help example. Run `agent login`, then `agent models`, to confirm this slug for your account.';
const REASONING_EFFORTS = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Extra High', description: 'Maps to Cursor CLI effort=max' },
];
export function flattenGeneratePrompt(options) {
    const parts = [];
    if (options.system?.trim())
        parts.push(`System:\n${options.system.trim()}`);
    if (options.tools && options.tools.length > 0) {
        parts.push('Note: this request is executed by the Cursor agent CLI, which uses its own workspace tools. DSH tool schemas are not forwarded.');
    }
    for (const message of options.messages) {
        const text = flattenContent(message.content);
        if (text === '')
            continue;
        parts.push(`${roleLabel(message.role)}:\n${text}`);
    }
    return parts.join('\n\n') || '(empty request)';
}
function roleLabel(role) {
    if (role === 'assistant')
        return 'Assistant';
    if (role === 'system')
        return 'System';
    return 'User';
}
function flattenContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object')
            continue;
        if (block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        else if (block.type === 'reasoning' && typeof block.text === 'string')
            parts.push(`[reasoning]\n${block.text}`);
        else if (block.type === 'tool-call') {
            parts.push(`[tool-call ${block.name ?? 'tool'}] ${block.arguments ?? ''}`);
        }
        else if (block.type === 'tool-result') {
            parts.push(`[tool-result ${block.toolCallId ?? ''}]\n${flattenContent(block.content ?? [])}`);
        }
    }
    return parts.join('\n');
}
export function expandModelCatalog(slugs, fallback) {
    const models = [];
    const seen = new Set();
    const add = (id, name, description) => {
        if (seen.has(id) || id === '')
            return;
        seen.add(id);
        models.push({
            provider: PROVIDER_ID,
            id,
            name,
            ...description ? { description } : {},
            inputModalities: ['text'],
        });
    };
    for (const slug of slugs) {
        add(slug, displayName(slug), fallback ? FALLBACK_DESCRIPTION : undefined);
        if (!fallback || slug.includes('['))
            continue;
        const parsed = parseCursorModelId(slug);
        const base = parsed.passthrough ? slug : parsed.base;
        add(`${base}-fast`, `${displayName(base)} Fast`, `${FALLBACK_DESCRIPTION} Fast maps to [fast=true].`);
        add(`${base}-xhigh`, `${displayName(base)} Extra High`, `${FALLBACK_DESCRIPTION} Extra High maps to [effort=max].`);
    }
    return models;
}
function displayName(id) {
    return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}
export class CursorLlmAdapter {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    providerInfo(provider) {
        return { id: provider, name: provider === PROVIDER_ID ? 'Cursor' : provider };
    }
    providerRetryPolicy(_provider) {
        return undefined;
    }
    imageRequestPricing(_provider, _model) {
        return undefined;
    }
    async listModels(_provider) {
        const probe = await probeCursorCli();
        if (!probe.bin)
            throw missingBinaryError();
        if (!probe.authenticated) {
            this.logger?.warn?.(probe.error ?? 'cursor: agent CLI is not logged in');
            return expandModelCatalog(FALLBACK_MODEL_SLUGS, true);
        }
        try {
            const slugs = await listCursorModelSlugs(probe.bin);
            return expandModelCatalog(slugs, false);
        }
        catch (error) {
            if (error instanceof CursorCliError) {
                this.logger?.warn?.(error.message);
                return expandModelCatalog(FALLBACK_MODEL_SLUGS, true);
            }
            throw error;
        }
    }
    async resolveModel(provider, model, _signal) {
        const parsed = parseCursorModelId(model);
        const base = parsed.passthrough ? model : parsed.base;
        const suffix = parsed.fast ? ' Fast' : parsed.effort === 'max' ? ' Extra High' : '';
        return {
            provider,
            id: model,
            name: `${displayName(base)}${suffix}`,
            description: parsed.fast
                ? 'Cursor CLI Fast ([fast=true])'
                : parsed.effort === 'max'
                    ? 'Cursor CLI Extra High ([effort=max])'
                    : undefined,
            inputModalities: ['text'],
            reasoning: {
                efforts: REASONING_EFFORTS,
            },
        };
    }
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        try {
            const probe = await probeCursorCli(options.signal);
            if (!probe.bin)
                throw missingBinaryError();
            if (!probe.authenticated)
                throw authError(probe.error);
            const wire = wireCursorModel(options.model, options.reasoningEffort);
            const prompt = flattenGeneratePrompt(options);
            const translator = new StreamChunkTranslator();
            let sawError;
            for await (const event of streamAgentPrint(probe.bin, wire, prompt, {
                cwd: process.cwd(),
                signal: options.signal,
            })) {
                const failure = eventFailure(event);
                if (failure) {
                    sawError = failure;
                    break;
                }
                yield* translator.ingest(event);
            }
            yield* translator.end();
            if (options.signal?.aborted) {
                yield finishChunk('aborted', { message: 'Cursor agent CLI request aborted.', code: 'ABORTED' });
                return;
            }
            if (sawError) {
                yield finishChunk('error', sawError);
                return;
            }
            if (!translator.emittedContent) {
                yield finishChunk('error', {
                    message: 'Cursor agent CLI completed without content.',
                    code: EMPTY_RESPONSE_CODE,
                });
                return;
            }
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
        catch (error) {
            if (options.signal?.aborted || isAbort(error)) {
                yield finishChunk('aborted', { message: 'Cursor agent CLI request aborted.', code: 'ABORTED' });
                return;
            }
            if (error instanceof CursorCliError) {
                yield finishChunk('error', error.failure);
                return;
            }
            const classified = classifyCliFailure(error instanceof Error ? error.message : String(error));
            yield finishChunk('error', classified ?? {
                message: error instanceof Error ? error.message : String(error),
                code: 'UNKNOWN',
            });
        }
    }
}
function eventFailure(event) {
    if (event.type !== 'error' || !event.error)
        return undefined;
    return classifyCliFailure(event.error) ?? { message: event.error, code: 'UNKNOWN' };
}
function finishChunk(kind, failure) {
    return { type: 'finish', reason: { kind, failure } };
}
class StreamChunkTranslator {
    text = '';
    reasoning = '';
    textOpen = false;
    reasoningOpen = false;
    nextIndex = 0;
    textIndex = 0;
    reasoningIndex = 1;
    emittedContent = false;
    *ingest(event) {
        if (event.reasoning)
            yield* this.append('reasoning', event.reasoning);
        if (event.tool)
            yield* this.append('reasoning', event.reasoning ?? `[cursor tool] ${event.tool}`);
        if (event.text && event.type !== 'result')
            yield* this.append('text', event.text);
        if (event.type === 'result' && event.text && this.text === '')
            yield* this.append('text', event.text);
    }
    *end() {
        if (this.reasoningOpen) {
            yield { type: 'block-end', index: this.reasoningIndex, block: { type: 'reasoning', text: this.reasoning } };
            this.reasoningOpen = false;
        }
        if (this.textOpen) {
            yield { type: 'block-end', index: this.textIndex, block: { type: 'text', text: this.text } };
            this.textOpen = false;
        }
    }
    *append(kind, incoming) {
        if (incoming === '')
            return;
        const current = kind === 'text' ? this.text : this.reasoning;
        const delta = incoming.startsWith(current) ? incoming.slice(current.length) : incoming;
        if (delta === '')
            return;
        if (kind === 'text') {
            if (!this.textOpen) {
                this.textIndex = this.nextIndex++;
                this.textOpen = true;
                yield { type: 'block-start', index: this.textIndex, blockType: 'text' };
            }
            this.text += delta;
            this.emittedContent = true;
            yield { type: 'text-delta', index: this.textIndex, text: delta };
            return;
        }
        if (!this.reasoningOpen) {
            this.reasoningIndex = this.nextIndex++;
            this.reasoningOpen = true;
            yield { type: 'block-start', index: this.reasoningIndex, blockType: 'reasoning' };
        }
        this.reasoning += delta;
        this.emittedContent = true;
        yield { type: 'reasoning-delta', index: this.reasoningIndex, text: delta };
    }
}
export function registerCursorAdapter(host, logger) {
    const llm = host.get('llm');
    if (!llm || typeof llm.registerAdapter !== 'function') {
        logger.warn?.('cursor: ctx.llm is missing; model routes not registered');
        return;
    }
    llm.registerAdapter([PROVIDER_ID], new CursorLlmAdapter(logger));
    const directory = {
        provider: PROVIDER_ID,
        displayName: 'Cursor',
        settingsNs: 'dsh-cursor',
        settingsPath: ['cursor'],
        declared: false,
    };
    let handle;
    if (typeof llm.registerConfigurableProviders === 'function') {
        handle = llm.registerConfigurableProviders([directory]);
        void probeCursorCli().then((probe) => {
            if (!probe.error || typeof handle?.replace !== 'function')
                return;
            handle.replace([{ ...directory, error: probe.error }]);
        }).catch((error) => {
            logger.warn?.(`cursor: CLI probe failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    logger.info?.('cursor: LLM adapter registered for provider "cursor"');
}
export function isCursorGenerateOptions(value) {
    return isPlainObject(value) && typeof value.provider === 'string' && typeof value.model === 'string';
}
