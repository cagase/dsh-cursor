import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const dir = join(process.cwd(), 'scripts', 'checks')
let names = []
try {
  names = (await readdir(dir)).filter((name) => name.endsWith('.mjs')).sort()
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

if (names.length === 0) {
  console.log('run-checks: no scripts/checks')
  process.exit(0)
}

for (const name of names) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, name)], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (status) => resolve(status ?? 1))
  })
  if (code !== 0) {
    throw new Error(`scripts/checks/${name} exited ${code}`)
  }
}

console.log('run-checks: ok')
