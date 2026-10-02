# Behavior matrix

Status values: **supported** (plugin does this), **stand-in** (weaker substitute; not the Cursor behavior), **won’t do** (out of scope; not faked), **needs core** (blocked on a DSH seam; not faked).

## (a) Cursor files → DSH behavior

User root: `$CURSOR_CONFIG_DIR` or `~/.cursor`. Project root: `<workspace>/.cursor`.

| Cursor surface | DSH behavior | Status |
|----------------|--------------|--------|
| `{user,project}/skills/**/SKILL.md` | Provider `cursor` catalog; `/name` and `skill` tool | supported |
| Skill `paths` / legacy `globs` | Attach on `read` / `write` / `edit` via `tools/result` | supported |
| `{user,project}/agents/*.md` | Delegation-spec catalog skills | supported |
| Agent `readonly` / `is_background` | Warn; register without a tool filter or async child | stand-in |
| `{user}/skills-cursor/**` | Off unless `skillsCursor: true` | supported |
| `alwaysApply: true` rules | Inject at `agent/session-start` | supported |
| Glob rules | Attach on file-touch (`read` / `write` / `edit`) | supported |
| Description-only rules | Catalog skills; no embedding retrieval | stand-in |
| Manual rules | Catalog skills | supported |
| `.cursorrules` | One always-apply blob | stand-in |
| Nested `AGENTS.md` (repo root exclusive → cwd) | Always-apply memory | supported |
| Settings UI user rules | Not files; no seam | needs core |
| `hooks.json` command hooks (shell / bun / tsx / python / shebang) | Session, turn, tool, file, shell, MCP seams; tool hooks on main + subagent; session vs subagent split | supported |
| Prompt-type hooks | Need an LLM inside the hook | won’t do |
| `preToolUse` `permission: deny` / exit 2 | `tools/pre-execute` deny | supported |
| `updated_input` rewrite | `tools/pre-execute` freezes args | needs core |
| `subagentStart` deny | `agent/session-start` cannot gate spawn | needs core |
| `sessionStart` env mutation | No env write-back | needs core |
| Tab, `workspaceOpen`, `preCompact`, `afterAgentThought` | No DSH seam | needs core |
| `afterAgentResponse` response text | Turn-stopping does not expose it | needs core |
| Live reload of skill / rule / hook / cli / mcp files | Watch + catalog invalidate | supported |
| `{project}/cli.json`, `{user}/cli-config.json` deny | Deny wins at `tools/pre-execute`; allow does not skip DSH approval | supported |
| Cursor `approvalMode` / `permissions.json` allowlists / `sandbox.json` | DSH owns approval and sandbox | won’t do |
| `{user,project}/mcp.json` stdio / HTTP | `@deepseek-ai/dsh-mcp-client` as `mcp__cursor__<server>__*` | supported |
| MCP `auth` OAuth | Not implemented | needs core |
| Marketplace plugins, themes, `.cursorignore` | Out of scope | won’t do |
| Enterprise / team hook tiers | Out of scope | won’t do |

## (b) Cursor CLI models → picker + AgentTeams

| Cursor / CLI surface | DSH behavior | Status |
|----------------------|--------------|--------|
| `ctx.llm.registerAdapter(['cursor'], …)` | Picker and `session.selectModel` read `listProviders` / `listModels`; no UI patch | supported |
| `agent` on `PATH` / `CURSOR_AGENT_BIN` | Missing binary → `MISSING_CREDENTIAL` | supported |
| `agent login` / `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | Not logged in → `AUTH` (`Run agent login`) | supported |
| Silent fallback to another provider | Never | supported (refused) |
| `agent models` slugs after login | Catalog ids as listed, including `*-fast` and `*-xhigh` | supported |
| Fast / Extra High when list is AUTH | CLI-help example slugs plus synthetic `-fast` / `-xhigh`; labeled unconfirmed; `stream()` still AUTH | stand-in |
| `reasoningEffort: xhigh` | CLI `[effort=max]` | supported |
| `reasoningEffort: low` / `high` | CLI `[effort=…]` on the base slug | supported |
| AgentTeams `provider: cursor` + CLI slug | Same route ids as the picker; mailbox/task tools stay on the member | supported |
| AgentTeams via `cursor_agent_*` ACP tools | Not the route; example profile omits them | won’t do |
| `agent --print --output-format stream-json` | Full Cursor agent turn (`--force --trust`); DSH `tools` not forwarded | stand-in |
| DSH-native tool-calling through the CLI | CLI has no completion-only tools channel | needs core |
| Configurable-provider directory row | `displayName: Cursor`; probe error after AUTH / missing binary | supported |
