# Live Cursor agent CLI contract

Ground-truth contract captured by task **t1 (cli-spiker)** against the **live** Cursor agent CLI and
the **live** account. Everything below is backed by a raw capture in `fixtures/live/`; nothing here is
inferred from the plugin source or from the fallback slug list in `src/models/cli.ts`.

* Captured: **2026-10-03T02:09Z – 02:27Z**
* CLI: `agent --version` → `2026.10.01-e373342`
* Binary: `~/.local/bin/agent` → `~/.local/share/cursor-agent/versions/2026.10.01-e373342/cursor-agent`
* Account (from `agent about --format json`): `the.luis.carbonell@gmail.com`, `subscriptionTier: "Ultra"`,
  `osPlatform: darwin`, `osArch: arm64`

## 0. How these captures were taken (important caveat)

`agent status --format json` **inside the AgentTeams bash tool** reports:

```json
{ "status": "unauthenticated", "isAuthenticated": false, "hasAccessToken": false, "hasRefreshToken": false, "message": "Not logged in" }
```

That is an **artifact of the bash sandbox, not the account state**. The sandbox sets
`security.mac.sandbox=1` and denies the macOS Security framework
(`/usr/bin/security add-generic-password …` → `SecKeychainSearchCreateFromAttributes: A Module Directory
Service error has occurred.`), which is where the CLI stores its OAuth tokens (`keychain/dist/index.js`,
`credentialManager.getAccessToken()`). `/bin/ps` returns `Operation not permitted` as well.

Every capture in this document was therefore produced by running the CLI **in the DSH host process**
(the same context in which the `@cagase/dsh-cursor` plugin actually spawns it), where:

```
agent status --format json
{
  "status": "authenticated",
  "isAuthenticated": true,
  "hasAccessToken": true,
  "hasRefreshToken": true,
  "userInfo": { "email": "the.luis.carbonell@gmail.com", "userId": 118287361, "firstName": "Lu", "lastName": "Carbonell", "createdAt": "2024-10-30T21:35:24.994Z" }
}
```

No tokens were captured; no token appears in any fixture.

Side effect worth knowing: **every `agent --model <m>` run persists the selection into
`~/.cursor/cli-config.json`** (`model.modelId` / `displayName`, `hasChangedDefaultModel: true`). The
research probes changed it and it was restored to the pre-probe value; see
`fixtures/live/cli-config-mutation.txt`.

---

## Evidence index (which file backs which section)

| Section | Raw fixture(s) |
| --- | --- |
| 1 Catalog | `fixtures/live/models.txt`, `list-models.txt`, `models-help.txt`, `help.txt` |
| 2 Grok matrix | `fixtures/live/models.txt` + `wire-matrix.txt` |
| 3 Wire acceptance | `fixtures/live/wire-matrix.txt`, `fixtures/live/wire/*.stdout.txt`, `fixtures/live/wire/*.stderr.txt` |
| 3 Mechanism | `fixtures/live/model-string-validation.txt`, `parameterized-models.txt` |
| 4 Flags | `fixtures/live/help.txt`, `hidden-flags-grep.txt`, `flag-gates.txt`, `system-prompt.txt`, `headless-tools.txt`, `headless-autodetect.txt`, `json-usage.txt`, `clean-room.txt` |
| 5 History format | `fixtures/live/agent-pb-history-types.txt`, `agent-pb-Ci.txt`, `history-parser.txt`, `history-tests.txt`, `history-example.json`, `history-continuity.txt`, `history-decisive.txt`, `json-usage.txt` |
| 6 Session continuity | `fixtures/live/session-continuity.txt`, `session-resume-decisive.txt`, `session-resume-replay.txt` |
| 7 stream-json | `fixtures/live/stream-json.jsonl`, `stream-json-events.txt`, `stream-json-force.jsonl`, `stream-json-nopartial.jsonl`, `stream-json-system-prompt-failure.jsonl` |
| 0 / misc | `fixtures/live/final-evidence.txt`, `cli-config-mutation.txt` |

---

## 1. Catalog

### 1.1 `agent models` — raw, full

Full output: `fixtures/live/models.txt` (256 lines, 12248 bytes). Head and tail verbatim:

```
Available models

auto - Auto (default)
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex-low-fast - Codex 5.3 Low Fast
gpt-5.3-codex - Codex 5.3
gpt-5.3-codex-fast - Codex 5.3 Fast
...
glm-5.2-high - GLM 5.2
glm-5.2-max - GLM 5.2 Max

Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.
```

* **Format**: one model per line, `<model id> - <display name>`, preceded by the literal header
  `Available models`, followed by a blank line and a `Tip:` line. **Line-oriented text only — no JSON.**
* **Count: 246 entries** (including `auto`). Verified two ways:
  `grep -cE '^[A-Za-z0-9._-]+ - ' models.txt` → `246`, and the python re-parse in `final-evidence.txt` → `246`.
* Ids vs display names: the left-hand token is the id used by `--model`; the right-hand side is the
  human label. Labels are not stable identifiers (`claude-opus-4-6-high` renders as `Claude Opus 4.6 1M`
  with no "High"; `claude-opus-4-8-xhigh` renders as `Claude Opus 4.8 1M`).
