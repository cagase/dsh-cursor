#!/bin/bash
# Verifier-owned stand-in for the Cursor `agent` CLI (t3 round 1, refreshed for
# the t6/t8 repaired contract).
#
# It is NOT a product deliverable: it exists so the built adapter can be driven
# end-to-end offline, with the exact argv it really spawns recorded, while the
# stdout comes from a captured live fixture.
#
# It enforces the two LIVE rules by default (t3 round 1 proved both):
#   * `--new-session-id <id>` requires a UUIDv4, else exit 1 with
#     'Error: Invalid --new-session-id "<id>": expected a UUIDv4.'
#   * `--resume <id>` for an id the store does not have exits 0, prints nothing
#     on stderr, and silently opens a FRESH chat that adopts that id.
#
# Env contract (all set by fixtures/live/verifier-t3.mjs):
#   VERIFIER_ARGV_LOG     append one JSON array per invocation (the real argv)
#   VERIFIER_STATE_LOG    append one JSON object of session-store facts
#   VERIFIER_MODELS       catalog body served for `--list-models` (models.txt)
#   VERIFIER_REPLAY       fixture file replayed as the stream-json stdout
#   VERIFIER_CHATS_DIR    chat-store root (mirrors CURSOR_CHATS_DIR)
#   VERIFIER_REQUIRE_UUID4 1 (default) enforces the live UUIDv4 rule; 0 disables
#   VERIFIER_MODE         normal | fail-resume | session-in-use | echo | invalid-session-id
#   VERIFIER_RACE_DELETE_RESUME 1 = delete the chat store entry at spawn time
#                         (simulates deletion inside the probe->spawn window)
#   VERIFIER_EXIT         exit code for the turn invocation (default 0)
#   VERIFIER_STDERR       text emitted on stderr for the turn invocation
set -u

LOG="${VERIFIER_ARGV_LOG:-/dev/null}"
node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\n")' -- "$@" >> "$LOG"

for arg in "$@"; do
  case "$arg" in
    status)
      printf '%s\n' '{"status":"authenticated","isAuthenticated":true,"authId":"verifier-fake@example.com","tier":"Ultra"}'
      exit 0
      ;;
    --list-models|models)
      cat "${VERIFIER_MODELS:?}"
      exit 0
      ;;
  esac
done

# --- the CLI's own chat store (one level under the root, opaque hash dir) -----
CHATS_DIR="${VERIFIER_CHATS_DIR:-${CURSOR_CHATS_DIR:-}}"
STORE_WS="verifier-ws"
flag_value() {
  local want="$1"; shift
  local prev=""
  for arg in "$@"; do
    if [ "$prev" = "$want" ]; then printf '%s' "$arg"; return 0; fi
    prev="$arg"
  done
  return 1
}
NEW_ID="$(flag_value --new-session-id "$@" || true)"
RESUME_ID="$(flag_value --resume "$@" || true)"
UUID4_RE='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

store_path() { printf '%s/%s/%s' "$CHATS_DIR" "$STORE_WS" "$1"; }
store_has() { [ -n "$CHATS_DIR" ] && [ -d "$(store_path "$1")" ]; }
store_add() { mkdir -p "$(store_path "$1")"; }

: > "${VERIFIER_STATE_LOG:-/dev/null}.tmp" 2>/dev/null || true
state() {
  local json="$1"
  if [ -n "${VERIFIER_STATE_LOG:-}" ]; then
    printf '%s\n' "$json" >> "$VERIFIER_STATE_LOG"
  fi
}

# --- the live UUIDv4 rule (on by default; the legacy isolation checks opt out)
if [ "${VERIFIER_REQUIRE_UUID4:-1}" = "1" ]; then
  if [ -n "$NEW_ID" ] && ! [[ "$NEW_ID" =~ $UUID4_RE ]]; then
    printf 'Error: Invalid --new-session-id "%s": expected a UUIDv4.\n' "$NEW_ID" >&2
    state "{\"kind\":\"new\",\"id\":\"$NEW_ID\",\"accepted\":false,\"reason\":\"not-uuid4\"}"
    exit 1
  fi
