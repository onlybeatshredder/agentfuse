// PreToolUse hook — the gate. Reads the ledger ONLY (never re-parses the
// transcript per tool call, so the hot path stays fast).
// Checks in order: self-protection, daily cap, session cap, loop, subagent cap.
// Deny = exit 0 + exactly one deny JSON object on stdout. No trip = exit 0
// printing {}. Never emits an "allow" decision.

import { loadConfig, todayLocal } from "../config";
import { readSessionLedger, readDailyLedger, recordTrip } from "../ledger";
import { evaluateCaps, selfProtectionTrip } from "../caps";
import { readStdinJson, emit, emitDeny } from "./common";

async function main(): Promise<void> {
  const input = await readStdinJson();
  const config = loadConfig();

  const selfTrip = selfProtectionTrip(input.tool_name ?? "", input.tool_input);
  if (selfTrip) {
    emitDeny(selfTrip.reason);
  }

  const sessionId = input.session_id;
  const session = sessionId ? readSessionLedger(sessionId) : null;
  const daily = readDailyLedger(todayLocal());

  const trip = evaluateCaps(
    config,
    session,
    daily,
    input.tool_name
      ? { toolName: input.tool_name, toolInput: input.tool_input }
      : null,
  );

  if (trip) {
    if (sessionId) {
      recordTrip(sessionId, trip.kind === "loop" ? "loopTrips" : "capTrips");
    }
    console.error(`AgentFuse: blocked ${input.tool_name ?? "?"} — ${trip.kind}`);
    emitDeny(trip.reason);
  }

  emit({});
}

main().catch((err) => {
  // Fail-open on unexpected error (onFailure:"block" + short timeout in the
  // hook registration is what closes this gap on Claude Code >= 2.1.295).
  console.error(`AgentFuse PreToolUse error: ${err}`);
  emit({});
});