* **Id charset**: `A-Za-z0-9._-` only (dots appear in `gpt-5.3-codex`, `claude-4.6-sonnet-medium`).
* **Hidden characters**: the four `grok-4.7-*-fast` display names end with **two U+200B ZERO WIDTH SPACE**
  characters (`Grok 4.7  Low Fast​​`), and `grok-4.7` labels contain a **double space** after the version
  (`Grok 4.7  Low`). Exact bytes are in `final-evidence.txt`. Do not round-trip these labels as ids.

### 1.2 `agent --list-models` vs `agent models`

`agent --list-models` (fixture `list-models.txt`) prints the **identical body** — verified with `diff`:

```
models vs --list-models BODY: IDENTICAL (251 lines)
```

`--output-format json` is ignored by `--list-models` (still prints the text list), and `agent models`
does not accept `--format`:

```
$ agent models --format json
error: unknown option '--format'
(Did you mean --force?)
```

`agent models --help` only documents `-h, --help` (`models-help.txt`).
**There is no machine-readable model catalog; any picker must parse this text or hard-code slugs.**

### 1.3 Catalog filtering

The catalog is the **exploded/legacy view**: for parameterized models it lists the *variants*, e.g.
it lists `grok-4.7-low … grok-4.7-xhigh-fast` but **not** the base slug `grok-4.7`, which is
nonetheless accepted on the wire (§3). Conversely `agent models` lists nothing that the CLI rejects.

---

## 2. Grok matrix

From the catalog (22 grok-family entries out of 246) plus the wire probes in §3:

| Base (wire) | Catalog id prefix | low | medium | high | xhigh | max | minimal | plain `-fast` (no effort) | bare base accepted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `grok-4.7` | `grok-4.7-` | ✅ `-low` | ✅ `-medium` | ✅ `-high` | ✅ `-xhigh` | ❌ | ❌ | ❌ (`grok-4.7-fast` rejected) | ✅ `grok-4.7` |
| `cursor-grok-4.6` | `cursor-grok-4.6-` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ `grok-4.6` (no `cursor-` prefix) |
| `cursor-grok-4.5` | `cursor-grok-4.5-` | ✅ | ✅ | ✅ | ❌ (`cursor-grok-4.5-xhigh` rejected) | ❌ | ❌ | ❌ | ✅ `grok-4.5` (no `cursor-` prefix) |

Exact catalog slugs (verbatim from `models.txt`, lines 26–47 and 129–132):

```
cursor-grok-4.5-high - Grok 4.5
cursor-grok-4.5-high-fast - Grok 4.5 Fast
grok-4.7-low - Grok 4.7  Low
grok-4.7-low-fast - Grok 4.7  Low Fast​​
grok-4.7-medium - Grok 4.7  Medium
grok-4.7-medium-fast - Grok 4.7  Medium Fast​​
grok-4.7-high - Grok 4.7  High
grok-4.7-high-fast - Grok 4.7  High Fast​​
grok-4.7-xhigh - Grok 4.7  Extra High
grok-4.7-xhigh-fast - Grok 4.7  Extra High Fast​​
cursor-grok-4.6-low - Grok 4.6 Low
cursor-grok-4.6-low-fast - Grok 4.6 Low Fast
cursor-grok-4.6-medium - Grok 4.6 Medium
cursor-grok-4.6-medium-fast - Grok 4.6 Medium Fast
cursor-grok-4.6-high - Grok 4.6
cursor-grok-4.6-high-fast - Grok 4.6 Fast
cursor-grok-4.6-xhigh - Grok 4.6 Extra High
cursor-grok-4.6-xhigh-fast - Grok 4.6 Extra High Fast
cursor-grok-4.5-low - Grok 4.5 Low
cursor-grok-4.5-low-fast - Grok 4.5 Low Fast
cursor-grok-4.5-medium - Grok 4.5 Medium
cursor-grok-4.5-medium-fast - Grok 4.5 Medium Fast
```

Notes that matter for the DSH picker:

* **Every catalog grok id is `<base>-<effort>` or `<base>-<effort>-fast`.** There is no plain `-fast`
  entry and no `max`/`minimal` entry in this family (those efforts exist for claude/gpt families only).
* For every effort that exists there is also a `-fast` twin. So "base + Fast variant" maps 1:1 onto
  the catalog pairs `X-<effort>` / `X-<effort>-fast`.
* The base spelling is **not** uniform: `grok-4.7` vs `cursor-grok-4.6` vs `cursor-grok-4.5`.
* `cursor-grok-4.5` supports only low/medium/high — **no xhigh**, unlike 4.6/4.7.

---

## 3. Wire-string acceptance

Invocation for every row (shortest useful prompt, reused everywhere, `--mode ask --trust`):

```
agent --print --mode ask --trust --output-format text --model '<MODEL>' "Reply with exactly: OK"
```

Full transcript: `fixtures/live/wire-matrix.txt`; per-case stdout/stderr:
`fixtures/live/wire/<slug>.(stdout|stderr).txt`.

