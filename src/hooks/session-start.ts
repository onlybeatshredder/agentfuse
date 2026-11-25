// SessionStart hook: reconcile the ledger from the transcript (+ subagent
// transcripts). If today's spend is already >= 80% of the daily cap, emit a
// systemMessage warning; otherwise exit 0 printing {}.

import { loadConfig, formatUsd, todayLocal } from "../config";
import { readDailyLedger } from "../ledger";
import { readStdinJson, emit, reconcile } from "./common";

async function main(): Promise<void> {
  const input = await readStdinJson();
  reconcile(input);

  const config = loadConfig();
  const daily = readDailyLedger(todayLocal());
  const spent = daily?.costUsd ?? 0;
  if (spent >= 0.8 * config.dailyCapUsd) {
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          `AgentFuse: today's spend is ${formatUsd(spent)} — ` +
          `${Math.round((spent / config.dailyCapUsd) * 100)}% of your daily cap ` +
          `${formatUsd(config.dailyCapUsd)}. New tool calls will be blocked once the cap is reached. ` +
          `Run \`fuse status\` to review, or raise the cap in ~/.agentfuse/config.json.`,
      },
    });
  }
  emit({});
}

main().catch((err) => {
  console.error(`AgentFuse SessionStart: ${err}`);
  emit({});
});
