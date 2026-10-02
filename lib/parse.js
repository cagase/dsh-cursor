import { isPlainObject } from './util.js';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export class FrontmatterError extends Error {
}
export function splitFrontmatter(text) {
    const bomless = text.startsWith('\uFEFF') ? text.slice(1) : text;
    const match = FRONTMATTER_RE.exec(bomless);
    if (!match)
        return { raw: undefined, body: bomless };
    return { raw: match[1] ?? '', body: bomless.slice(match[0].length) };
}
function parseYamlMapping(raw) {
    let value;
    try {
        value = parseSimpleYaml(raw);
    }
    catch (error) {
        throw new FrontmatterError(`invalid YAML frontmatter: ${error.message}`);
    }
    if (!isPlainObject(value))
        throw new FrontmatterError('frontmatter must be a YAML mapping');
    return value;
}
function readString(frontmatter, key) {
    const value = frontmatter[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new FrontmatterError(`frontmatter field ${JSON.stringify(key)} must be a string`);
    return value;
}
function readBoolean(frontmatter, key, fallback) {
    const value = frontmatter[key];
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', 'yes', 'on', '1'].includes(lowered))
            return true;
        if (['false', 'no', 'off', '0'].includes(lowered))
            return false;
    }
    throw new FrontmatterError(`frontmatter field ${JSON.stringify(key)} must be a boolean`);
}
function readStringList(frontmatter, key) {
    const value = frontmatter[key];
    if (value === undefined || value === null)
        return undefined;
    if (Array.isArray(value)) {
        const entries = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
        return entries.length > 0 ? entries : undefined;
    }
    if (typeof value === 'string' && value.trim() !== '')
        return [value.trim()];
    return undefined;
}
export function parseSkillFile(text, fallbackName) {
    const { raw, body } = splitFrontmatter(text);
    if (raw === undefined)
        throw new FrontmatterError('cursor skills require YAML frontmatter with name and description');
    const frontmatter = parseYamlMapping(raw);
    const name = readString(frontmatter, 'name') ?? fallbackName;
    if (name.trim() === '') {
        throw new FrontmatterError('frontmatter is missing the required `name` field');
    }
    const description = readString(frontmatter, 'description');
    if (description === undefined || description.trim() === '') {
        throw new FrontmatterError('frontmatter is missing the required `description` field');
    }
    const metadata = frontmatter.metadata;
    let metadataMap;
    if (metadata !== undefined && metadata !== null) {
        if (!isPlainObject(metadata))
            throw new FrontmatterError('frontmatter field "metadata" must be a string-to-string map');
        const entries = {};
        for (const [key, value] of Object.entries(metadata)) {
            if (typeof value === 'string')
                entries[key] = value;
        }
        metadataMap = Object.freeze(entries);
    }
    return {
        frontmatter: {
            name: name.trim(),
            description,
            disableModelInvocation: readBoolean(frontmatter, 'disable-model-invocation', false),
            userInvocable: readBoolean(frontmatter, 'user-invocable', true),
            paths: readStringList(frontmatter, 'paths'),
            globs: readStringList(frontmatter, 'globs'),
            metadata: metadataMap,
        },
        body,
    };
}
export function parseAgentFile(text, fallbackName) {
    const { raw, body } = splitFrontmatter(text);
    if (raw === undefined)
        throw new FrontmatterError('cursor agent definitions require YAML frontmatter');
    const frontmatter = parseYamlMapping(raw);
    const name = readString(frontmatter, 'name');
    const effectiveName = name && name.trim() !== '' ? name.trim() : fallbackName;
    const description = readString(frontmatter, 'description');
    if (description === undefined || description.trim() === '') {
        throw new FrontmatterError('frontmatter is missing the required `description` field');
    }
    const model = readString(frontmatter, 'model');
    return {
        name: effectiveName,
        description: description.trim(),
        body: body.trim(),
        model: model && model.trim() !== '' ? model.trim() : undefined,
        readonly: readBoolean(frontmatter, 'readonly', false),
        background: readBoolean(frontmatter, 'is_background', false),
    };
}
export function parseRuleFile(text) {
    const { raw, body } = splitFrontmatter(text);
    if (raw === undefined)
        throw new FrontmatterError('cursor rules require YAML frontmatter');
    const frontmatter = parseYamlMapping(raw);
    return {
        name: readString(frontmatter, 'name')?.trim(),
        description: readString(frontmatter, 'description')?.trim(),
        globs: readStringList(frontmatter, 'globs'),
        alwaysApply: readBoolean(frontmatter, 'alwaysApply', false),
        body: body.trim(),
    };
}
/**
 * Minimal YAML mapping parser for Cursor frontmatter (scalars, inline lists, nested string maps).
 * Avoids a hard `yaml` dependency so the plugin stays installable as a stub-plus-assets bundle.
 */
