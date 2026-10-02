/** DSH tool name → Cursor hook `tool_name` / matcher identity. */
const DSH_TO_CURSOR_TOOL = {
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
};
export function cursorToolName(dshName) {
    return DSH_TO_CURSOR_TOOL[dshName] ?? dshName;
}
export function isFileTouchTool(dshName) {
    return dshName === 'read' || dshName === 'write' || dshName === 'edit';
}
