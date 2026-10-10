import type { ChildProcess } from 'node:child_process'
import type { HostContext } from '../types.js'
import { cursorToolName, isTeamLaneTool } from './names.js'
import {
  collectAdditionalContext,
  firstNonEmpty,
  runEventHooks,
  type HookOutcome,
  type HookRunSpec,
} from './run.js'
import type { AgentLike, PluginLogger, PostToolDecision, PreToolDecision, ToolExecutionLike } from '../types.js'
import { capString, errorMessage, pluginUserMessage, reminder, toolCommand, toolFilePath } from '../util.js'
import type { CursorSettingsLoader } from '../settings.js'

const DEFAULT_LOOP_LIMIT = 5
const SESSION_END_BUDGET_MS = 1500

export interface HookBridgeConfig {
  hookTimeoutMs: number
  maxHookOutputChars: number
}

export function isSubagent(agent: AgentLike): boolean {
  return agent.session.header.delegationDepth !== undefined
}

export function registerHooks(
  ctx: HostContext,
  logger: PluginLogger,
  loader: CursorSettingsLoader,
  config: HookBridgeConfig,
  permissionPre?: (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
): void {
  const children = new Set<ChildProcess>()
  const onSpawn = (child: ChildProcess) => {
    children.add(child)
    child.once('close', () => children.delete(child))
  }
  ctx.effect(
    () => () => {
      for (const child of children) {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
      children.clear()
    },
    'cursor hook children',
  )

  const followups = new Map<string, Map<string, number>>()
  ctx.on('agent/session-start', () => {
    followups.clear()
  })

  ctx.on('agent/session-start', (payload: { source?: string; agent: AgentLike }) => {
    if (payload.source === 'resume') return
    const agent = payload.agent
    if (isSubagent(agent)) {
      void runNamed(agent, loader, logger, config, onSpawn, 'subagentStart', { is_background_agent: false }).then(
        (outcomes) => {
          for (const outcome of outcomes) {
            if (!outcome.ran) continue
            if (outcome.exitCode === 2 || outcome.output?.permission === 'deny') {
              logger.warn?.(
                'cursor: subagentStart hook denied subagent creation; DSH has no deny seam at session-start — ignoring (needs-core)',
              )
            }
          }
          injectContexts(agent, 'subagentStart', outcomes, config)
        },
      )
      return
    }
    void runNamed(agent, loader, logger, config, onSpawn, 'sessionStart', { is_background_agent: false }).then(
      (outcomes) => injectContexts(agent, 'sessionStart', outcomes, config),
    )
  })

  ctx.on('agent/disposed', (payload: { agent: AgentLike }) => {
    if (isSubagent(payload.agent)) return
    void runNamed(payload.agent, loader, logger, config, onSpawn, 'sessionEnd', {}, AbortSignal.timeout(SESSION_END_BUDGET_MS))
  })

  ctx.on(
    'agent/pre-step',
    async (
      payload: { agent: AgentLike; messages: Array<{ content: Array<{ type: string; text?: string }> }> },
      next: () => Promise<{ kind: 'enter'; messages: unknown[] } | { kind: 'reject' }>,
    ) => {
      if (isSubagent(payload.agent)) return next()
      const groups = (await loader.load(payload.agent.session.header.cwd)).byEvent.get('beforeSubmitPrompt')
      if (!groups || groups.length === 0) return next()
      const prompt = payload.messages
        .map((message) => message.content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join(''))
        .join('\n')
      const outcomes = await runEventHooks(
        spec(payload.agent, 'beforeSubmitPrompt', groups, undefined, { prompt }, config, onSpawn),
        logger,
      )
      for (const outcome of outcomes) {
        if (!outcome.ran) continue
        if (outcome.exitCode === 2 || outcome.output?.continue === false) {
          const reason = firstNonEmpty(
            outcome.output?.user_message,
            capString(outcome.stderr, config.maxHookOutputChars),
            'blocked by a Cursor hook',
          )
          logger.warn?.(`cursor: beforeSubmitPrompt blocked the step: ${reason}`)
          return { kind: 'reject' }
        }
      }
      return next()
    },
  )

  ctx.on('tools/pre-execute', async (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => {
    const agent = exec.agent
    if (!agent) return permissionPre ? permissionPre(exec, next) : next()
    try {
      const outcomes = await collectToolOutcomes(loader, agent, exec, 'pre', logger, config, onSpawn)
      const resolved = resolvePreTool(outcomes, logger, config.maxHookOutputChars)
      if (resolved.contexts.length > 0) {
        agent.inject(reminder(`dsh-cursor:hooks/preToolUse`, resolved.contexts.join('\n\n')))
      }
      if (resolved.decision?.kind === 'deny') {
        return { kind: 'deny', reason: resolved.decision.reason }
      }
      return permissionPre ? permissionPre(exec, next) : next()
    } catch (error) {
      const reason = `cursor preToolUse hooks failed: ${errorMessage(error)}`
      logger.warn?.(reason)
      if (isTeamLaneTool(exec.name)) return next()
      return { kind: 'deny', reason }
    }
  })

  ctx.on(
    'tools/post-execute',
    async (exec: ToolExecutionLike, result: { isError?: boolean }, next: () => Promise<PostToolDecision>) => {
      const agent = exec.agent
      if (!agent) return next()
      try {
        const generic = result.isError ? 'postToolUseFailure' : 'postToolUse'
        const outcomes = await collectToolOutcomes(loader, agent, exec, 'post', logger, config, onSpawn, generic)
        const contexts = collectAdditionalContext(outcomes, config.maxHookOutputChars)
        const accepted = await next()
        if (contexts.length === 0) return accepted
        const extra = [reminder(`dsh-cursor:hooks/${generic}`, contexts.join('\n\n'))]
        if (accepted.kind === 'accept') {
          return { ...accepted, additionalContexts: [...(accepted.additionalContexts ?? []), ...extra] }
        }
        return accepted
      } catch (error) {
        logger.warn?.(`cursor: postToolUse hooks failed: ${errorMessage(error)}`)
        return next()
      }
    },
  )

  ctx.on('agent/turn-stopping', (payload: { agent: AgentLike }) => {
    const agent = payload.agent
    const event = isSubagent(agent) ? 'subagentStop' : 'stop'
    void runNamed(agent, loader, logger, config, onSpawn, event).then((outcomes) => {
      injectContexts(agent, isSubagent(agent) ? 'subagentStop' : 'afterAgentResponse', outcomes, config)
      const followup = resolveFollowup(outcomes, config.maxHookOutputChars)
      if (followup !== undefined && allowFollowup(followups, agent, outcomes) && agent.steer) {
        agent.steer(pluginUserMessage(`dsh-cursor:hooks/${event}`, followup))
      }
    })
    if (!isSubagent(agent)) {
      void runNamed(agent, loader, logger, config, onSpawn, 'afterAgentResponse').then((outcomes) => {
        injectContexts(agent, 'afterAgentResponse', outcomes, config)
      })
    }
  })
}

function spec(
  agent: AgentLike,
  event: string,
  groups: readonly import('../types.js').MatcherGroup[],
  matchedValue: string | undefined,
  extra: Record<string, unknown>,
  config: HookBridgeConfig,
  onSpawn: (child: ChildProcess) => void,
  signal?: AbortSignal,
): HookRunSpec {
  return {
    event,
    groups,
    matchedValue,
    input: {
      session_id: String(agent.session.id ?? ''),
      cwd: agent.session.header.cwd ?? process.cwd(),
      ...extra,
    },
    cwd: agent.session.header.cwd ?? process.cwd(),
    defaultTimeoutMs: config.hookTimeoutMs,
    signal,
    onSpawn,
  }
}

async function runNamed(
  agent: AgentLike,
  loader: CursorSettingsLoader,
  logger: PluginLogger,
  config: HookBridgeConfig,
  onSpawn: (child: ChildProcess) => void,
  event: string,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<HookOutcome[]> {
  const groups = (await loader.load(agent.session.header.cwd)).byEvent.get(event)
  if (!groups || groups.length === 0) return []
  try {
    return await runEventHooks(spec(agent, event, groups, undefined, extra, config, onSpawn, signal), logger)
  } catch (error) {
    logger.warn?.(`cursor: ${event} hooks failed: ${errorMessage(error)}`)
    return []
  }
}

function injectContexts(agent: AgentLike, event: string, outcomes: readonly HookOutcome[], config: HookBridgeConfig): void {
  const contexts = collectAdditionalContext(outcomes, config.maxHookOutputChars)
  if (contexts.length > 0) agent.inject(reminder(`dsh-cursor:hooks/${event}`, contexts.join('\n\n')))
}

async function collectToolOutcomes(
  loader: CursorSettingsLoader,
  agent: AgentLike,
  exec: ToolExecutionLike,
  phase: 'pre' | 'post',
  logger: PluginLogger,
  config: HookBridgeConfig,
  onSpawn: (child: ChildProcess) => void,
  genericEvent: 'preToolUse' | 'postToolUse' | 'postToolUseFailure' = phase === 'pre' ? 'preToolUse' : 'postToolUse',
): Promise<HookOutcome[]> {
  const cwd = agent.session.header.cwd ?? process.cwd()
  const settings = await loader.load(cwd)
  const cursorName = cursorToolName(exec.name)
  const outcomes: HookOutcome[] = []
  const genericGroups = settings.byEvent.get(genericEvent)
  if (genericGroups && genericGroups.length > 0) {
    outcomes.push(
      ...(await runEventHooks(
        spec(
          agent,
          genericEvent,
          genericGroups,
          cursorName,
          {
            tool_name: cursorName,
            tool_input: exec.arguments ?? {},
            tool_use_id: String(exec.callId ?? ''),
          },
          config,
          onSpawn,
        ),
        logger,
      )),
    )
  }
  const kinds: { events: [string, string]; tools: string[]; match: string | undefined }[] = [
    { events: ['beforeShellExecution', 'afterShellExecution'], tools: ['bash', 'pwsh'], match: toolCommand(exec.arguments) },
    { events: ['beforeReadFile', ''], tools: ['read'], match: toolFilePath(exec.arguments) },
    { events: ['', 'afterFileEdit'], tools: ['edit', 'write'], match: toolFilePath(exec.arguments) },
    {
      events: ['beforeMCPExecution', 'afterMCPExecution'],
      tools: exec.name.startsWith('mcp') ? [exec.name] : [],
      match: cursorName,
    },
  ]
  for (const kind of kinds) {
    const applies = kind.tools.length === 0 ? false : kind.tools.includes(exec.name) || (exec.name.startsWith('mcp') && kind.events[0].includes('MCP'))
    if (!applies && !(exec.name.startsWith('mcp') && kind.events[0] === 'beforeMCPExecution')) continue
    if (kind.events[0].includes('MCP') && !exec.name.startsWith('mcp')) continue
    if (!kind.events[0].includes('MCP') && !kind.tools.includes(exec.name)) continue
    const event = phase === 'pre' ? kind.events[0] : kind.events[1]
    if (event === '') continue
    const groups = settings.byEvent.get(event)
    if (!groups || groups.length === 0) continue
    outcomes.push(
      ...(await runEventHooks(
        spec(
          agent,
          event,
          groups,
          kind.match,
          {
            tool_name: cursorName,
            tool_input: exec.arguments ?? {},
            tool_use_id: String(exec.callId ?? ''),
          },
          config,
          onSpawn,
        ),
        logger,
      )),
    )
  }
  return outcomes
}

function resolvePreTool(
  outcomes: readonly HookOutcome[],
  logger: PluginLogger,
  maxChars: number,
): { decision?: { kind: 'deny'; reason: string }; contexts: string[] } {
  const contexts = collectAdditionalContext(outcomes, maxChars)
  for (const outcome of outcomes) {
    if (!outcome.ran) continue
    if (outcome.output?.updated_input !== undefined) {
      logger.warn?.('cursor: preToolUse updated_input rewriting is not supported (DSH freezes tool arguments); ignored')
    }
    if (outcome.exitCode === 2 || outcome.output?.permission === 'deny') {
      return {
        decision: {
          kind: 'deny',
          reason: firstNonEmpty(outcome.output?.agent_message, capString(outcome.stderr, maxChars), 'blocked by a Cursor hook'),
        },
        contexts,
      }
    }
    if (outcome.failClosed && outcome.exitCode !== 0) {
      return {
        decision: { kind: 'deny', reason: firstNonEmpty(capString(outcome.stderr, maxChars), 'Cursor hook failClosed') },
        contexts,
      }
    }
  }
  return { contexts }
}

function resolveFollowup(outcomes: readonly HookOutcome[], maxChars: number): string | undefined {
  for (const outcome of outcomes) {
    if (typeof outcome.output?.followup_message === 'string' && outcome.output.followup_message.trim() !== '') {
      return capString(outcome.output.followup_message, maxChars)
    }
  }
  return undefined
}

function allowFollowup(
  followups: Map<string, Map<string, number>>,
  agent: AgentLike,
  outcomes: readonly HookOutcome[],
): boolean {
  const id = String(agent.session.id ?? 'unknown')
  let perAgent = followups.get(id)
  if (!perAgent) {
    perAgent = new Map()
    followups.set(id, perAgent)
  }
  for (const outcome of outcomes) {
    if (typeof outcome.output?.followup_message !== 'string') continue
    const limit = outcome.loopLimit ?? DEFAULT_LOOP_LIMIT
    const count = (perAgent.get(outcome.command) ?? 0) + 1
    perAgent.set(outcome.command, count)
    if (count > limit) return false
    return true
  }
  return false
}
