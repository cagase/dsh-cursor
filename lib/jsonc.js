/** Strip line and block comments from JSONC, then parse. */
export function parseJsonc(text) {
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];
        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
                out += char;
            }
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            out += char;
            if (char === '\\') {
                out += next ?? '';
                i++;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
        }
        else if (char === '/' && next === '/') {
            inLineComment = true;
            i++;
        }
        else if (char === '/' && next === '*') {
            inBlockComment = true;
            i++;
        }
        else {
            out += char;
        }
    }
    return JSON.parse(stripTrailingCommas(out));
}
/** Drop commas that sit immediately before `}` or `]`, outside strings. */
function stripTrailingCommas(text) {
    let result = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            result += char;
            if (char === '\\') {
                result += text[i + 1] ?? '';
                i++;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }
        if (char === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j]))
                j++;
            const closer = text[j];
            if (closer === '}' || closer === ']')
                continue;
        }
        result += char;
    }
    return result;
}
