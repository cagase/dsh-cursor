/**
 * One-to-one turn planning for the Cursor `agent` CLI shim.
 *
 * The capture (`docs/live-cli-contract.md` §4–§6) proves that neither
 * `--system-prompt` (rejected server-side) nor `--conversation-history-file`
 * (parsed, then inert) can carry DSH context for this account. The only channel
 * that demonstrably carries prior turns is the CLI's own local session store:
 * mint one `--new-session-id <uuid>` per DSH session, then `--resume <uuid>`.
 *
 * So a DSH session gets one CLI chat. The first turn (and any later re-anchor
 * after DSH rewrites the history or changes the system prompt) delivers the
 * context once, in the positional prompt. Every steady-state turn sends only
 * what the CLI has not seen yet — normally exactly the newest user turn,
 * byte-identical — so the CLI transcript is one-to-one and nothing has to be
 * filtered out of the DSH chat afterwards.
 */
import { createHash, randomUUID } from 'node:crypto';
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
export function sessionUuidFor(seed) {
    const hex = createHash('sha1').update(`dsh-cursor:${seed}`).digest('hex').slice(0, 32);
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        `4${hex.slice(13, 16)}`,
        `${variant}${hex.slice(17, 20)}`,
        hex.slice(20, 32),
    ].join('-');
}
/** True for the RFC 4122 v4 shape the CLI's `--new-session-id` validator wants. */
export function isSessionUuidV4(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}
export function fingerprint(text) {
    return createHash('sha1').update(text).digest('hex');
}
/** Split a request into the system prompt text and its ordered turns. */
export function collectTurns(options) {
    const systems = [];
    if (options.system?.trim())
        systems.push(options.system.trim());
    const turns = [];
    for (const message of options.messages) {
        const text = renderContent(message.content);
        if (message.role === 'system') {
            if (text.trim() !== '')
                systems.push(text.trim());
            continue;
        }
        if (text === '')
            continue;
        turns.push(message.id ? { id: message.id, role: message.role, text } : { role: message.role, text });
    }
    return { systemText: systems.join('\n\n'), turns };
}
function renderContent(content) {
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
        else if (block.type === 'tool-call')
            parts.push(`[tool-call ${block.name ?? 'tool'}] ${block.arguments ?? ''}`);
        else if (block.type === 'tool-result') {
            parts.push(`[tool-result ${block.toolCallId ?? ''}]\n${renderContent(block.content ?? [])}`);
        }
    }
    return parts.join('\n');
}
/**
 * Bootstrap payload: the DSH system prompt and prior turns delivered once,
 * because the CLI session store starts empty. A single bare user turn stays
 * byte-identical (no wrapper), so a first one-shot call is already one-to-one.
 */
export function renderAgentContext(systemText, turns) {
    if (systemText === '' && turns.length === 1 && turns[0].role === 'user')
        return turns[0].text;
    const history = turns.slice();
    const current = history.length > 0 && history[history.length - 1].role === 'user' ? history.pop() : undefined;
    const parts = [];
    if (systemText !== '')
        parts.push(`<dsh_system_prompt>\n${systemText}\n</dsh_system_prompt>`);
    if (history.length > 0) {
        parts.push(`<dsh_conversation_history>\n${history.map(renderTurn).join('\n\n')}\n</dsh_conversation_history>`);
    }
    if (current)
        parts.push(`<dsh_user_message>\n${current.text}\n</dsh_user_message>`);
    return parts.join('\n\n') || '(empty request)';
}
/**
 * Steady-state payload: only what the CLI session has not seen. One new user
 * turn travels byte-identical; a DSH retry with nothing new re-sends the last
 * user turn.
 */
