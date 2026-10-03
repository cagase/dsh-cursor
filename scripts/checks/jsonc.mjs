import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const jsonc = await import(pathToFileURL(join(process.cwd(), 'lib/jsonc.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const parsed = jsonc.parseJsonc(`{
  // comment
  "a": 1,
  "b": [2, 3,],
  "keep": "1, }",
}`)
assert(parsed.a === 1 && parsed.b[1] === 3, `trailing commas did not parse: ${JSON.stringify(parsed)}`)
assert(parsed.keep === '1, }', 'comma inside a string was stripped')

console.log('checks/jsonc: ok')