| Model string | Result | Evidence |
| --- | --- | --- |
| `grok-4.7` (bare, **not in catalog**) | **accepted** (exit 0, `OK`) | `wire/grok-4.7.stdout.txt` |
| `grok-4.7-low` | accepted | `wire/grok-4.7-low.stdout.txt` |
| `grok-4.7-xhigh` | accepted | `wire/grok-4.7-xhigh.stdout.txt` |
| `grok-4.7-xhigh-fast` | accepted | `wire/grok-4.7-xhigh-fast.stdout.txt` |
| `grok-4.7-fast` | **rejected** | `wire/grok-4.7-fast.stderr.txt` |
| `grok-4.7-max` | rejected | `wire/grok-4.7-max.stderr.txt` |
| `grok-4.7-minimal` | rejected | `wire/grok-4.7-minimal.stderr.txt` |
| `grok-4.7[effort=high]` | **rejected** | `wire/grok-4.7_effort_high_.stderr.txt` |
| `grok-4.7[effort=max]` | **rejected** (this is the DSH bug string) | `wire/grok-4.7_effort_max_.stderr.txt` |
| `grok-4.7[reasoning_effort=high]` | rejected | `wire/grok-4.7_reasoning_effort_high_.stderr.txt` |
| `grok-4.7[reasoning_effort=max]` | rejected | `wire/grok-4.7_reasoning_effort_max_.stderr.txt` |
| `grok-4.7[reasoning_effort=xhigh]` | rejected (partial parameter set) | `wire/grok-4.7_reasoning_effort_xhigh_.stderr.txt` |
| `grok-4.7[context=256k]` | rejected | `wire/grok-4.7_context_256k_.stderr.txt` |
| `grok-4.7[fast=false]` | rejected | `wire/grok-4.7_fast_false_.stderr.txt` |
| `grok-4.7[context=256k,reasoning_effort=xhigh,fast=false]` | **accepted** | `wire/grok-4.7_context_256k_reasoning_effort_xhigh_fast=false_.stdout.txt` |
| `grok-4.7[context=256k,reasoning_effort={low,medium,high},fast=false]` | accepted (all three) | same dir |
| `grok-4.7[context=256k,reasoning_effort={high,xhigh},fast=true]` | accepted | same dir |
| `grok-4.7[fast=false,reasoning_effort=xhigh,context=256k]` (permuted order) | **rejected** | `wire/grok-4.7_fast_false_reasoning_effort_xhigh_context_256k_.stderr.txt` |
| `grok-4.7[context=128k,reasoning_effort=xhigh,fast=false]` (wrong value) | rejected | `wire/grok-4.7_context_128k_reasoning_effort_xhigh_fast_false_.stderr.txt` |
| `grok-4.6` (bare) | accepted | `wire/grok-4.6.stdout.txt` |
| `grok-4.6-xhigh` | **rejected** (needs `cursor-` prefix in slug form) | `wire/grok-4.6-xhigh.stderr.txt` |
| `grok-4.6[effort=high,fast=true]` / `[effort=high,fast=false]` | accepted | same dir |
| `grok-4.6[effort=high]` (partial) | rejected | same dir |
| `cursor-grok-4.6-high` | accepted | `wire/cursor-grok-4.6-high.stdout.txt` |
| `cursor-grok-4.6[effort=high]` / `[effort=high,fast=true]` / `[context=256k,effort=high,fast=false]` | all rejected | same dir |
| `grok-4.5` (bare) | accepted | `wire/grok-4.5.stdout.txt` |
| `grok-4.5[effort=high,fast=false]` | accepted | same dir |
| `grok-4.5[effort=high]` (partial) | rejected | same dir |
| `cursor-grok-4.5-high` | accepted | `wire/cursor-grok-4.5-high.stdout.txt` |
| `cursor-grok-4.5-xhigh` | **rejected** (no such variant) | `wire/cursor-grok-4.5-xhigh.stderr.txt` |
| `claude-opus-4-8[context=1m,effort=high,fast=false]` (the CLI's own help example!) | **rejected** | `wire/claude-opus-4-8_context_1m_effort_high_fast_false_.stderr.txt` |

Accepted rows cost a real inference call (3–10 s); rejected rows fail locally in 1–2 s.

### 3.1 Exact rejection stderr

Every rejection has the same shape. Verbatim head (the `Available models:` list is the full 246-id
catalog on one line; complete text in the per-case `*.stderr.txt`):

```
Cannot use this model: grok-4.7[effort=max]. Available models: auto, gpt-5.3-codex-low, gpt-5.3-codex-low-fast, gpt-5.3-codex, gpt-5.3-codex-fast, gpt-5.3-codex-high, gpt-5.3-codex-high-fast, gpt-5.3-codex-xhigh, gpt-5.3-codex-xhigh-fast, gpt-5.2, composer-2.5, claude-opus-5-thinking-high, … , glm-5.2-high, glm-5.2-max
```

`grok-4.7-fast`, `grok-4.7-max`, `grok-4.7-minimal`, `grok-4.6-xhigh` and `cursor-grok-4.5-xhigh` produce
the same message with their own string substituted. `grok-4.7[reasoning_effort=xhigh]` (a *near-miss*)
also produces it — there is no error path that says "wrong parameter name"; the whole string simply
fails to resolve.

This reproduces the DSH-session lead exactly: `--model grok-4.7[effort=max]` → `Cannot use this model`,
while `--model grok-4.7-xhigh` in the same session succeeded.

### 3.2 Why: the acceptance rule (from the bundle, then confirmed live)

`~/.local/share/cursor-agent/versions/2026.10.01-e373342/9577.index.js`,
`ModelManager.handleInitialModel(e, t)`
(raw excerpt in `fixtures/live/model-string-validation.txt`):

```js
async handleInitialModel(e,t){
  const r=(0,p.hG)(e);                       // alias normalization only: composer-2 -> composer-2.5, composer-2-fast -> composer-2.5-fast
  const s=this.mapInitialModelVariantToParameterizedSelection(r);
  if(s){ ...; return e }
  let n=this.normalizeModelId(r);
  ...
  n||((0,p.RP)(r)?n=new o.Gm({...})
    :(0,l.uQ)(1,`Cannot use this model: ${r}. Available models: ${this.availableModels.map(e=>e.displayModelId).join(", ")}`));
}
mapInitialModelVariantToParameterizedSelection(e){
  for(const t of this.parameterizedModels){
    const r=t.variants.find(t=>t.legacySlug===e||t.variantStringRepresentation===e);
    if(r)return{modelId:t.name,parameters:...}
  }
}
```

So a `--model` string is accepted iff it is (a) a listed model id / `serverModelName`, (b) a
**parameterized model's `legacySlug`** (the catalog slugs), or (c) **byte-for-byte equal to a
`variantStringRepresentation`** the server supplies, or (d) a `GENERICBASE*`/`XAIEXTERNAL*` requested
model. `mapInitialModelVariantToParameterizedSelection` uses `===`, i.e. **exact string equality**:

* no partial parameter sets → `grok-4.7[reasoning_effort=xhigh]` fails;
* order is significant → the permuted parameter order fails;
* values are the server's own enum values → `context=128k`, `reasoning_effort=max` fail;
* parameter *ids* are per model → `grok-4.7` uses `reasoning_effort` (with `context`+`fast`), while
  `grok-4.6`/`grok-4.5` use `effort`+`fast`, which matches `~/.cursor/cli-config.json`'s
  `modelParameters` keys (`grok-4.6: [effort=high, fast=true]`, `grok-4.7: [context=256k, reasoning_effort=xhigh]`).

**Conclusion for the shim: never synthesise `base[param=value]` strings for Grok.** The
variant/`legacySlug` form (`grok-4.7-xhigh`, `cursor-grok-4.6-high-fast`) is the only form that can be
derived safely from the catalog. The CLI's own help example
(`claude-opus-4-8[context=1m,effort=high,fast=false]`) is **also rejected** for this account, so the
help text is not a reliable contract.

---

## 4. Headless flags actually honored for this account

### 4.0 Two cross-cutting behaviors you need first

**(a) "Headless" is auto-detected, not opt-in.** From `9969.index.js` (raw in `headless-autodetect.txt`):

```js
const ue=!process.stdin.isTTY, me=Boolean(process.stdout.isTTY), pe=!0===r.print||!me||ue;
```

`pe` is the headless flag used by the `--print`-only gates. Because the host-spawned CLI has no TTY,
`--print`-only flags are usable even without `--print`; conversely the documented gate errors
(`Error: --single-turn can only be used with --print/headless mode`, …, from
`"--printenv can only be used with --print/headless mode"` / `"--conversation-history-file can only be used
with --print/headless mode"`) could not be triggered in this environment (verified: `flag-gates.txt`
shows `agent --single-turn "hi"`, `agent --printenv "hi"`, `agent --background-shell-timeout 5 "hi"`
all running instead of erroring). **Pass `--print` explicitly anyway.**

**(b) Tool calls are auto-rejected in headless mode without `--force`/`--yolo`.** `--trust` only trusts
the workspace. `stream-json.jsonl` shows a shell call rejected by policy:

```json
{"type":"tool_call","subtype":"completed","call_id":"call-…","tool_call":{"shellToolCall":{"result":{"rejected":{"command":"echo dsh-tool-ok","workingDirectory":"/Users/…/dsh-cursor","reason":"","isReadonly":false}}},"hookAdditionalContexts":[],"toolCallId":"…","startedAtMs":"…","completedAtMs":"…"},"model_call_id":"…","session_id":"…","timestamp_ms":…}
```

and with `--force` the same call executes (`stream-json-force.jsonl`,
`result.result` = `"…The command printed:\n\n```\ndsh-tool-ok\n```"`).

### 4.1 Flag table

Hidden flags were first located in the bundle (`hidden-flags-grep.txt`); each is declared with
`.hideHelp()`, so `agent --help` (`help.txt`) does not list them.

| Flag | Declared help (bundle) | Observed for this account | Exact error / evidence |
| --- | --- | --- | --- |
| `--system-prompt <file>` | "Replace system prompt with contents of file (Anysphere/OpenAI team only)" | **Accepted by the arg parser, REJECTED server-side.** File is read and validated locally, then every request fails and the CLI retries 3×. | `RetriableError: [invalid_argument] unknown option '--system-prompt'` (exit 1) — `system-prompt.txt`; reproduced with `claude-opus-4-8-high` too (`final-evidence.txt`). Preceded by `Connection lost, reconnecting to https://agentn.global.api5.cursor.sh (attempt 1..3)...` / `Retry attempt 1..3...`. Control run without the flag answered normally (`The capital of France is Paris.`). |
| `--conversation-history-file <file>` | "Import prior conversation history from the given file" | **Parsed strictly, but no observable effect on the model.** Parsing/validation errors are real and immediate; a valid file changes nothing (see §5). | §5; identical `usage.inputTokens` with and without a 52 KB file. |
| `--new-session-id <uuid>` | "Create a new session with a caller-provided ID" | **Honored.** Creates `~/.cursor/chats/<workspaceHash>/<uuid>/{meta.json,store.db}`. **Single-use**: a second call with the same id fails. | `store.db` path in `session-continuity.txt`; error: `Error: Session ID "51ef1d1c-35c6-4afd-9c91-a04f0aed009d" is already in use.` (exit 1). |
| `--resume [chatId]` | "Select a session to resume" | **Honored — real conversation continuity.** | `--resume 5c834555-35b2-4b2b-a3cc-31b99449c40f` → `aubergine`, while a fresh chat in the same minute → `UNKNOWN` (`session-resume-replay.txt`). |
| `--continue` | "Continue previous session" | Honored; resumes the **most recent** chat for the workspace (so it followed the newest fresh chat, not the recalled one). | `session-resume-replay.txt` V3 → `UNKNOWN` after a newer fresh chat; `session-continuity.txt` T3 → `aubergine` when that session was the most recent. |
| `--exclude-workspace-context` | "Strip all workspace-sourced context (rules, skills, transcripts, notes) from the session." | **REJECTED server-side**, same retry pattern as `--system-prompt`. | `RetriableError: [invalid_argument] Workspace context exclusion is not allowed for this user, team, or selected model` (exit 1) — `clean-room.txt` R1. |
| `--single-turn` | "Finish after the initial user turn and delegated subagents (skip background shell wait and other follow-up turns)" | Accepted with `--print`; `OK`, exit 0. | `headless-tools.txt` K3 |
| `--show-thinking` | "Include model thinking blocks in the final JSON result (only works with --print and --output-format json)" | **Honored, json only.** Adds `thinking_blocks` to the `result` object. | With it: keys include `thinking_blocks`; without it: absent (`json-usage.txt` J1/J2 vs J3). |
| `--allowed-tools <tool>` | "Allow only proto ToolCall oneof tool(s) for this session (internal only; can be used multiple times or comma-separated)" | Validates against the proto oneof names; invalid input exits with the full list. | `Invalid --allowed-tools value(s): bogus. Expected one of: shell_tool_call, delete_tool_call, glob_tool_call, grep_tool_call, read_tool_call, update_todos_tool_call, read_todos_tool_call, edit_tool_call, ls_tool_call, read_lints_tool_call, mcp_tool_call, sem_search_tool_call, create_plan_tool_call, web_search_tool_call, task_tool_call, … write_canvas_tool_call, read_canvas_tool_call` (69 values) — `flag-gates.txt` |
| `--exclude-tools <tool>` | "Exclude proto ToolCall oneof tool(s) from this session (internal only; …)" | **No validation** — an unknown name (`bogus`) is silently accepted and the run proceeds (exit 0). | `flag-gates.txt` |
| `--background-shell-timeout <seconds>` | "Maximum time to keep waiting for running background shells after the final turn before aborting them and …" | Accepted with `--print`; `OK`, exit 0. | `headless-tools.txt` K4 |

Also hidden and captured for completeness (`hidden-flags-grep.txt`): `--dev-raw-model-slug <slug>`,
`--harness <harness>`, `--computer-use-coords <pixels|percent>`, `--printenv`, `--data-dir <path>`,
`-c/--cloud`, `-b/--background`.

Local validation of `--system-prompt` (before any network call) is strict and its messages are
worth knowing (`hidden-flags-grep.txt`, `9969.index.js`):

```
Error: --system-prompt file not found: <resolved path>
Error: --system-prompt file is empty: <resolved path>
Error: failed to read --system-prompt file: <resolved path>
```

---

## 5. `--conversation-history-file`: exact format

### 5.1 Parser

`9969.index.js` (raw in `history-parser.txt`):

```js
function H(e){
  const t=(0,s.readFileSync)(e,"utf8"),
        n=i.iB.fromJsonString(t,{ignoreUnknownFields:!0});
  for(const e of n.messages)
    if("assistant"===e.message.case)
      for(const t of e.message.value.content){
        if("toolCall"!==t.content.case) continue;
        const e=t.content.value;
        try{ JSON.parse(e.argsJson) }
        catch(t){ throw new Error(`Invalid args for tool call ${e.toolCallId}: ${n}`) }
      }
  return n
}
```

`i.iB` is the module export `agent_pb.js → iB: () => Ci`, i.e. the protobuf-es message
**`agent.v1.ConversationHistory`** (`agent-pb-Ci.txt`, `agent-pb-history-types.txt`). The file is
**protobuf JSON** (`fromJsonString`), not binary and not the stream-json event shape. Its content is
handed to `UserMessageAction.conversation_history` (field 7).

### 5.2 Schema (from `index.js`, class `$()` descriptors)

```
ConversationHistory            { messages: ConversationHistoryMessage[], replace_user_info?: bool }
ConversationHistoryMessage     oneof message { user: ConversationHistoryUserMessage
                                               assistant: ConversationHistoryAssistantMessage
                                               tool: ConversationHistoryToolMessage }
ConversationHistoryUserMessage      { content: ConversationHistoryUserContent[] }
ConversationHistoryUserContent      oneof content { text: ConversationHistoryTextContent
                                                    image: ConversationHistoryImageContent }
ConversationHistoryTextContent      { text: string }
ConversationHistoryImageContent     { data: string, mime_type?: string }
ConversationHistoryAssistantMessage { content: ConversationHistoryAssistantContent[] }
ConversationHistoryAssistantContent oneof content { text: ConversationHistoryTextContent
                                                    reasoning: ConversationHistoryReasoningContent
                                                    redacted_reasoning: ConversationHistoryRedactedReasoningContent
                                                    tool_call: ConversationHistoryToolCall }
ConversationHistoryReasoningContent { text: string, signature?: string }
ConversationHistoryRedactedReasoningContent { data: string }
ConversationHistoryToolCall         { tool_call_id: string, tool_name: string, args_json: string }
ConversationHistoryToolMessage      { tool_call_id: string, tool_name: string,
                                      content: ConversationHistoryToolResultContent[],
                                      is_error?: bool, hook_additional_contexts: …[] }
ConversationHistoryToolResultContent oneof content { text: ConversationHistoryTextContent
                                                     image: ConversationHistoryImageContent }
```

JSON uses camelCase field names (`toolCallId`, `toolName`, `argsJson`, `mimeType`, `toolCallId`).

### 5.3 Minimal worked example

`fixtures/live/history-example.json`:

```json
{
  "messages": [
    { "user": { "content": [ { "text": { "text": "Remember this codeword: PLATYPUS-7731. Reply with just: OK" } } ] } },
    { "assistant": { "content": [ { "text": { "text": "OK" } } ] } }
  ]
}
```

This file parses cleanly (exit 0). The parser's own error messages prove the exact type path
(`history-tests.txt`, `history-continuity.txt`):

| Input | Exact result |
| --- | --- |
| `not json at all` | `Invalid conversation history: cannot decode agent.v1.ConversationHistory from JSON: Unexpected token 'o', "not json at all" is not valid JSON` (exit 1) |
| top-level array | `Invalid conversation history: cannot decode message agent.v1.ConversationHistory from JSON: array` (exit 1) |
| `{"messages":[{"assistant":{"content":[{"toolCall":{"toolCallId":"call_1","toolName":"shell","argsJson":"{this is not json"}}]}}]}` | `Invalid conversation history: Invalid args for tool call call_1: Expected property name or '}' in JSON at position 1 (line 1 column 2)` (exit 1) |
| `{"messages":[{"user":{"content":[{"text":{"text":123}}]}}]}` | `Invalid conversation history: cannot decode field agent.v1.ConversationHistoryTextContent.text from JSON: 123` (exit 1) |
| `{}` | accepted (empty history) |
| valid file (§5.3) | accepted |

### 5.4 **Finding: it is inert for this account**

Continuity was **not** demonstrated, and the negative result is strong and reproducible:

| # | Setup | Prompt | Answer | Fixture |
| --- | --- | --- | --- | --- |
| H1 | history = codeword PLATYPUS-7731 | "What codeword did I ask you to remember?" | `I don't have one. This conversation didn't include a codeword to remember.` | `history-tests.txt` |
| H2 | no history (control) | same | identical answer | `history-tests.txt` |
| V1 | history = codeword + assistant echo | same | `I don't have one. …` | `history-continuity.txt` |
| V2 | history = 4 msgs, number 4242 | "Repeat the number I told you." | `You haven't told me a number in this conversation.` | `history-continuity.txt` |
| V3 | same history, `claude-opus-4-8-high` | same | `I don't see any codeword in the context I've been given. There's no codeword defined in your query, the system instructions, or the workspace information available to me.` | `history-continuity.txt` |
| E1 | history = "spare key under the blue ceramic frog" | "Where is the spare key hidden?" | `UNKNOWN` | `history-decisive.txt` |
| E2 | no history (control) | same | `UNKNOWN` | `history-decisive.txt` |
| E3 | history = "My dog's name is Biscuit-9." | "What is my dog's name?" | `UNKNOWN` | `history-decisive.txt` |
| E4 | no history (control) | same | `UNKNOWN` | `history-decisive.txt` |
| R3 | empty workspace `/tmp/dshchA`, history = spare-key fact | same as E1 | `UNKNOWN` | `clean-room.txt` |
| R4 | empty workspace `/tmp/dshchB`, no history | same | `UNKNOWN` | `clean-room.txt` |

And the decisive transmission test (`json-usage.txt`): a **52 840-byte, 240-message** history file
produced exactly the same request accounting as no file at all:

```
J1) --output-format json --show-thinking --conversation-history-file /tmp/hist-big.json  "Reply with exactly: OK"
    usage: {"inputTokens": 10837, "outputTokens": 464, "cacheReadTokens": 5888, "cacheWriteTokens": 0}
J2) --output-format json --show-thinking                                   (no history file)
    usage: {"inputTokens": 10837, "outputTokens": 662, "cacheReadTokens": 5888, "cacheWriteTokens": 0}
```

Identical `inputTokens` means the history is **not present in the prompt sent to the model** — the
file is parsed and then has no effect on the request. Combined with `--system-prompt` and
`--exclude-workspace-context` both being refused server-side (`invalid_argument … not allowed for this
user, team, or selected model`), the headless context-injection features are gated off for this account.

*Residual uncertainty*: a tool-call replay history (assistant `toolCall` + matching `tool` result) was
not proven inert — the parser validates exactly that shape, so it may be special-cased. Text-only
histories are proven inert.

---

## 6. Session continuity

`--new-session-id <uuid>` creates a chat in the CLI's local store, keyed by workspace:

```
~/.cursor/chats/766fe73c06573698c270309a02f752f8/5c834555-35b2-4b2b-a3cc-31b99449c40f/
    meta.json      (157 B)
    store.db       (106 496 B)
```

`store.db` contains the raw user text and the CLI's own wrapping (`session-resume-replay.txt`):

```
3My favorite color is aubergine. Reply with just OK.
…{"role":"user","content":[
   {"type":"text","text":"\n<system_reminder>\nAsk mode is active. … You MUST NOT make any edits, run any non-readonly tools …"},
   {"type":"text","text":"<timestamp>Friday, Oct 2, 2026, 10:19 PM (UTC-4)</timestamp>\n<user_query>\nMy favorite color is aubergine. Reply with just OK.\n</user_query>"}]}
5What is my favorite color? Reply with just the color.
```

Observable behavior:

1. **Single-use id.** The second call with the same `--new-session-id` fails:
   `Error: Session ID "51ef1d1c-…" is already in use.` (exit 1) — `session-continuity.txt` S2.
   So a shim must mint the id once and then `--resume` it.
2. **`--resume <chatId>` restores the conversation.** Decisive pair, same minute
   (`session-resume-replay.txt`):
   * `--resume 5c834555-35b2-4b2b-a3cc-31b99449c40f` → `aubergine`
   * fresh chat, no flags → `UNKNOWN`
   The recalled session was created 8 minutes earlier with `--new-session-id`, so continuity is
   carried by the local session store, not by re-sending history.
3. **`--continue` resumes the most recent chat for the workspace** — after a newer fresh chat existed,
   `--continue` returned `UNKNOWN` (V3); when it was the most recent, it returned `aubergine`
   (`session-continuity.txt` T3). It is a "last chat" selector, not a "any chat with this fact" search.
4. **Caution — transient context bleed.** In one window (`session-continuity.txt` T4, and C1) a *fresh*
   chat with no flags also answered `aubergine`, but the same fresh-chat control answered `UNKNOWN`
   before (R2/R5) and after (E5/E6, V2). The only mechanism in the CLI that adds workspace-sourced
   "transcripts" is what `--exclude-workspace-context` strips — and that flag is disabled for this
   account (§4). Treat any single "the model remembered" observation without a control as unreliable;
   the V1/V2 pair above is the controlled result.
5. `--resume -1` / `--resume -<n>` are handled specially in the bundle (Nth-previous chat,
   `"No previous chats found."` on failure) — not exercised for this account.

---

## 7. stream-json transcript

Full capture: `fixtures/live/stream-json.jsonl` (95 JSON lines, 20 287 B, zero non-JSON lines).

Command:

```
agent --print --trust --model grok-4.7-xhigh --output-format stream-json --stream-partial-output \
  "Think briefly, then use your shell tool to run the exact command: echo dsh-tool-ok  — then tell me the exact output."
```

(Deliberately run **without** `--force`, so the tool call is visible but auto-rejected; the executed
variant is `stream-json-force.jsonl`.)

### 7.1 Event types and fields (exactly as seen)

| `type` | `subtype` | count | Top-level fields | Notes |
| --- | --- | --- | --- | --- |
| `system` | `init` | 1 | `apiKeySource`, `cwd`, `model`, `permissionMode`, `session_id`, `subtype`, `type` | first line; `model` is the **display name** (`"Grok 4.7 256K Extra High"`), not the slug |
| `user` | — | 1 | `message`, `session_id`, `type` | **the prompt echo** — `message.content[0].text` is the prompt verbatim. Note: no `timestamp_ms`. |
| `assistant` | — | 69 | `message`, `session_id`, `timestamp_ms`, `type` | `message.content[0].text` is a **delta** with `--stream-partial-output` (e.g. `"I'll"`), a full block without it |
| `thinking` | `delta` | 16 | `session_id`, `subtype`, `text`, `timestamp_ms`, `type` | one delta per thinking chunk |
| `thinking` | `completed` | 3 | `session_id`, `subtype`, `timestamp_ms`, `type` | no text |
| `tool_call` | `started` | 2 | `call_id`, `model_call_id`, `session_id`, `subtype`, `timestamp_ms`, `tool_call`, `type` | `tool_call` encloses the proto oneof, here `shellToolCall.args` |
| `tool_call` | `completed` | 2 | `call_id`, `model_call_id`, `session_id`, `subtype`, `timestamp_ms`, `tool_call`, `type` | `shellToolCall.result` — `{rejected:{…}}` or `{success:{…}}`; plus `hookAdditionalContexts`, `toolCallId`, `startedAtMs`, `completedAtMs` |
| `result` | `success` | 1 | `duration_ms`, `duration_api_ms`, `is_error`, `request_id`, `result`, `session_id`, `subtype`, `type`, `usage` | last line; `result` = concatenated assistant text; `usage` = `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` |

Verbatim samples (`stream-json-events.txt`):

```json
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/Users/theluiscarbonell/Projects/cagase/dsh-cursor","session_id":"17e650d2-1c02-439a-bfc7-989b3de62988","model":"Grok 4.7 256K Extra High","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Think briefly, then use your shell tool …"}]},"session_id":"17e650d2-…"}
{"type":"thinking","subtype":"delta","text":"Running `echo dsh-tool-ok`","session_id":"17e650d2-…","timestamp_ms":1790994267353}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll"}]},"session_id":"17e650d2-…","timestamp_ms":1790994267358}
{"type":"tool_call","subtype":"started","call_id":"call-c6c3a8b7-…-0\nfc_d85581e1-…_0","tool_call":{"shellToolCall":{"args":{"command":"echo dsh-tool-ok","workingDirectory":"","timeout":30000,"toolCallId":"…","simpleCommands":["echo"],"hasInputRedirect":false,"hasOutputRedirect":false,"parsingResult":{"parsingFailed":false,"executableCommands":[{"name":"echo","args":[{"type":"word","value":"dsh-tool-ok"}],"fullText":"echo dsh-tool-ok"}],"hasRedirects":false,"hasCommandSubstitution":false,"redirects":[]},"fileOutputT…"}}}},"model_call_id":"…","session_id":"17e650d2-…","timestamp_ms":1790994268343}
{"type":"result","subtype":"success","duration_ms":11854,"duration_api_ms":11854,"is_error":false,"result":"I'll run that command and report the exact output.The shell call was rejected with no output. …","session_id":"17e650d2-…","request_id":"…","usage":{"inputTokens":27341,"outputTokens":482,"cacheReadTokens":22400,"cacheWriteTokens":0}}
```

Details that matter to a shim:

* `--stream-partial-output` changes the **meaning** of `assistant` events from "a text block" to "a
  text delta"; deltas carry no separator, so consumers must concatenate (`result.result` shows the
  concatenation: `"I'll run that command…The shell call was rejected…"`).
