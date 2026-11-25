#!/usr/bin/env node
// AgentFuse CLI — `fuse init | status | report`.
// Local-only: reads/writes ~/.agentfuse/ and ~/.claude/settings.json.
// No network, no accounts, no credentials.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  loadConfig,
  writeConfig,
  configPath,
  agentFuseDir,
  ledgerDir,
  todayLocal,
  formatUsd,
  DEFAULT_CONFIG,
} from "./config";
import { readDailyLedger, listSessionLedgers } from "./ledger";

const VERSION = "0.1.0";

function usage(): void {
  console.log(`AgentFuse ${VERSION} — local cost circuit breaker for Claude Code
Usage:
  fuse init                          register hooks in ~/.claude/settings.json
  fuse status                        today's spend, caps, trips
  fuse report [--date YYYY-MM-DD] [--all]
                                     per-session breakdown
  fuse --help                        this help

Support the project: https://cash.app/$beatshredder — open source (MIT), tips keep it free`);
}

function hookCommand(hookFile: string): string {
  return `node "${path.join(__dirname, "hooks", hookFile)}"`;
}

interface HookEntry {
  type: "command";
  command: string;
  timeout: number;
  onFailure?: "block" | "continue";
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

function buildHookGroups(): Record<string, HookGroup[]> {
  return {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: hookCommand("pre-tool-use.js"), timeout: 10, onFailure: "block" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: hookCommand("post-tool-use.js"), timeout: 10, onFailure: "continue" }],
      },
    ],
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [{ type: "command", command: hookCommand("session-start.js"), timeout: 10 }],
      },
    ],
    Stop: [
      {
        hooks: [{ type: "command", command: hookCommand("stop.js"), timeout: 10 }],
      },
    ],
  };
}

/** Merge AgentFuse hook groups into existing settings without clobbering
 *  any existing hooks or other settings keys. */
function mergeHooks(
  settings: Record<string, unknown>,
  groups: Record<string, HookGroup[]>,
): { merged: Record<string, unknown>; added: string[]; skipped: string[] } {
  const added: string[] = [];
  const skipped: string[] = [];
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  for (const [event, newGroups] of Object.entries(groups)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event]! : [];
    for (const g of newGroups) {
      const already = existing.some(
        (e) =>
          e.matcher === g.matcher &&
          e.hooks.some((h) => h.command === g.hooks[0]!.command),
      );
      if (already) {
        skipped.push(event);
      } else {
        existing.push(g);
        added.push(event);
      }
    }
    hooks[event] = existing;
  }
  settings.hooks = hooks;
  return { merged: settings, added, skipped };
}

function claudeVersionCheck(): string {
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return `claude found (${out}) — version unparseable; onFailure:"block" needs >= 2.1.295.`;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    const need = [2, 1, 295];
    const ok = v[0] > need[0] || (v[0] === need[0] && (v[1] > need[1] || (v[1] === need[1] && v[2] >= need[2])));
    return ok
      ? `claude ${out} — OK (>= 2.1.295, onFailure:"block" supported).`
      : `WARNING: claude ${out} is older than 2.1.295 — onFailure:"block" is not supported, hooks fail open on timeout/crash. Upgrade Claude Code.`;
  } catch {
    return "WARNING: `claude` not found on PATH — hooks are registered but nothing will fire until Claude Code is installed. onFailure:\"block\" needs Claude Code >= 2.1.295.";
  }
}

function cmdInit(): void {
  fs.mkdirSync(agentFuseDir(), { recursive: true });
  fs.mkdirSync(ledgerDir(), { recursive: true });

  let configWritten = false;
  if (!fs.existsSync(configPath())) {
    writeConfig(structuredClone(DEFAULT_CONFIG));
    configWritten = true;
  }
  const config = loadConfig();

  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.mkdirSync(claudeDir, { recursive: true });
  let settings: Record<string, unknown> = {};
  let settingsExisted = false;
  if (fs.existsSync(settingsPath)) {
    settingsExisted = true;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`WARNING: ${settingsPath} is not valid JSON — leaving it untouched and aborting hook registration.`);
      process.exit(1);
    }
  }
  const { merged, added, skipped } = mergeHooks(settings, buildHookGroups());
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, settingsPath);

  console.log(`AgentFuse ${VERSION} — init
Config:   ${configPath()} ${configWritten ? "(created with defaults)" : "(already existed, kept as-is)"}
Settings: ${settingsPath} ${settingsExisted ? "(merged into existing file)" : "(created)"}
Hooks registered: ${added.length ? added.join(", ") : "none new"}${skipped.length ? ` (already present, skipped: ${[...new Set(skipped)].join(", ")})` : ""}
  PreToolUse  matcher "*"            timeout 10s onFailure block    — the gate
  PostToolUse matcher "*"            timeout 10s onFailure continue — ledger update
  SessionStart matcher startup|resume timeout 10s                    — reconcile + 80% warning
  Stop        (no matcher)           timeout 10s                    — backstop only
Caps: daily ${formatUsd(config.dailyCapUsd)}, session ${formatUsd(config.sessionCapUsd)}, ` +
    `loop threshold ${config.loopThreshold}, max subagents/session ${config.maxSubagentsPerSession}
${claudeVersionCheck()}
Edit caps in ~/.agentfuse/config.json. Check spend with: fuse status`);
}

