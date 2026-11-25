// PostToolUse hook: re-parse the transcript (+ subagent files), recompute
// session totals, update the ledger (toolCalls, lastToolSignature /
// consecutiveCount, subagentSpawns). Exit 0 printing {}. Never throws to
// stdout; on any error, log to stderr and exit 0.

import { readStdinJson, emit, reconcile } from "./common";

async function main(): Promise<void> {
  const input = await readStdinJson();
  try {
    reconcile(input);
  } catch (err) {
    console.error(`AgentFuse PostToolUse: ${err}`);
  }
  emit({});
}

main().catch((err) => {
  console.error(`AgentFuse PostToolUse: ${err}`);
  emit({});
});
