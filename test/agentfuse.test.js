// AgentFuse tests — run with `npm test` (node:test + node:assert).
// Fixtures under test/fixtures/ are FABRICATED test data, not real usage.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const FIXTURES = path.join(__dirname, "fixtures");

const { parseTranscript, toolSignature } = require(path.join(DIST, "transcript.js"));
const { evaluateCaps, selfProtectionTrip } = require(path.join(DIST, "caps.js"));
const { loadConfig, DEFAULT_CONFIG } = require(path.join(DIST, "config.js"));

function approx(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentfuse-test-"));
  fs.mkdirSync(path.join(dir, ".agentfuse", "ledger"), { recursive: true });
  return dir;
}

// --- Transcript dedup + pricing -------------------------------------------

test("dedup: duplicate message.id lines counted once; naive sum would be ~2.1x", () => {
  const parsed = parseTranscript(path.join(FIXTURES, "session-dedup.jsonl"), DEFAULT_CONFIG);
  // Deduped totals (hand-computed in the fixture header).
  assert.equal(parsed.lines.length, 3);
  assert.equal(parsed.totals.inputTokens, 17000);
  assert.equal(parsed.totals.outputTokens, 3500);
  assert.equal(parsed.totals.cacheCreationTokens, 51000);
  assert.equal(parsed.totals.cacheReadTokens, 300000);
  approx(parsed.totals.costUsd, 0.29065);

  // Naive sum over raw lines (what a buggy parser would produce).
  let naive = 0;
  for (const rawLine of fs.readFileSync(path.join(FIXTURES, "session-dedup.jsonl"), "utf8").split("\n")) {
    if (!rawLine.trim() || rawLine.startsWith("//")) continue;
    const obj = JSON.parse(rawLine);
    if (obj.type !== "assistant" || !obj.message?.usage) continue;
    const u = obj.message.usage;
    const isHaiku = obj.message.model.includes("haiku");
    naive +=
      (u.input_tokens * (isHaiku ? 0.1 : 2) +
        (u.cache_creation_input_tokens ?? 0) * (isHaiku ? 0.2 : 4) +
        (u.cache_read_input_tokens ?? 0) * (isHaiku ? 0.01 : 0.1) +
        u.output_tokens * (isHaiku ? 0.5 : 10)) /
      1_000_000;
  }
  approx(naive, 0.61065);
  assert.ok(naive / parsed.totals.costUsd > 2, "naive sum must be >2x the deduped total");
});

test("pricing: mixed models priced per line; costUSD cross-check recorded", () => {
  const parsed = parseTranscript(path.join(FIXTURES, "session-dedup.jsonl"), DEFAULT_CONFIG);
  const byModel = Object.fromEntries(parsed.perModel.map((m) => [m.model, m]));
  approx(byModel["claude-sonnet-5-5-20251101"].costUsd, 0.29);
  approx(byModel["claude-haiku-5-5-20251101"].costUsd, 0.00065);
  // costUSD lines present: 0.26 + 0.0007 = 0.2607 reported (msg-2 has none).
  approx(parsed.reportedCostUsd, 0.2607);
  assert.ok(parsed.reportedCostDiscrepancy !== null);
  assert.ok(Math.abs(parsed.reportedCostDiscrepancy) < 0.05);
});

test("pricing: unknown model priced at Sonnet 5.5 rates and flagged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentfuse-unknown-"));
  const file = path.join(tmp, "s.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "assistant",
      message: {
        id: "u-1",
        model: "claude-mystery-99-20250101",
        usage: { input_tokens: 1000000, output_tokens: 0 },
      },
    }) + "\n",
  );
  const parsed = parseTranscript(file, DEFAULT_CONFIG);
  assert.deepEqual(parsed.unknownModels, ["claude-mystery-99-20250101"]);
  approx(parsed.totals.costUsd, 2.0); // 1M input tokens * $2/MTok (Sonnet 5.5)
});

test("pricing: Haiku 5.5 switches to the >100k-token row for large prompts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentfuse-haiku-"));
  const file = path.join(tmp, "s.jsonl");
  const line = (id, input) =>
    JSON.stringify({
      type: "assistant",
      message: { id, model: "claude-haiku-5-5-20251101", usage: { input_tokens: input, output_tokens: 0 } },
    });
  fs.writeFileSync(file, line("h-small", 50000) + "\n" + line("h-large", 150000) + "\n");
  const parsed = parseTranscript(file, DEFAULT_CONFIG);
  // 50k * $0.10 + 150k * $0.50 = $0.005 + $0.075 = $0.08
  approx(parsed.totals.costUsd, 0.08);
});

