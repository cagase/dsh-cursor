# Fixture and verify paths

Workspace: `fixtures/cursor-workspace`.

It contains an always-apply rule, a glob rule (`**/*.ts`), a description-only rule (catalog skill `named`), project skill `fixture-skill`, and `hooks.json` with a plain-shell `preToolUse` deny (`deny.sh`) plus a `bun`/`tsx` example (`deny.ts`).

Open that directory as the workspace root (not this plugin repo root). `findRepoRoot` stops at `.git`; nested under `dsh-cursor` it would otherwise load the parent repo.

## Asset verify (scripted)

From the plugin checkout:

```sh
npm run build
npm run verify:fixture
```

That copies the fixture, adds a local `.git`, mounts `apply()`, and checks:

- catalog load of `fixture-skill` and description rule `named`
- always-apply inject at `agent/session-start`
- glob rule + skill attach on `read` of `src/example.ts`
- `tools/pre-execute` deny from the shell hook

## Model verify (scripted)

```sh
npm run verify:models
npm run verify:models:live
```

`verify:models` does not need login (AUTH / missing-binary paths).

`verify:models:live` requires `agent` on `PATH` and `agent login`. It lists `cursor` catalog rows (the picker reads `listModels`) and runs a read-only `agent --print --mode ask` turn on one listed slug. It does **not** claim that the DSH web picker UI was clicked, or that an AgentTeams member finished a board task.

## Human commands (picker + AgentTeams)

Do these after `dsh plugin --profile web add .` (or `headless`) and a profile restart. Confirm the row with `dsh --profile web --dump-config`.

```sh
agent login
agent models
```

Picker: open a DSH session, open the model picker, select provider **Cursor**, pick a listed slug (for example `cursor-grok-4.6-high`). Send a short prompt. The plugin does not patch picker UI; it only registers `ctx.llm` provider `cursor`.

AgentTeams: copy `examples/teams/cursor-member.yml` into the team profile. Member `provider` must be `cursor`, `model` a listed slug, tools mailbox/task only — no `cursor_agent_*`. Assign that member a small task and confirm it completes on the Cursor route.

If `agent` is missing or `agent status` is unauthenticated, generation fails with `MISSING_CREDENTIAL` or `AUTH` (`Run agent login`). There is no fallback provider.
