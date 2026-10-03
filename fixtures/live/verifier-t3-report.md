# t3 verification report — Cursor model routing + one-to-one shim

Verifier: `verifier` (attempt `11690605-b2f1-404d-9933-2cee790e7c85`)
Repo: `/Users/theluiscarbonell/Projects/cagase/dsh-cursor`
Verdict: **FAILED** — all t2 acceptance criteria were re-checked; 7 of 9 pass, 2 are **unmet**
against the live CLI (one of them a blocker that makes every Grok bootstrap turn fail).

No product code was touched by this verification. Every artifact below lives under `fixtures/live/`.

## 1. Build + suite (exact commands)

| command | exit | evidence |
| --- | --- | --- |
| `rm -rf lib && npm run build` (`tsc -p tsconfig.json`) | 0 | rebuilt `lib/` is byte-identical to the pre-existing committed `lib/` (`diff -rq` clean; `sha256` of adapter/cli/grok/session/index unchanged) |
| `node scripts/verify-assets.mjs` | 0 | `verify-assets: ok` |
| `node scripts/verify-fixture.mjs` | 0 | `verify-fixture: ok` |
| `node scripts/verify-models.mjs` | 0 | `verify-models: ok` |
| `node scripts/verify-models-live.mjs` | 0 | `SKIP (AUTH)` — see §4 |
| `npm run verify` | 0 | all four, last one SKIP |
| `node fixtures/live/verifier-t3.mjs` (this harness) | **1** | 46/50 checks pass; 4 unmet criteria (§3) |

`npm run verify` passing is **not** evidence the feature works: its `--new-session-id`/`--resume`
paths run against an offline stand-in that accepts any session id and any resume. The live CLI does
not — see §3.

## 2. What passed (independently re-derived from `fixtures/live/`, raw evidence in
`verifier-t3-output.txt`)

