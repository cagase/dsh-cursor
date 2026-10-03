import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const util = await import(pathToFileURL(join(process.cwd(), 'lib/util.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const absolute = '/repo/src/nested/foo.ts'
assert(util.matchGlob('src/**/*.ts', absolute), 'folder glob missed an absolute path')
assert(util.matchGlob('src/**/*.ts', '/repo/src/foo.ts'), 'folder glob missed a shallow absolute path')
assert(!util.matchGlob('src/**/*.ts', '/repo/lib/foo.ts'), 'folder glob matched outside src')
assert(util.matchGlob('*.ts', absolute), 'basename glob missed an absolute path')
assert(util.matchGlob('**/*.ts', absolute), 'double-star glob missed an absolute path')
assert(!util.matchGlob('src/**/*.js', absolute), 'extension glob matched the wrong suffix')

console.log('checks/glob: ok')
