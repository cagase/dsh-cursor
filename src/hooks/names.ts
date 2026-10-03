/** DSH tool name → Cursor hook `tool_name` / matcher identity. */
const DSH_TO_CURSOR_TOOL: Readonly<Record<string, string>> = {
  bash: 'Shell',
  pwsh: 'Shell',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web: 'WebFetch',
  web_search: 'WebSearch',
  ask_user_question: 'AskUserQuestion',
  exit_plan_mode: 'ExitPlanMode',
  subagent: 'Task',
  todo_write: 'TodoWrite',
}

export function cursorToolName(dshName: string): string {
  return DSH_TO_CURSOR_TOOL[dshName] ?? dshName
}

export function isFileTouchTool(dshName: string): boolean {
  return dshName === 'read' || dshName === 'write' || dshName === 'edit'
}

/** Team coordination tools must stay callable when a Cursor check throws. */
export function isTeamLaneTool(dshName: string): boolean {
  return dshName === 'mailbox' || dshName === 'task'
}
