// Stop hook — backstop only, never the gate. Reconciles the ledger; if the
// session cap is exceeded, returns {"decision":"block"} so the agent gets one
// more chance to stop cleanly. After 8 consecutive Stop blocks Claude
// overrides, so this must never be relied on as the enforcement point.
// Honors stop_hook_active: exit 0 immediately when true.

import { loadConfig, formatUsd } from "../config";
import { readSessionLedger } from "../ledger";
import { readStdinJson, emit, reconcile } from "./common";

async function main(): Promise<void> {
  const input = await readStdinJson();
  if (input.stop_hook_active) {
    emit({});
  }
  const result = reconcile(input);
  const config = loadConfig();
  // If no transcript was available to reconcile from, fall back to the
  // existing ledger so the backstop still fires on recorded spend.
  const sessionCost =
    result?.ledger.totals.costUsd ??
    (input.session_id ? readSessionLedger(input.session_id)?.totals.costUsd : undefined);
  if (sessionCost !== undefined && sessionCost >= config.sessionCapUsd) {
    emit({
      decision: "block",
      reason:
        `AgentFuse: session cap ${formatUsd(config.sessionCapUsd)} exceeded ` +
        `(${formatUsd(sessionCost)} spent). Stop and summarize; ` +
        `do not make further tool calls.`,
    });
  }
  emit({});
}

main().catch((err) => {
  console.error(`AgentFuse Stop: ${err}`);
  emit({});
});