function cmdStatus(): void {
  const config = loadConfig();
  const date = todayLocal();
  const daily = readDailyLedger(date);
  const sessions = listSessionLedgers(date);
  const spent = daily?.costUsd ?? 0;
  const pct = config.dailyCapUsd > 0 ? (spent / config.dailyCapUsd) * 100 : 0;

  console.log(`AgentFuse — status for ${date}
Today's spend: ${formatUsd(spent)} of daily cap ${formatUsd(config.dailyCapUsd)} (${pct.toFixed(0)}% used)
Sessions today: ${sessions.length}
Cap trips today: ${daily?.capTrips ?? 0}   Loop trips today: ${daily?.loopTrips ?? 0}
Session cap: ${formatUsd(config.sessionCapUsd)}   Loop threshold: ${config.loopThreshold} identical calls   Max subagents/session: ${config.maxSubagentsPerSession}`);
  if (sessions.length === 0) {
    console.log("No sessions recorded today yet.");
  } else {
    for (const s of sessions) {
      const spct = config.sessionCapUsd > 0 ? (s.totals.costUsd / config.sessionCapUsd) * 100 : 0;
      console.log(
        `  ${s.sessionId.slice(0, 8)}  ${formatUsd(s.totals.costUsd)} (${spct.toFixed(0)}% of session cap)  ` +
          `${s.totals.toolCalls} tool calls, ${s.totals.subagentSpawns} subagents, ` +
          `${s.totals.inputTokens + s.totals.cacheReadTokens + s.totals.cacheCreationTokens} in / ${s.totals.outputTokens} out tokens`,
      );
    }
  }
  console.log(
    "Note: dollar figures are API-equivalent estimates from Anthropic list prices. " +
      "For Pro/Max/Ultra subscription users they are NOT a real bill.",
  );
}

function cmdReport(args: string[]): void {
  let date: string | undefined;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") all = true;
    else if (args[i] === "--date" && args[i + 1]) date = args[++i];
    else if (args[i]?.startsWith("--date=")) date = args[i]!.slice("--date=".length);
  }
  const sessions = listSessionLedgers(all ? undefined : date ?? todayLocal());
  const label = all ? "all dates" : date ?? todayLocal();
  if (sessions.length === 0) {
    console.log(`AgentFuse — report for ${label}\nNo ledger data. No sessions recorded${all ? "" : " for this date"} yet.`);
    return;
  }
  let totalCost = 0;
  console.log(`AgentFuse — report for ${label} (${sessions.length} session${sessions.length === 1 ? "" : "s"})`);
  for (const s of sessions) {
    totalCost += s.totals.costUsd;
    console.log(`\nSession ${s.sessionId.slice(0, 8)} (${s.sessionId}) — ${s.date}`);
    console.log(
      `  Cost ${formatUsd(s.totals.costUsd)} | input ${s.totals.inputTokens} | output ${s.totals.outputTokens} | ` +
        `cache write ${s.totals.cacheCreationTokens} | cache read ${s.totals.cacheReadTokens}`,
    );
    for (const m of s.perModel) {
      console.log(
        `  Model ${m.model}${m.unknownModel ? " (unknown model — priced at Sonnet 5.5 rates, estimated)" : ""}: ` +
          `${formatUsd(m.costUsd)} over ${m.lines} response(s)`,
      );
    }
    console.log(
      `  Tool calls ${s.totals.toolCalls} | subagent spawns ${s.totals.subagentSpawns} | ` +
        `cap trips ${s.trips.capTrips} | loop trips ${s.trips.loopTrips}`,
    );
    if (s.reportedCostUsd !== null && s.reportedCostDiscrepancy !== null) {
      console.log(
        `  Transcript-reported cost ${formatUsd(s.reportedCostUsd)}; ` +
          `AgentFuse estimate differs by ${formatUsd(s.reportedCostDiscrepancy)} (pricing/rounding).`,
      );
    }
    if (s.unknownModels.length) {
      console.log(`  Unknown models flagged: ${s.unknownModels.join(", ")}`);
    }
  }
  console.log(`\nTotal: ${formatUsd(totalCost)} across ${sessions.length} session(s).`);
  console.log(
    "Note: dollar figures are API-equivalent estimates from Anthropic list prices. " +
      "For Pro/Max/Ultra subscription users they are NOT a real bill.",
  );
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      cmdInit();
      break;
    case "status":
      cmdStatus();
      break;
    case "report":
      cmdReport(rest);
      break;
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main();