// --- Loop detection --------------------------------------------------------

test("loop: same Bash command 6x consecutively -> fires at threshold 5", () => {
  const parsed = parseTranscript(path.join(FIXTURES, "session-loop.jsonl"), DEFAULT_CONFIG);
  assert.equal(parsed.toolCalls, 6);
  assert.equal(parsed.consecutiveCount, 6);
  assert.equal(parsed.lastToolSignature, toolSignature("Bash", { command: "sleep 1" }));

  const session = {
    totals: { costUsd: 0.01, subagentSpawns: 0 },
    lastToolSignature: parsed.lastToolSignature,
    consecutiveCount: parsed.consecutiveCount,
  };
  const trip = evaluateCaps(DEFAULT_CONFIG, session, { costUsd: 0.01 }, {
    toolName: "Bash",
    toolInput: { command: "sleep 1" },
  });
  assert.ok(trip, "loop trip expected");
  assert.equal(trip.kind, "loop");
  assert.match(trip.reason, /loop detected/);
  assert.match(trip.reason, /threshold 5/);
});

test("loop: a different 5th call resets the streak", () => {
  const session = {
    totals: { costUsd: 0.01, subagentSpawns: 0 },
    lastToolSignature: toolSignature("Bash", { command: "sleep 1" }),
    consecutiveCount: 4,
  };
  const trip = evaluateCaps(DEFAULT_CONFIG, session, { costUsd: 0.01 }, {
    toolName: "Bash",
    toolInput: { command: "ls" },
  });
  assert.equal(trip, null);
});

test("loop: tool_use on a duplicate line of the same response still counts (regression)", () => {
  // Real transcript shape: one API response = several lines sharing a
  // message.id — a text line first, then the tool_use line. The usage
  // dedups (counted once) but the tool call must still be counted, or loop
  // detection goes blind on the common text-then-tool_use shape.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentfuse-dup-tool-"));
  const file = path.join(tmp, "s.jsonl");
  const line = (id, content) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        model: "claude-sonnet-5-5-20251101",
        usage: { input_tokens: 100, output_tokens: 10 },
        content,
      },
    });
  const toolUse = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 1" } };
  const lines = [
    line("m1", [{ type: "text", text: "working" }]),
    line("m1", [toolUse]),
    line("m2", [toolUse]),
    line("m3", [toolUse]),
    line("m4", [toolUse]),
    line("m5", [toolUse]),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const parsed = parseTranscript(file, DEFAULT_CONFIG);
  assert.equal(parsed.lines.length, 5, "usage still deduped to one line per message.id");
  assert.equal(parsed.toolCalls, 5, "tool_use on the duplicate line must be counted");
  assert.equal(parsed.consecutiveCount, 5);
  assert.equal(parsed.lastToolSignature, toolSignature("Bash", { command: "sleep 1" }));
});

// --- Cap scenarios ---------------------------------------------------------

function ledgerLike({ sessionCost, dailyCost, subagents = 0, sig = null, streak = 0 }) {
  return {
    session: {
      totals: { costUsd: sessionCost, subagentSpawns: subagents },
      lastToolSignature: sig,
      consecutiveCount: streak,
    },
    daily: { costUsd: dailyCost },
  };
}

test("caps: session over sessionCap and daily over dailyCap -> daily-cap deny first", () => {
  const { session, daily } = ledgerLike({ sessionCost: 2.5, dailyCost: 5.5 });
  const trip = evaluateCaps(DEFAULT_CONFIG, session, daily, { toolName: "Bash", toolInput: {} });
  assert.ok(trip);
  assert.equal(trip.kind, "daily-cap");
  assert.match(trip.reason, /daily cap \$5\.00 reached \(\$5\.50 spent\)/);
  assert.match(trip.reason, /raise it/);
});

test("caps: session over cap but daily under -> session-cap deny", () => {
  const { session, daily } = ledgerLike({ sessionCost: 2.5, dailyCost: 1.0 });
  const trip = evaluateCaps(DEFAULT_CONFIG, session, daily, { toolName: "Bash", toolInput: {} });
  assert.ok(trip);
  assert.equal(trip.kind, "session-cap");
  assert.match(trip.reason, /session cap \$2\.00 reached \(\$2\.50 spent in this session\)/);
});

