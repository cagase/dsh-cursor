import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href)
const declarations = await readFile(join(process.cwd(), 'lib/index.d.ts'), 'utf8')

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

assert(!declarations.includes('@deepseek-ai/cordis'), 'published types still import the optional Cordis peer')
assert(typeof lib.apply === 'function', 'apply')
assert(lib.PROVIDER_ID === 'cursor', 'PROVIDER_ID')
assert(lib.matchGlob === undefined, 'matchGlob is still a package export')
assert(lib.wireCursorModel === undefined, 'wireCursorModel is still a package export')
assert(lib.classifyRule === undefined, 'classifyRule is still a package export')

console.log('checks/public-types: ok')
