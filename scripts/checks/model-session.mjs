import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const cli = await import(pathToFileURL(join(process.cwd(), 'lib/models/cli.js')).href)
const adapterMod = await import(pathToFileURL(join(process.cwd(), 'lib/models/adapter.js')).href)

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const saved = {
  bin: process.env.CURSOR_AGENT_BIN,
  key: process.env.CURSOR_API_KEY,
  token: process.env.CURSOR_AUTH_TOKEN,
}
const root = await mkdtemp(join(tmpdir(), 'dsh-cursor-session-'))
try {
  const log = join(root, 'argv.txt')
  const program = join(root, 'agent.mjs')
  const agent = join(root, 'agent.sh')
  await writeFile(
    program,
    `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args[0] === 'status') {
  process.stdout.write('{"isAuthenticated":true}')
  process.exit(0)
}
const mode = process.env.FAKE_MODE
if (args.includes('--new-session-id') && mode === 'busy') {
  process.stderr.write('Error: Session ID "x" is already in use.\\n')
  process.exit(1)
}
if (args.includes('--resume') && mode === 'auth') {
  process.stderr.write('Error: Not logged in. Run agent login.\\n')
  process.exit(1)
}
if (args.includes('--resume') && mode === 'missing') {
  process.stderr.write('Error: No session found with ID "x".\\n')
  process.exit(1)
}
process.exit(0)
`,
  )
  await writeFile(agent, `#!/bin/sh\nexec node ${JSON.stringify(program)} "$@"\n`)
  await chmod(agent, 0o755)
  process.env.CURSOR_AGENT_BIN = agent
  delete process.env.CURSOR_API_KEY
  delete process.env.CURSOR_AUTH_TOKEN

  const id = '11111111-1111-4111-8111-111111111111'
  process.env.FAKE_MODE = 'busy'
  const holder = {
    plan: {
      positional: '<dsh_system_prompt>\nsecret\n</dsh_system_prompt>\n\n<dsh_user_message>\nlatest\n</dsh_user_message>',
      resumePositional: 'latest',
      session: { mode: 'new', id },
      bootstrap: true,
      deliveredTurns: 2,
      commit() {},
    },
  }
  const workspace = join(root, 'work')
  await (await import('node:fs/promises')).mkdir(workspace)
  for await (const _event of cli.streamAgentTurn(agent, 'gpt-5', holder, { cwd: workspace })) {
    // drain
  }
  assert(holder.plan.session.mode === 'resume', `collision left mode ${holder.plan.session.mode}`)
  assert(holder.plan.positional === 'latest', `collision resent the bootstrap: ${holder.plan.positional}`)
  const busyLines = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const resumeArgs = busyLines.find((args) => args.includes('--resume'))
  assert(resumeArgs?.at(-1) === 'latest', `resume positional: ${JSON.stringify(resumeArgs)}`)
  assert(resumeArgs.includes('--workspace') && resumeArgs.includes(workspace), 'resume dropped the workspace')

  process.env.FAKE_MODE = 'auth'
  let reanchored = false
  const authHolder = {
    plan: {
      positional: 'latest',
      session: { mode: 'resume', id },
      bootstrap: false,
      deliveredTurns: 1,
      commit() {},
      reanchor: () => {
        reanchored = true
        return { ...authHolder.plan, session: { mode: 'new', id: 'fresh' }, positional: 'FULL' }
      },
    },
  }
  const authEvents = []
  for await (const event of cli.streamAgentTurn(agent, 'gpt-5', authHolder)) authEvents.push(event)
  assert(reanchored === false, 'an auth failure rotated the CLI chat')
  assert(authEvents.some((event) => event.type === 'error'), 'an auth failure was swallowed')

  process.env.FAKE_MODE = 'missing'
  let missingReanchor = false
  const missingHolder = {
    plan: {
      positional: 'latest',
      session: { mode: 'resume', id },
      bootstrap: false,
      deliveredTurns: 1,
      commit() {},
      reanchor: () => {
        missingReanchor = true
        return {
          positional: 'FULL CONTEXT',
          session: { mode: 'new', id: '22222222-2222-4222-8222-222222222222' },
          bootstrap: true,
          deliveredTurns: 1,
          commit() {},
        }
      },
    },
  }
  for await (const _event of cli.streamAgentTurn(agent, 'gpt-5', missingHolder)) {
    // drain
  }
  assert(missingReanchor === true, 'a missing chat did not re-anchor')
  assert(missingHolder.plan.positional === 'FULL CONTEXT', 're-anchor did not replace the plan')

  const workspaceLog = join(root, 'workspace.txt')
  await writeFile(program, `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(workspaceLog)}, JSON.stringify(args) + '\\n')
if (args[0] === 'status') {
  process.stdout.write('{"isAuthenticated":true}')
}
process.exit(0)
`)
  const instance = new adapterMod.CursorLlmAdapter()
  for await (const _chunk of instance.stream({
    provider: 'cursor',
    model: 'gpt-5',
    cwd: workspace,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    // drain
  }
  const workspaceArgs = (await readFile(workspaceLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const turn = workspaceArgs.find((args) => args.includes('--workspace'))
  assert(turn?.includes(workspace), `workspace was not the caller cwd: ${JSON.stringify(turn)}`)
} finally {
  restore('CURSOR_AGENT_BIN', saved.bin)
  restore('CURSOR_API_KEY', saved.key)
  restore('CURSOR_AUTH_TOKEN', saved.token)
  delete process.env.FAKE_MODE
  await rm(root, { recursive: true, force: true })
}

function restore(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

console.log('checks/model-session: ok')
