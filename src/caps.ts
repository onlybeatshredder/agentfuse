// Cap / loop / subagent evaluation. Pure functions over ledger state so the
// hook and the tests share exactly the same decision logic.
// Checks run in order: daily cap, session cap, loop, subagent cap.
// AgentFuse hooks NEVER emit an "allow" decision — they either deny or exit
// 0 printing {} (no opinion).

import type { AgentFuseConfig } from "./config";
import type { SessionLedger, DailyLedger } from "./ledger";
import { toolSignature } from "./transcript";

export interface Trip {
  kind: "daily-cap" | "session-cap" | "loop" | "subagent-cap" | "self-protection";
  reason: string;
}

/** How to raise a cap, appended to every deny reason. */
export const RAISE_HINT =
  "To raise it, edit ~/.agentfuse/config.json or run `fuse status` to review caps.";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Evaluate caps against ledger state. `nextTool` is the tool about to run
 * (for loop + subagent checks); pass null to evaluate cost caps only.
 */
export function evaluateCaps(
  config: AgentFuseConfig,
  session: SessionLedger | null,
  daily: DailyLedger | null,
  nextTool: { toolName: string; toolInput: unknown } | null,
): Trip | null {
  const dailyCost = daily?.costUsd ?? 0;
  if (dailyCost >= config.dailyCapUsd) {
    return {
      kind: "daily-cap",
      reason:
        `AgentFuse: daily cap ${money(config.dailyCapUsd)} reached ` +
        `(${money(dailyCost)} spent). Stop and summarize; do not retry tool calls. ${RAISE_HINT}`,
    };
  }

  const sessionCost = session?.totals.costUsd ?? 0;
  if (sessionCost >= config.sessionCapUsd) {
    return {
      kind: "session-cap",
      reason:
        `AgentFuse: session cap ${money(config.sessionCapUsd)} reached ` +
        `(${money(sessionCost)} spent in this session). Stop and summarize; do not retry tool calls. ${RAISE_HINT}`,
    };
  }

  if (nextTool && session) {
    const sig = toolSignature(nextTool.toolName, nextTool.toolInput);
    const consecutive =
      sig === session.lastToolSignature ? session.consecutiveCount + 1 : 1;
    if (consecutive >= config.loopThreshold) {
      return {
        kind: "loop",
        reason:
          `AgentFuse: loop detected — ${nextTool.toolName} with identical input ` +
          `repeated ${consecutive} times consecutively (threshold ${config.loopThreshold}). ` +
          `Stop and summarize; do not retry the same call. ${RAISE_HINT}`,
      };
    }

    if (
      (nextTool.toolName === "Agent" || nextTool.toolName === "Task") &&
      session.totals.subagentSpawns >= config.maxSubagentsPerSession
    ) {
      return {
        kind: "subagent-cap",
        reason:
          `AgentFuse: subagent cap reached — ${session.totals.subagentSpawns} subagents ` +
          `spawned in this session (max ${config.maxSubagentsPerSession}). ` +
          `Continue without spawning more subagents. ${RAISE_HINT}`,
      };
    }
  }

  return null;
}

/**
 * Self-protection: deny Write/Edit attempts targeting Claude settings or
 * AgentFuse's own config/ledger, so a runaway agent cannot disable the
 * circuit breaker. Only matches those exact paths — nothing else.
 */
export function selfProtectionTrip(toolName: string, toolInput: unknown): Trip | null {
  if (toolName !== "Write" && toolName !== "Edit") return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const filePath = (toolInput as Record<string, unknown>).file_path;
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replace(/\\/g, "/");
  const isSettingsJson =
    normalized.endsWith("/settings.json") &&
    (normalized.includes("/.claude/") || normalized.endsWith(".claude/settings.json"));
  const isAgentFuse =
    normalized.includes("/.agentfuse/") || normalized.endsWith(".agentfuse");
  if (!isSettingsJson && !isAgentFuse) return null;
  return {
    kind: "self-protection",
    reason:
      `AgentFuse: blocked ${toolName} to ${filePath} — AgentFuse and Claude ` +
      `settings are protected so a runaway agent cannot disable its own circuit breaker.`,
  };
}