function parseSimpleYaml(raw) {
    const lines = raw.replace(/\t/g, '  ').split(/\r?\n/);
    const root = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '' || line.trim().startsWith('#')) {
            i += 1;
            continue;
        }
        const match = /^(\s*)([^:#\n]+):\s*(.*)$/.exec(line);
        if (!match) {
            i += 1;
            continue;
        }
        const indent = match[1].length;
        if (indent > 0) {
            i += 1;
            continue;
        }
        const key = match[2].trim();
        const rest = match[3].trim();
        if (rest === '' || rest === '|' || rest === '>') {
            const { value, next } = rest === '|' || rest === '>'
                ? readBlock(lines, i + 1, 2)
                : readNested(lines, i + 1);
            root[key] = value;
            i = next;
            continue;
        }
        if (rest.startsWith('[') && rest.endsWith(']')) {
            root[key] = parseInlineList(rest);
            i += 1;
            continue;
        }
        root[key] = parseScalar(rest);
        i += 1;
    }
    return root;
}
function readNested(lines, start) {
    if (start >= lines.length)
        return { value: {}, next: start };
    const first = lines[start];
    if (/^\s+-\s+/.test(first))
        return readList(lines, start, leadingIndent(first));
    if (/^\s+[^#\s]/.test(first))
        return readMap(lines, start, leadingIndent(first));
    return { value: {}, next: start };
}
function readMap(lines, start, indent) {
    const value = {};
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '' || line.trim().startsWith('#')) {
            i += 1;
            continue;
        }
        const current = leadingIndent(line);
        if (current < indent)
            break;
        const match = /^\s*([^:#\n]+):\s*(.*)$/.exec(line);
        if (!match) {
            i += 1;
            continue;
        }
        const key = match[1].trim();
        const rest = match[2].trim();
        if (rest === '') {
            const nested = readNested(lines, i + 1);
            value[key] = nested.value;
            i = nested.next;
        }
        else {
            value[key] = parseScalar(rest);
            i += 1;
        }
    }
    return { value, next: i };
}
function readList(lines, start, indent) {
    const value = [];
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
            i += 1;
            continue;
        }
        const current = leadingIndent(line);
        if (current < indent)
            break;
        const match = /^\s*-\s+(.*)$/.exec(line);
        if (!match)
            break;
        const rest = match[1].trim();
        value.push(parseScalar(rest));
        i += 1;
    }
    return { value, next: i };
}
function readBlock(lines, start, indent) {
    const parts = [];
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
            parts.push('');
            i += 1;
            continue;
        }
        if (leadingIndent(line) < indent)
            break;
        parts.push(line.slice(indent));
        i += 1;
    }
    return { value: parts.join('\n').replace(/\n+$/, ''), next: i };
}
function leadingIndent(line) {
    const match = /^(\s*)/.exec(line);
    return match ? match[1].length : 0;
}
function parseInlineList(text) {
    const inner = text.slice(1, -1).trim();
    if (inner === '')
        return [];
    return inner.split(',').map((part) => parseScalar(part.trim())).filter((part) => typeof part === 'string');
}
function parseScalar(text) {
    if (text === 'true')
        return true;
    if (text === 'false')
        return false;
    if (text === 'null' || text === '~')
        return null;
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1);
    }
    return text;
}
