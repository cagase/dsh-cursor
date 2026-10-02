import { spawn } from 'node:child_process';
import { capString, errorMessage, isPlainObject } from '../util.js';
export function matcherHits(matcher, value) {
    if (matcher === undefined || matcher.trim() === '')
        return true;
    if (value === undefined)
        return false;
    try {
        return new RegExp(matcher).test(value);
    }
    catch {
        return matcher === value;
    }
}
export async function runEventHooks(spec, logger) {
    const outcomes = [];
    for (const group of spec.groups) {
        if (!matcherHits(group.matcher, spec.matchedValue))
            continue;
        for (const hook of group.hooks) {
            if (!matcherHits(hook.matcher, spec.matchedValue))
                continue;
            outcomes.push(await runCommandHook(hook, spec, logger));
        }
    }
    return outcomes;
}
async function runCommandHook(hook, spec, logger) {
    const timeoutMs = hook.timeout ?? spec.defaultTimeoutMs;
    const cwd = spec.cwd;
    return await new Promise((resolve) => {
        let settled = false;
        const child = spawn(hook.command, {
            cwd,
            env: process.env,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        spec.onSpawn?.(child);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        const finish = (exitCode) => {
            if (settled)
                return;
            settled = true;
            resolve({
                ran: true,
                command: hook.command,
                exitCode,
                stdout,
                stderr,
                output: parseHookJson(stdout),
                failClosed: hook.failClosed === true,
                loopLimit: hook.loop_limit ?? undefined,
            });
        };
        child.on('error', (error) => {
            logger.warn?.(`cursor: hook ${JSON.stringify(hook.command)} failed to spawn: ${errorMessage(error)}`);
            finish(hook.failClosed ? 2 : 1);
        });
        child.on('close', (code) => finish(code));
        const timer = setTimeout(() => {
            logger.warn?.(`cursor: hook timed out after ${timeoutMs}ms: ${hook.command}`);
            try {
                child.kill('SIGKILL');
            }
            catch {
                // already gone
            }
            finish(hook.failClosed ? 2 : 1);
        }, timeoutMs);
        child.on('close', () => clearTimeout(timer));
        spec.signal?.addEventListener('abort', () => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                // already gone
            }
        });
        try {
            child.stdin?.end(JSON.stringify(spec.input));
        }
        catch {
            child.stdin?.end();
        }
    });
}
export function parseHookJson(stdout) {
    const trimmed = stdout.trim();
    if (trimmed === '')
        return undefined;
    try {
        const value = JSON.parse(trimmed);
        return isPlainObject(value) ? value : undefined;
    }
    catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start < 0 || end <= start)
            return undefined;
        try {
            const value = JSON.parse(trimmed.slice(start, end + 1));
            return isPlainObject(value) ? value : undefined;
        }
        catch {
            return undefined;
        }
    }
}
export function firstNonEmpty(...values) {
    for (const value of values) {
        if (value !== undefined && value.trim() !== '')
            return value;
    }
    return '';
}
export function collectAdditionalContext(outcomes, maxChars) {
    const contexts = [];
    for (const outcome of outcomes) {
        if (!outcome.ran)
            continue;
        const extra = outcome.output?.additional_context;
        if (typeof extra === 'string' && extra.trim() !== '')
            contexts.push(capString(extra, maxChars));
    }
    return contexts;
}
