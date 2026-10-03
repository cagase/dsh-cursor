# t7 attempt 1 — INVALID, PENDING REPAIR (t6 has not landed)

Verifier: `verifier`, attempt `f33a6851-4429-4611-89a0-8d13a2d75b1c`, 2026-10-03 ~03:0xZ.
This attempt carries **no verdict** on the repaired shim. The captain confirmed t6 (the F1/F2
repair) was still in progress when the scheduler dispatched t7.

## Observed workspace state (all pre-repair)

| probe | result |
| --- | --- |
| `git log --oneline -1` | `ecb4395 fix(package): declare only real soft peers as optional` — no t6 commit |
| `git diff --stat src/models scripts` | only t2's diff (adapter/cli 726 lines + the two scripts); no new repair surface |
| `grep -n '\`5\${hex' src/models/session.ts` | line 91 still emits `5${hex.slice(13, 16)}` → `sessionUuidFor` still returns a **UUIDv5** |
| `shasum -a 256 /tmp/dsh-cursor-lib-backup/models/session.js lib/models/session.js` | both `df3330a7ccb53f01f0b2fecc885f033266295630a1d773e13810eeb96b293fcc` → the built output is byte-identical to the round-1 pre-repair build |
| file mtimes | `src/models/cli.ts` 22:42:53, `src/models/session.ts` 22:42:46, `scripts/verify-models.mjs` 22:44:27 — unchanged since round 1 |
| `grep -c 'Invalid --new-session-id\|expected a UUIDv4' scripts/verify-models.mjs` | `0` → the offline stand-in still accepts any `--new-session-id` and never asserts the CLI's UUIDv4 contract |
| `rm -rf lib && npm run build` | exit 0 (same as round 1) |
| `npm run verify` | exit 0 (verify-models-live `SKIP (AUTH)`) — a green suite on the pre-repair tree, i.e. still not acceptance evidence |

## Consequence

F1 (UUIDv5 `--new-session-id` rejected live) and F2 (silent dead `--resume`) are unchanged; the
round-2 live probes and the harness refresh were not executed because they would only re-derive
round 1. Round-1 evidence stands: `verifier-t3-report.md`, `verifier-t3-output.txt`,
`verifier-live-evidence.txt`.

## Ready for the next attempt (no changes needed)

* `fixtures/live/verifier-t3.mjs` (50 checks) — C11a–C11d are exactly the F1/F2 checks; they must
  flip to PASS once the repair lands.
* `fixtures/live/verifier-fake-agent.sh` — already emulates the live CLI's UUIDv4 rejection behind
  `VERIFIER_REQUIRE_UUID4=1` and a resume that silently adopts an unknown id; the next attempt
  should flip that to the default and add a persistent session store so `--new-session-id` of an
  existing chat yields `already in use`.
* Pre-repair baseline for the "would have caught it" demonstration:
  `/tmp/dsh-cursor-lib-backup` (byte-identical to the current `lib/`).
* Live probe route: host-only dynamic Cordis plugin `probe-2` (stopped) — its `pkg-1..pkg-5`
  packages contain the working host-process probe code (keys: 16 live invocations, raw JSON under
  `fixtures/live/verifier-live-*-host.json`).