export function renderResumePayload(fresh, allTurns) {
    const newUserTurns = fresh.filter((turn) => turn.role === 'user' && turn.text !== '');
    if (newUserTurns.length === 1)
        return newUserTurns[0].text;
    if (newUserTurns.length > 1)
        return newUserTurns.map((turn) => turn.text).join('\n\n');
    const lastUserTurn = [...allTurns].reverse().find((turn) => turn.role === 'user' && turn.text !== '');
    return lastUserTurn ? lastUserTurn.text : '';
}
function renderTurn(turn) {
    return `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.text}`;
}
function prefixMatches(state, turns) {
    if (turns.length < state.deliveredTurns)
        return false;
    for (let index = 0; index < state.deliveredTurns; index++) {
        const previousId = state.turnIds[index];
        const turn = turns[index];
        if (!turn)
            return false;
        if (previousId !== undefined && turn.id !== undefined) {
            if (previousId !== turn.id)
                return false;
            continue;
        }
        if (state.turnHashes[index] !== fingerprint(turn.text))
            return false;
    }
    return true;
}
/**
 * Per-DSH-session delivery checkpoints. One CLI chat per DSH session, re-anchored
 * (new session id, context delivered once more) when DSH rewrites the prefix or
 * changes the system prompt.
 */
export class CursorSessionRegistry {
    checkpoints = new Map();
    generations = new Map();
    size() {
        return this.checkpoints.size;
    }
    clear() {
        this.checkpoints.clear();
        this.generations.clear();
    }
    plan(options) {
        const { systemText, turns } = collectTurns(options);
        const key = options.sessionId?.trim() ?? '';
        const purpose = options.purpose?.trim() ?? '';
        const systemHash = fingerprint(systemText);
        if (key === '' || purpose !== '') {
            return {
                positional: renderAgentContext(systemText, turns),
                session: { mode: 'none' },
                bootstrap: true,
                deliveredTurns: 0,
                commit() { },
            };
        }
        const state = this.checkpoints.get(key);
        if (state && state.systemHash === systemHash && prefixMatches(state, turns)) {
            return {
                positional: renderResumePayload(turns.slice(state.deliveredTurns), turns),
                session: { mode: 'resume', id: state.cliSessionId },
                bootstrap: false,
                deliveredTurns: turns.length,
                commit: () => {
                    this.commit(key, state.cliSessionId, systemHash, turns);
                },
                reanchor: () => {
                    this.checkpoints.delete(key);
                    return this.bootstrapPlan(key, systemText, systemHash, turns, this.nextAnchorId(key));
                },
            };
        }
        return this.bootstrapPlan(key, systemText, systemHash, turns, this.nextAnchorId(key));
    }
    /** A fresh CLI session: full context in the positional prompt, one new id. */
    bootstrapPlan(key, systemText, systemHash, turns, id) {
        return {
            positional: renderAgentContext(systemText, turns),
            resumePositional: renderResumePayload(turns.length > 0 ? [turns[turns.length - 1]] : [], turns),
            session: { mode: 'new', id },
            bootstrap: true,
            deliveredTurns: turns.length,
            commit: () => {
                this.commit(key, id, systemHash, turns);
            },
            reanchor: () => this.bootstrapPlan(key, systemText, systemHash, turns, this.nextAnchorId(key)),
            reanchorFresh: () => this.bootstrapPlan(key, systemText, systemHash, turns, randomUUID()),
        };
    }
    /** Drop one session's checkpoint so the next call re-anchors. */
    forget(sessionId) {
        this.checkpoints.delete(sessionId);
    }
    nextAnchorId(key) {
        const generation = this.generations.get(key) ?? 0;
        this.generations.set(key, generation + 1);
        return sessionUuidFor(`${key}#${generation}`);
    }
    commit(key, cliSessionId, systemHash, turns) {
        this.checkpoints.set(key, {
            cliSessionId,
            systemHash,
            deliveredTurns: turns.length,
            turnIds: turns.map((turn) => turn.id),
            turnHashes: turns.map((turn) => fingerprint(turn.text)),
        });
    }
}