* `assistant` events carry the same content twice in effect: `message` (Anthropic-shaped
  `{role, content:[{type:"text",text}]}`) and, at the end, `result.result` (plain concatenation).
* Without `--stream-partial-output` the event list is short and `assistant.message.content[0].text` is
  the complete text (`stream-json-nopartial.jsonl`, 8 lines, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"alpha"}]},"session_id":"…"}`).
* `retry`/`connection` events only appear on failure. In the `--system-prompt` failure
  (`stream-json-system-prompt-failure.jsonl`) the transcript is
  `system/init ×1, user ×1, connection/reconnecting ×3, retry/starting ×3, connection/reconnected ×3`
  and **no `result` event**, with the error text on stderr:

  ```json
  {"type":"connection","subtype":"reconnecting","session_id":"…","timestamp_ms":…,"attempt":1,"endpoint_url":"https://agentn.global.api5.cursor.sh"}
  {"type":"retry","subtype":"starting","session_id":"…","timestamp_ms":…,"attempt":1,"is_resume":false}
  {"type":"connection","subtype":"reconnected","session_id":"…","timestamp_ms":…}
  ```
* No `interaction_query` event was observed on this account. No `thinking` event appears without
  `--stream-partial-output` in the sampled run.

---

## 8. Consequences for `@cagase/dsh-cursor` (evidence-derived)

1. **Picker source of truth** = `agent models` / `agent --list-models` text (246 ids, §1). Grok bases
   are `grok-4.7`, `cursor-grok-4.6`, `cursor-grok-4.5`; efforts low/medium/high(/xhigh except 4.5)
   and each has a `-fast` twin. There is no `max`/`minimal` and no plain `-fast` for these bases (§2).
2. **Effort must be encoded as the catalog slug suffix** (`grok-4.7-xhigh`, `cursor-grok-4.6-low-fast`).
   Synthesising `base[effort=…]` is *always* rejected for Grok, and even the CLI's own advertised
   bracket example is rejected for this account (§3).
3. **The DSH system prompt cannot ride `--system-prompt`** (server rejects it) and
   **history cannot ride `--conversation-history-file`** (parsed, then inert — identical input tokens).
   The only CLI channel that demonstrably carries prior turns is the **session store**
   (`--new-session-id` once, then `--resume <id>`), which also means one CLI chat per DSH session (§4, §5, §6).
4. **Tools need `--force`** (or `--yolo`) in headless mode; `--trust` alone yields
   `{"rejected":{…}}` tool results (§4.0b).
5. **`stream-json` echoes the prompt** as a first-class `{"type":"user", …}` event whose
   `message.content[0].text` is the outgoing prompt verbatim (§7). It is emitted by the CLI itself, so
   a consumer that concatenates every text-bearing event will reproduce the `User:` echo in the DSH chat.
6. `--print` should be passed explicitly even though non-TTY auto-enables headless (§4.0a).
