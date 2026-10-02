# @cagase/dsh-cursor

DeepSeek Harness plugin so a Cursor workspace can run in DSH without copying skills/rules/hooks into `.dsh/` or patching the model picker.

This checkout is a **stub**: the package installs and mounts a HOST-plane row. Cursor asset mapping and `agent` CLI model routes are not implemented yet.

## Install

Requires DeepSeek Harness 0.1.5-rc.1 or newer. Add the bundle to each profile you use, then restart that profile:

```sh
dsh plugin --profile web add @cagase/dsh-cursor
dsh plugin --profile headless add @cagase/dsh-cursor
```

From a git checkout (before the package is on npm):

```sh
dsh plugin --profile web add .
```

Confirm the row is in the composed tree:

```sh
dsh --profile web --dump-config
# look for id: dsh-cursor  name: @cagase/dsh-cursor
```

## Config

Override from a later patch layer:

```yaml
- id: dsh-cursor
  config:
    assets: true          # skills, rules, hooks, permissions, MCP (not implemented)
    models: true          # picker + AgentTeams `cursor` routes (not implemented)
    skillsCursor: false   # ~/.cursor/skills-cursor (default off)
    watch: true
```

## Prerequisites (once model routes ship)

- Cursor `agent` CLI on `PATH`
- `agent login`

Missing binary or login must fail visibly. The plugin will not fall back to another provider.

## AgentTeams

When model routes ship, set member `provider: cursor` and a CLI model slug. See `examples/teams/cursor-member.yml`. Do not route team work through `cursor_agent_*` ACP tools.

## License

MIT
