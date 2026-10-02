#!/usr/bin/env bun
/** bun / tsx example. Same deny JSON as deny.sh. Run: bun .cursor/hooks/deny.ts */
const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
void chunks
process.stdout.write(JSON.stringify({
  permission: 'deny',
  agent_message: 'fixture bun/tsx hook denied this tool',
}))
