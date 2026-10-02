# Core-gap log

Seams the plugin cannot close. A stand-in or a won’t-do row is not a closed gap. File-mapping status lives in [behavior-matrix.md](behavior-matrix.md).

## Needs core (harness seam missing)

These stay open until DSH grows a seam. The plugin does not fake them.

| Gap | Why the plugin cannot close it |
|-----|--------------------------------|
| `updated_input` / argument rewrite | `tools/pre-execute` freezes tool arguments. |
| `subagentStart` deny | `agent/session-start` cannot veto spawn. |
| Tab hooks, `workspaceOpen`, `preCompact`, `afterAgentThought` | No DSH event. |
| `afterAgentResponse` response text | Turn-stopping does not expose the assistant text. |
| `sessionStart` env mutation | Hooks cannot write the parent session environment. |
| Cursor Settings UI user rules | Not files; no read API. |
| MCP `auth` OAuth | `dsh-mcp-client` mount has no OAuth handshake here. |
| DSH-native tool-calling through the Cursor CLI | `agent --print` is a full agent turn, not a completion API with DSH tools. |

## Won’t do (documented, not implemented)

Out of scope. Do not treat absence as a future plugin patch.

- Prompt-type hooks (need an LLM inside the hook)
- Marketplace plugins, themes, `.cursorignore`
- Enterprise / team hook tiers
- Cursor `approvalMode`, `permissions.json` allowlists, `sandbox.json` (DSH owns approval and sandbox)
- ACP `cursor_agent_*` tools as the AgentTeams model route

## Stand-in (not a closed gap)

Weaker substitutes. Do not report these as Cursor-parity.

- Description-only rules → catalog skills, not embedding retrieval
- Agent `readonly` / `is_background` → warn only
- `.cursorrules` → one always-apply blob
- AUTH catalog → CLI-help example slugs until `agent models` works
- Model stream → Cursor CLI agent turn; DSH `GenerateOptions.tools` are not forwarded