test("caps: under both caps -> no trip", () => {
  const { session, daily } = ledgerLike({ sessionCost: 1.0, dailyCost: 1.0 });
  assert.equal(evaluateCaps(DEFAULT_CONFIG, session, daily, { toolName: "Bash", toolInput: {} }), null);
});

test("caps: subagent spawn at max -> deny; below max -> allow", () => {
  const { session, daily } = ledgerLike({ sessionCost: 0.1, dailyCost: 0.1, subagents: 3 });
  const trip = evaluateCaps(DEFAULT_CONFIG, session, daily, { toolName: "Agent", toolInput: {} });
  assert.ok(trip);
  assert.equal(trip.kind, "subagent-cap");
  assert.match(trip.reason, /3 subagents/);
  const under = ledgerLike({ sessionCost: 0.1, dailyCost: 0.1, subagents: 2 });
  assert.equal(
    evaluateCaps(DEFAULT_CONFIG, under.session, under.daily, { toolName: "Agent", toolInput: {} }),
    null,
  );
});

// --- Self-protection -------------------------------------------------------

test("self-protection: Write/Edit to settings.json and .agentfuse denied; normal paths fine", () => {
  assert.ok(selfProtectionTrip("Write", { file_path: "/home/u/.claude/settings.json" }));
  assert.ok(selfProtectionTrip("Edit", { file_path: "/home/u/.agentfuse/config.json" }));
  assert.ok(selfProtectionTrip("Write", { file_path: "/home/u/.agentfuse/ledger/x.json" }));
  assert.equal(selfProtectionTrip("Write", { file_path: "/home/u/proj/settings.json" }), null);
  assert.equal(selfProtectionTrip("Write", { file_path: "/home/u/proj/app.ts" }), null);
  assert.equal(selfProtectionTrip("Bash", { command: "rm -rf ~/.agentfuse" }), null);
});

// --- CLI against a fixture ledger ------------------------------------------

function writeFixtureLedger(home) {
  const ledgerDir = path.join(home, ".agentfuse", "ledger");
  fs.mkdirSync(ledgerDir, { recursive: true });
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const session = {
    sessionId: "abcdef01-1234-5678-90ab-cdef01234567",
    date,
    totals: {
      inputTokens: 17000,
      outputTokens: 3500,
      cacheCreationTokens: 51000,
      cacheReadTokens: 300000,
      costUsd: 0.29065,
      toolCalls: 4,
      subagentSpawns: 1,
    },
    perModel: [
      {
        model: "claude-sonnet-5-5-20251101",
        inputTokens: 15000,
        outputTokens: 3000,
        cacheCreationTokens: 50000,
        cacheReadTokens: 300000,
        costUsd: 0.29,
        lines: 2,
        unknownModel: false,
      },
      {
        model: "claude-haiku-5-5-20251101",
        inputTokens: 2000,
        outputTokens: 500,
        cacheCreationTokens: 1000,
        cacheReadTokens: 0,
        costUsd: 0.00065,
        lines: 1,
        unknownModel: false,
      },
    ],
    trips: { capTrips: 0, loopTrips: 0 },
    lastToolSignature: null,
    consecutiveCount: 0,
    unknownModels: [],
    reportedCostUsd: 0.2607,
    reportedCostDiscrepancy: 0.02995,
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ledgerDir, `${session.sessionId}.json`), JSON.stringify(session));
  fs.writeFileSync(
    path.join(ledgerDir, `daily-${date}.json`),
    JSON.stringify({
      date,
      costUsd: 0.29065,
      inputTokens: 17000,
      outputTokens: 3500,
      sessions: [session.sessionId],
      capTrips: 0,
      loopTrips: 0,
      lastUpdated: new Date().toISOString(),
    }),
  );
  return { date, sessionId: session.sessionId };
}

test("cli: fuse status and fuse report against a fixture ledger show correct figures", () => {
  const home = makeTempHome();
  const { sessionId } = writeFixtureLedger(home);
  const env = { ...process.env, HOME: home };

  const status = execFileSync("node", [path.join(DIST, "cli.js"), "status"], { encoding: "utf8", env });
  assert.match(status, /\$0\.29/);
  assert.match(status, /daily cap \$5\.00/);
  assert.match(status, /Sessions today: 1/);
  assert.match(status, new RegExp(sessionId.slice(0, 8)));

  const report = execFileSync("node", [path.join(DIST, "cli.js"), "report"], { encoding: "utf8", env });
  assert.match(report, /claude-sonnet-5-5-20251101/);
  assert.match(report, /claude-haiku-5-5-20251101/);
  assert.match(report, /input 17000/);
  assert.match(report, /output 3500/);
  assert.match(report, /cache write 51000/);
  assert.match(report, /cache read 300000/);
  assert.match(report, /Tool calls 4/);
  assert.match(report, /subagent spawns 1/);
  assert.match(report, /Total: \$0\.29/);
});

