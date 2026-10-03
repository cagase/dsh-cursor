#!/bin/bash
# Verifier-owned (t8) argv-recording wrapper around the REAL Cursor agent CLI.
# Used only for live round-2 probes: it records the exact argv the built adapter
# spawns, then execs the real binary unchanged.
if [ -n "${VERIFIER_LIVE_ARGV_LOG:-}" ]; then
  node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\n")' -- "$@" >> "$VERIFIER_LIVE_ARGV_LOG"
fi
exec /Users/theluiscarbonell/.local/bin/agent "$@"