| t2 criterion | checks | status | key raw evidence |
| --- | --- | --- | --- |
| 1 Grok catalog | C1a–C1f | passed | picker Grok ids exactly `grok-4.7`, `grok-4.7-high-fast`, `cursor-grok-4.6`, `cursor-grok-4.6-high-fast`, `cursor-grok-4.5`, `cursor-grok-4.5-high-fast`; efforts = low/medium/high/xhigh (4.7, 4.6) and low/medium/high (4.5 only, xhigh rejected live); no `max`/`minimal`/plain `-fast`; names carry no U+200B |
| 2 Wire strings | C2a–C2c, C2f, C2g, C10a, C10b | passed | 28 advertised pairs → all in the CLI's own accepted set; 37-case `wire-matrix.txt` cross-check: 0 catalog ids rejected, only accepted non-catalog strings are the 3 bare bases + byte-identical bracket forms; live `agent models` = same 246 ids; live `--model grok-4.7-xhigh` → exit 0 `OK`, live `--model grok-4.7-xhigh-fast` → exit 0 `OK` |
| 3 No bracket override | C3a, C3b, C2d, C10c | passed | 15 passthrough calls byte-identical (incl. `grok-4.7[effort=max]`); zero bracket strings across all advertised pairs; unadvertised pairs throw `INVALID_ARGS` (never a rejected slug); live `grok-4.7[effort=max]` still exit 1 |
| 4 Non-Grok verbatim | C4a, C4b | passed | 224/224 ids present in catalog order, 0 invented; 896 assertions: no rename, no synthetic suffix/effort, no `reasoning` |
| 5 Transcript hygiene | C5a–C5h, C11-independent | passed | replay of `stream-json.jsonl`, `-force.jsonl`, `-nopartial.jsonl`, synthetic result-only and an echo-injected run: emitted text == independently derived recap-deduped assistant text; reasoning == joined thinking deltas; exactly one finish; no `system`/`user` echo/`retry`/`connection`/`interaction_query`/`tool_call` content (verified against a fake that echoes the plugin's real 269-char `<dsh_system_prompt>` prompt back) |
| 6 Plumbing | C6a–C6c | passed | real spawn argv contains `--print --stream-partial-output --trust --force --model <wire>` and never `--system-prompt`/`--conversation-history-file`/`--exclude-workspace-context`; exactly one positional; no temp file created or referenced |
| 7 Continuity | C7a–C7i | **failed** | planning logic is correct offline (new→resume→re-anchor→one-shot/aux isolation, retry, collision and signalled-resume recovery) but the id it mints and its dead-resume assumption break against the live CLI — see §3 |
| 8 Temp files / abort / error / EMPTY | C6c, C8a, C8b, C5g | passed | no temp files; aborted signal → single `aborted` finish; CLI exit≠0 → single `error` finish; echo-only capture → `EMPTY_RESPONSE` |
| 9 `verify-models.mjs` offline + lib consistency | C9a–C9c | passed | no old bracket assertion remains; `node scripts/verify-models.mjs` exit 0 with `agent` absent from PATH; clean rebuild byte-identical |

## 3. Unmet criteria (exact commands + raw output)

The live CLI probes ran in the **DSH host process** (the bash sandbox cannot reach the login
keychain: `agent status --format json` there returns `"Not logged in"`; t1 documented the same
artifact). Raw captures: `verifier-live-probe-host.json`, `verifier-live-sessionid-host.json`,
`verifier-live-continuity-host.json`, `verifier-live-continuity2-host.json`, summarised in
`verifier-live-evidence.txt`.

### F1 (BLOCKER) — the minted session id is a UUIDv5; the CLI requires a UUIDv4

`sessionUuidFor('S1#0') = 39d32074-6362-53fa-8eb7-84ae8c182d38` (version nibble `5`).

```
agent --print --mode ask --trust --model grok-4.7 --new-session-id 39d32074-6362-53fa-8eb7-84ae8c182d38 'Reply with exactly: OK'
  exit=1  stderr: Error: Invalid --new-session-id "39d32074-6362-53fa-8eb7-84ae8c182d38": expected a UUIDv4.

agent --print --mode ask --trust --model grok-4.7 --new-session-id 39d32074-6362-43fa-8eb7-84ae8c182d38 'Reply with exactly: OK'
  exit=0  stdout: OK            # same id with version nibble 4

same v5 id with --output-format stream-json: exit=1, same stderr
same v5 id with --resume:                    exit=0 (resume does not validate)
```

Consequence, reproduced end-to-end offline with a CLI that enforces the live rule
(`VERIFIER_REQUIRE_UUID4=1`): the adapter's bootstrap spawn is rejected and the turn ends in an
error finish — `{"type":"finish","reason":{"kind":"error","failure":{"message":"Error: Invalid
--new-session-id \"549d6366-e4df-5389-95d2-b998e11ba8cd\": expected a UUIDv4.","code":"UNKNOWN"}}}`.
`streamAgentTurn` only recovers from `already in use`, so the *first* turn of every DSH session
fails; no Grok turn can ever bootstrap a CLI chat.

### F2 (HIGH) — a dead `--resume` is silent, so the adapter's recovery never fires

Live captures (controlled, same workspace, same minute):

```
agent --print ... --new-session-id 4f8f6a1e-4b2c-4d3e-8a1b-2c3d4e5f6a7b 'My favorite color is aubergine. Reply with just OK.'   exit=0 'OK'
agent --print ... --resume 4f8f6a1e-4b2c-4d3e-8a1b-2c3d4e5f6a7b 'What is my favorite color? ...'                                 exit=0 'aubergine'   # context carried
agent --print ... --resume 5a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d 'What is my favorite color? ...'                                 exit=0 'UNKNOWN'     # fresh chat
agent --print ... (no resume/fresh control)             'What is my favorite color? ...'                                         exit=0 'UNKNOWN'
```

For a session the CLI no longer has, `--resume <uuid>` exits **0** with **empty stderr**, answers
normally, emits no error event, and its `system/init` even **adopts the requested id**:

```
{"type":"system","subtype":"init","session_id":"00000000-0000-5000-8000-000000000000", ...}
{"type":"result","subtype":"success","is_error":false,"result":"OK", ...}    exit=0, stderr=""
```

and the CLI creates `/Users/theluiscarbonell/.cursor/chats/<ws>/00000000-0000-5000-8000-000000000000/store.db`
for it. Because `src/models/cli.ts` only recovers when `first.failure` is set (error event, non-zero
exit or classified stderr), the adapter keeps `mode:'resume'` and sends only the newest user turn →
**silent total context loss with no error**. The `system/init.session_id` guard suggested as a
stronger check would *not* catch it, since the init id equals the requested id.

Note: t1's `session-resume-decisive.txt` is a null result and was not used. The controlled evidence
is the capture above plus t1's `session-resume-replay.txt` (V1 `aubergine` vs V2 fresh `UNKNOWN`).

### F3 (MEDIUM, process) — the shipped suite cannot catch F1/F2

`npm run verify` exits 0 while the production bootstrap path fails. `scripts/verify-models.mjs`
should assert the CLI's session-id contract (UUIDv4) and emulate the live CLI's rejection and
silent-fresh-resume semantics.

### Observations (not criterion failures)

* The AUTH-fallback picker names the cursor-prefixed families `Cursor Grok 4.6` / `Cursor Grok 4.5`
  (no labels available offline) where the live path shows `Grok 4.6` / `Grok 4.5`. Cosmetic.
* Collision recovery (`C7i`) resumes the existing chat and re-delivers the whole bootstrap context,
  duplicating history inside the CLI chat. No criterion covers it; noted for the repair.

## 4. Live-vs-sandbox credentials

`agent status --format json` in the AgentTeams bash sandbox reports `"Not logged in"` (keychain
denied) — an artifact, as t1 documented. All live probes above were executed in the DSH host process
through a temporary host-only dynamic Cordis plugin, using the same executable the plugin resolves
(`/Users/theluiscarbonell/.local/bin/agent`, cli `2026.10.01-e373342`). `agent models` there lists
246 ids, byte-equivalent in ids to the t1 capture.

## 5. Reproduce

```sh
cd /Users/theluiscarbonell/Projects/cagase/dsh-cursor
rm -rf lib && npm run build && npm run verify         # both exit 0
node fixtures/live/verifier-t3.mjs                    # exit 1: 46/50, C11a–C11d unmet
cat fixtures/live/verifier-t3-output.txt              # per-check raw evidence
cat fixtures/live/verifier-live-evidence.txt          # raw live CLI captures
```
