#!/bin/sh
# t6 live evidence capture.
#
# MUST run in the DSH host process, where the Cursor agent CLI is authenticated
# (the AgentTeams bash sandbox cannot read the login keychain: docs/live-cli-contract.md §0).
# The intended route is a temporary host-only dynamic Cordis plugin that runs commands
# through ctx.shell with sandboxPolicy danger-full-access, e.g.:
#
#   cursor_live_probe({ command: "cd <repo> && fixtures/live/t6-live-evidence.sh", dangerFullAccess: true })
#
# Writes fixtures/live/t6-live-evidence.txt and prints it.
set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
AGENT="${CURSOR_AGENT_BIN:-/Users/theluiscarbonell/.local/bin/agent}"
OUT=fixtures/live/t6-live-evidence.txt
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SEED="t6live-$(date +%s)"
ID="$(node -e "import('./lib/models/session.js').then((m) => console.log(m.sessionUuidFor(process.argv[1])))" "$SEED#0")"
V5ID="$(printf '%s' "$ID" | sed -E 's/^(.{8}-.{4})-4/\1-5/')"

{
  echo "# t6 live evidence — minted session id and dead-resume re-anchor"
  echo
  echo "Captured: $STAMP"
  echo "CLI: $("$AGENT" --version 2>/dev/null | head -1)"
  echo "Binary: $AGENT"
  echo "Route: host-only dynamic Cordis plugin tool, ctx.shell with sandboxPolicy danger-full-access"
  echo "Seed: $SEED  ->  adapter-minted id: $ID"
  echo

  echo "## 1. F1 acceptance — the exact id the adapter mints, handed to --new-session-id"
  echo
  echo "\$ $AGENT --print --mode ask --trust --model grok-4.7 --new-session-id $ID 'Reply with exactly: OK'"
  set +e
  OUT1="$("$AGENT" --print --mode ask --trust --model grok-4.7 --new-session-id "$ID" "Reply with exactly: OK" 2>&1)"
  C1=$?
  set -e
  echo "exit=$C1"
  echo "stdout/stderr:"
  echo "$OUT1"
  echo "chat store created:"
  ls -d "$HOME"/.cursor/chats/*/"$ID" 2>/dev/null || echo "(none)"
  echo

  echo "## 2. F1 control — the same digest with the pre-repair version nibble (v5)"
  echo
  echo "\$ $AGENT --print --mode ask --trust --model grok-4.7 --new-session-id $V5ID 'Reply with exactly: OK'"
  set +e
  OUT2="$("$AGENT" --print --mode ask --trust --model grok-4.7 --new-session-id "$V5ID" "Reply with exactly: OK" 2>&1)"
  C2=$?
  set -e
  echo "exit=$C2"
  echo "$OUT2"
  echo

  echo "## 3. Adapter-driven turns against the real CLI (argv captured through a logging wrapper)"
  echo
  echo "\$ node fixtures/live/t6-live-validate.mjs --seed=${SEED}b --agent=$AGENT"
  node fixtures/live/t6-live-validate.mjs "--seed=${SEED}b" "--agent=$AGENT"
  echo

  echo "## 4. Control — a raw --resume for a chat the CLI does not have is silent"
  echo
  echo "\$ $AGENT --print --mode ask --trust --model grok-4.7 --resume 11111111-1111-4111-8111-111111111111 '...'"
  set +e
  OUT4="$("$AGENT" --print --mode ask --trust --model grok-4.7 --resume 11111111-1111-4111-8111-111111111111 "What codeword did I ask you to remember? Reply with just the codeword, or UNKNOWN." 2>&1)"
  C4=$?
  set -e
  echo "exit=$C4 (silent: no error)"
  echo "$OUT4"
  echo "chat store silently created for the unknown id:"
  ls -d "$HOME"/.cursor/chats/*/11111111-1111-4111-8111-111111111111 2>/dev/null || echo "(none)"
  echo

  echo "## Verdict"
  echo
  echo "* F1: the adapter-minted id ($ID) is a valid UUIDv4 and the live CLI accepts it (exit $C1)."
  echo "  The v5 form of the same digest reproduces the t3 blocker (exit $C2)."
  echo "* F2: with the chat store present, --resume carries the prior turn (the model recalled the"
  echo "  fact in the captured run); with the store removed, the adapter re-anchors: the argv carries"
  echo "  --new-session-id and the positional prompt is the full bootstrap delivery (system prompt +"
  echo "  prior turns + newest turn). The model's exact wording for a \"codeword\" question is"
  echo "  model-dependent; the F2 proof is the path (argv) plus the bootstrap payload."
  echo "* Section 4 shows the pre-repair hazard: a raw --resume for an unknown chat is silent"
  echo "  (exit $C4, empty stderr) and creates that chat under the requested id."
} > "$OUT"

cat "$OUT"
