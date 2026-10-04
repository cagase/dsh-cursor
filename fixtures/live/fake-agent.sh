#!/bin/sh
# Deterministic stand-in for the Cursor `agent` CLI, used by scripts/verify-models.mjs.
#
# It never touches the network and never calls a model: it replays the raw captures in
# fixtures/live/ and records the argv it was spawned with, so the shim's catalog, wire
# string, transcript and argument contracts can be asserted offline.
#
# It enforces the two LIVE session rules the shipped suite previously missed (t3 F1/F3):
#   * `--new-session-id` must be a UUIDv4 (version nibble 4, RFC 4122 variant bits),
#     exactly as the live CLI validates it;
#   * a `--resume` for an id with no chat store succeeds and SILENTLY creates that chat
#     under the requested id, so a dead resume is invisible to the adapter.
#
# Environment:
#   FAKE_AGENT_DIR           fixture directory (default: this script's directory)
#   FAKE_AGENT_STREAM        JSONL transcript to replay (default: stream-json.jsonl)
#   FAKE_AGENT_ARGV_LOG      NUL-delimited argv log, rewritten on every stream call
#   FAKE_AGENT_CHATS_DIR     chat root (default: $HOME/.cursor/chats, the CLI default)
#   FAKE_AGENT_WORKSPACE_HASH  workspace hash directory (default: md5 of --workspace,
#                          else the t1 capture hash)
#   FAKE_AGENT_SESSION_BUSY  session id that reports "already in use" regardless of store
#   FAKE_AGENT_RESUME_FAIL   session id whose --resume must fail (chat no longer stored)
#   FAKE_AGENT_INVALID_SESSION_ID  session id that --new-session-id must reject (UUIDv4 rule)
#   FAKE_AGENT_STATUS        "unauthenticated" replays the captured not-logged-in status
set -e
dir="${FAKE_AGENT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
chats="${FAKE_AGENT_CHATS_DIR:-${HOME:-$dir}/.cursor/chats}"

is_uuid_v4() {
  printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
}

if [ "${1:-}" = "status" ] || [ "${1:-}" = "about" ]; then
  if [ "${FAKE_AGENT_STATUS:-}" = "unauthenticated" ]; then
    printf '%s\n' '{ "status": "unauthenticated", "isAuthenticated": false, "message": "Not logged in" }'
    printf '%s\n' 'Not logged in' >&2
    exit 0
  fi
  printf '%s\n' '{ "status": "authenticated", "isAuthenticated": true, "hasAccessToken": true }'
  exit 0
fi

if [ "${1:-}" = "--list-models" ] || [ "${1:-}" = "models" ]; then
  cat "$dir/models.txt"
  exit 0
fi

if [ -n "${FAKE_AGENT_ARGV_LOG:-}" ]; then
  : > "$FAKE_AGENT_ARGV_LOG"
  for arg in "$@"; do printf '%s\000' "$arg" >> "$FAKE_AGENT_ARGV_LOG"; done
fi

session_mode=""
session_id=""
workspace=""
previous=""
for arg in "$@"; do
  case "$previous" in
    --new-session-id)
      session_mode="new"
      session_id="$arg"
      ;;
    --resume)
      session_mode="resume"
      session_id="$arg"
      ;;
    --workspace)
      workspace="$arg"
      ;;
  esac
  previous="$arg"
done

if [ -n "${FAKE_AGENT_WORKSPACE_HASH:-}" ]; then
  hash="$FAKE_AGENT_WORKSPACE_HASH"
elif [ -n "$workspace" ]; then
  hash="$(node -e 'const {createHash}=require("node:crypto"); const {resolve}=require("node:path"); process.stdout.write(createHash("md5").update(resolve(process.argv[1])).digest("hex"))' "$workspace")"
else
  hash="766fe73c06573698c270309a02f752f8"
fi

if [ -n "$session_mode" ] && [ -n "$session_id" ]; then
  store="$chats/$hash/$session_id/store.db"
  if [ "$session_mode" = "new" ]; then
    if [ "$session_id" = "${FAKE_AGENT_INVALID_SESSION_ID:-}" ] || ! is_uuid_v4 "$session_id"; then
      printf 'Error: Invalid --new-session-id "%s": expected a UUIDv4.\n' "$session_id" >&2
      exit 1
    fi
    if [ -e "$store" ] || [ "$session_id" = "${FAKE_AGENT_SESSION_BUSY:-}" ]; then
      printf 'Error: Session ID "%s" is already in use.\n' "$session_id" >&2
      exit 1
    fi
    mkdir -p "$(dirname -- "$store")"
    printf '%s\n' 'chat' > "$store"
  else
    if [ "$session_id" = "${FAKE_AGENT_RESUME_FAIL:-}" ]; then
      printf 'Error: No session found with ID "%s".\n' "$session_id" >&2
      exit 1
    fi
    # Live behavior (t3 F2): an unknown id is adopted silently, with a fresh chat.
    if [ ! -e "$store" ]; then
      mkdir -p "$(dirname -- "$store")"
      printf '%s\n' 'chat' > "$store"
    fi
  fi
fi

cat "${FAKE_AGENT_STREAM:-$dir/stream-json.jsonl}"
exit 0