test("cli: fuse status/report with no ledger data say so plainly", () => {
  const home = makeTempHome();
  const env = { ...process.env, HOME: home };
  const status = execFileSync("node", [path.join(DIST, "cli.js"), "status"], { encoding: "utf8", env });
  assert.match(status, /No sessions recorded today yet/);
  const report = execFileSync("node", [path.join(DIST, "cli.js"), "report"], { encoding: "utf8", env });
  assert.match(report, /No ledger data/);
});

// --- Hook end-to-end -------------------------------------------------------

test("hook e2e: PreToolUse with a fixture ledger over cap emits exactly the deny JSON, exit 0", () => {
  const home = makeTempHome();
  const { sessionId } = writeFixtureLedger(home);
  // Push both ledgers over their caps.
  const ledgerDir = path.join(home, ".agentfuse", "ledger");
  const sessionPath = path.join(ledgerDir, `${sessionId}.json`);
  const s = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  s.totals.costUsd = 2.5;
  fs.writeFileSync(sessionPath, JSON.stringify(s));
  const today = s.date;
  const dailyPath = path.join(ledgerDir, `daily-${today}.json`);
  const d = JSON.parse(fs.readFileSync(dailyPath, "utf8"));
  d.costUsd = 5.5;
  fs.writeFileSync(dailyPath, JSON.stringify(d));

  const input = JSON.stringify({
    session_id: sessionId,
    transcript_path: "/nonexistent.jsonl",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "toolu-e2e",
  });
  const res = spawnSync("node", [path.join(DIST, "hooks", "pre-tool-use.js")], {
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0, `hook exited ${res.status}; stderr: ${res.stderr}`);
  // stdout must be exactly one JSON object, nothing else.
  assert.equal(res.stdout.trim().split("\n").length, 1);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "AgentFuse: daily cap $5.00 reached ($5.50 spent). Stop and summarize; do not retry tool calls. " +
        "To raise it, edit ~/.agentfuse/config.json or run `fuse status` to review caps.",
    },
  });
  // No "allow" anywhere in the output.
  assert.doesNotMatch(res.stdout, /"allow"/);
});

test("hook e2e: PreToolUse under cap exits 0 printing {}", () => {
  const home = makeTempHome();
  writeFixtureLedger(home);
  const sessionId = "abcdef01-1234-5678-90ab-cdef01234567";
  const input = JSON.stringify({
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  const res = spawnSync("node", [path.join(DIST, "hooks", "pre-tool-use.js")], {
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "{}");
});

test("hook e2e: Stop honors stop_hook_active and blocks an over-cap session", () => {
  const home = makeTempHome();
  const { sessionId } = writeFixtureLedger(home);
  const ledgerDir = path.join(home, ".agentfuse", "ledger");
  const sessionPath = path.join(ledgerDir, `${sessionId}.json`);
  const s = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  s.totals.costUsd = 3.0;
  fs.writeFileSync(sessionPath, JSON.stringify(s));
  // Transcript does not exist, so reconcile finds nothing and the ledger as
  // written is what Stop sees — but Stop reconciles from transcript first;
  // with no transcript it keeps the existing ledger. Feed it directly.
  const env = { ...process.env, HOME: home };

  const active = spawnSync("node", [path.join(DIST, "hooks", "stop.js")], {
    input: JSON.stringify({ session_id: sessionId, stop_hook_active: true, hook_event_name: "Stop" }),
    encoding: "utf8",
    env,
  });
  assert.equal(active.status, 0);
  assert.equal(active.stdout.trim(), "{}");

  // Over-cap session with no transcript: Stop falls back to the ledger and blocks.
  const blocked = spawnSync("node", [path.join(DIST, "hooks", "stop.js")], {
    input: JSON.stringify({ session_id: sessionId, stop_hook_active: false, hook_event_name: "Stop" }),
    encoding: "utf8",
    env,
  });
  assert.equal(blocked.status, 0);
  const blockedOut = JSON.parse(blocked.stdout);
  assert.equal(blockedOut.decision, "block");
  assert.match(blockedOut.reason, /session cap \$2\.00 exceeded \(\$3\.00 spent\)/);
});