fi
if [ "${VERIFIER_MODE:-normal}" = "invalid-session-id" ] && [ -n "$NEW_ID" ]; then
  printf 'Error: Invalid --new-session-id "%s": expected a UUIDv4.\n' "$NEW_ID" >&2
  state "{\"kind\":\"new\",\"id\":\"$NEW_ID\",\"accepted\":false,\"reason\":\"forced\"}"
  exit 1
fi

# --- single-use ids: a second --new-session-id for a stored chat collides ----
if [ "${VERIFIER_MODE:-normal}" = "session-in-use" ] && [ -n "$NEW_ID" ]; then
  printf '%s\n' 'Error: Session ID "verifier" is already in use.' >&2
  state "{\"kind\":\"new\",\"id\":\"$NEW_ID\",\"accepted\":false,\"reason\":\"already-in-use\"}"
  exit 1
fi
if [ -n "$NEW_ID" ] && store_has "$NEW_ID"; then
  printf 'Error: Session ID "%s" is already in use.\n' "$NEW_ID" >&2
  state "{\"kind\":\"new\",\"id\":\"$NEW_ID\",\"accepted\":false,\"reason\":\"already-in-use\"}"
  exit 1
fi

# --- a --resume the store cannot satisfy: exit 0, silent adoption -------------
RESUME_FOUND="n/a"
if [ -n "$RESUME_ID" ]; then
  if [ "${VERIFIER_RACE_DELETE_RESUME:-0}" = "1" ] && store_has "$RESUME_ID"; then
    rm -rf "$(store_path "$RESUME_ID")"
    state "{\"kind\":\"resume\",\"id\":\"$RESUME_ID\",\"found\":true,\"raceDeleted\":true}"
    RESUME_FOUND="deleted-at-spawn"
  elif store_has "$RESUME_ID"; then
    RESUME_FOUND="true"
    state "{\"kind\":\"resume\",\"id\":\"$RESUME_ID\",\"found\":true,\"raceDeleted\":false}"
  else
    RESUME_FOUND="false"
    state "{\"kind\":\"resume\",\"id\":\"$RESUME_ID\",\"found\":false,\"raceDeleted\":false}"
  fi
  store_add "$RESUME_ID"
fi
if [ -n "$NEW_ID" ]; then
  store_add "$NEW_ID"
  state "{\"kind\":\"new\",\"id\":\"$NEW_ID\",\"accepted\":true,\"reason\":\"created\"}"
fi

if [ "${VERIFIER_MODE:-normal}" = "fail-resume" ] && [ -n "$RESUME_ID" ] && [ "$RESUME_FOUND" = "true" ]; then
  printf '%s\n' 'Error: Session not found' >&2
  exit 1
fi
if [ "${VERIFIER_MODE:-normal}" = "echo" ]; then
  # Emit the plugin-authored positional prompt back as a `user` echo plus an
  # init `system` event, exactly like the real CLI does (capture §7), so the
  # harness can prove none of that text reaches the consumer.
  PROMPT="${*: -1}"
  node -e '
    const prompt = process.argv[1];
    const out = [
      { type: "system", subtype: "init", session_id: "fixture-session", model: "Grok 4.7 256K Extra High", permissionMode: "default" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, session_id: "fixture-session" },
      { type: "tool_call", subtype: "started", session_id: "fixture-session", tool_call: { shellToolCall: { args: { command: "echo dsh-tool-ok" } } } },
      { type: "tool_call", subtype: "completed", session_id: "fixture-session" },
      { type: "thinking", subtype: "delta", session_id: "fixture-session", text: "THINKING-ONLY-MARKER" },
      { type: "thinking", subtype: "completed", session_id: "fixture-session" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "VISIBLE-ASSISTANT-MARKER" }] }, session_id: "fixture-session" },
      { type: "result", subtype: "success", is_error: false, result: "VISIBLE-ASSISTANT-MARKER", session_id: "fixture-session" }
    ];
    for (const o of out) process.stdout.write(JSON.stringify(o) + "\n");
  ' "$PROMPT"
  exit "${VERIFIER_EXIT:-0}"
fi

if [ -n "${VERIFIER_STDERR:-}" ]; then
  printf '%s\n' "$VERIFIER_STDERR" >&2
fi
if [ -n "${VERIFIER_REPLAY:-}" ]; then
  cat "$VERIFIER_REPLAY"
fi
exit "${VERIFIER_EXIT:-0}"
