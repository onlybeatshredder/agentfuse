// Ledger — on-disk spend record under ~/.agentfuse/ledger/.
// Per-session <session-id>.json + daily aggregate daily-YYYY-MM-DD.json.
// All writes are atomic (temp file + rename). PreToolUse reads the ledger
// ONLY and never re-parses transcripts, so the hot path stays fast.

import * as fs from "fs";
import * as path from "path";
import { ledgerDir, todayLocal } from "./config";
import type { ParseResult } from "./transcript";

export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  toolCalls: number;
  subagentSpawns: number;
}

export interface ModelBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  lines: number;
  unknownModel: boolean;
}

export interface SessionLedger {
  sessionId: string;
  date: string;
  totals: SessionTotals;
  perModel: ModelBreakdown[];
  trips: { capTrips: number; loopTrips: number };
  lastToolSignature: string | null;
  consecutiveCount: number;
  unknownModels: string[];
  reportedCostUsd: number | null;
  reportedCostDiscrepancy: number | null;
  lastUpdated: string;
}

export interface DailyLedger {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: string[];
  capTrips: number;
  loopTrips: number;
  lastUpdated: string;
}

export function sessionLedgerPath(sessionId: string): string {
  return path.join(ledgerDir(), `${sessionId}.json`);
}

export function dailyLedgerPath(date: string): string {
  return path.join(ledgerDir(), `daily-${date}.json`);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(ledgerDir(), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readSessionLedger(sessionId: string): SessionLedger | null {
  return readJson<SessionLedger>(sessionLedgerPath(sessionId));
}

export function readDailyLedger(date: string): DailyLedger | null {
  return readJson<DailyLedger>(dailyLedgerPath(date));
}

export function emptySessionLedger(sessionId: string, date: string): SessionLedger {
  return {
    sessionId,
    date,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      toolCalls: 0,
      subagentSpawns: 0,
    },
    perModel: [],
    trips: { capTrips: 0, loopTrips: 0 },
    lastToolSignature: null,
    consecutiveCount: 0,
    unknownModels: [],
    reportedCostUsd: null,
    reportedCostDiscrepancy: null,
    lastUpdated: new Date().toISOString(),
  };
}

/** Recompute a session ledger from a fresh transcript parse. Preserves the
 *  cumulative trip counters from any previous ledger. */
export function updateSessionLedgerFromParse(
  sessionId: string,
  date: string,
  parsed: ParseResult,
): SessionLedger {
  const prev = readSessionLedger(sessionId);
  const ledger: SessionLedger = {
    sessionId,
    date,
    totals: {
      inputTokens: parsed.totals.inputTokens,
      outputTokens: parsed.totals.outputTokens,
      cacheCreationTokens: parsed.totals.cacheCreationTokens,
      cacheReadTokens: parsed.totals.cacheReadTokens,
      costUsd: parsed.totals.costUsd,
      toolCalls: parsed.toolCalls,
      subagentSpawns: parsed.subagentSpawns,
    },
    perModel: parsed.perModel.map((m) => ({
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      cacheReadTokens: m.cacheReadTokens,
      costUsd: m.costUsd,
      lines: m.lines,
      unknownModel: m.unknownModel,
    })),
    trips: prev?.trips ?? { capTrips: 0, loopTrips: 0 },
    lastToolSignature: parsed.lastToolSignature,
    consecutiveCount: parsed.consecutiveCount,
    unknownModels: parsed.unknownModels,
    reportedCostUsd: parsed.reportedCostUsd,
    reportedCostDiscrepancy: parsed.reportedCostDiscrepancy,
    lastUpdated: new Date().toISOString(),
  };
  atomicWriteJson(sessionLedgerPath(sessionId), ledger);
  return ledger;
}

/** Rebuild the daily aggregate from all per-session ledgers for that date. */
export function rebuildDailyLedger(date: string): DailyLedger {
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const sessions: string[] = [];
  let capTrips = 0;
  let loopTrips = 0;
  try {
    for (const entry of fs.readdirSync(ledgerDir())) {
      if (!entry.endsWith(".json") || entry.startsWith("daily-")) continue;
      const s = readJson<SessionLedger>(path.join(ledgerDir(), entry));
      if (!s || s.date !== date) continue;
      costUsd += s.totals.costUsd;
      inputTokens += s.totals.inputTokens;
      outputTokens += s.totals.outputTokens;
      sessions.push(s.sessionId);
      capTrips += s.trips.capTrips;
      loopTrips += s.trips.loopTrips;
    }
  } catch {
    // ledger dir missing: empty day
  }
  const daily: DailyLedger = {
    date,
    costUsd,
    inputTokens,
    outputTokens,
    sessions: sessions.sort(),
    capTrips,
    loopTrips,
    lastUpdated: new Date().toISOString(),
  };
  atomicWriteJson(dailyLedgerPath(date), daily);
  return daily;
}

/** List all per-session ledgers (optionally filtered by date). */
export function listSessionLedgers(date?: string): SessionLedger[] {
  const out: SessionLedger[] = [];
  try {
    for (const entry of fs.readdirSync(ledgerDir())) {
      if (!entry.endsWith(".json") || entry.startsWith("daily-")) continue;
      const s = readJson<SessionLedger>(path.join(ledgerDir(), entry));
      if (!s) continue;
      if (date && s.date !== date) continue;
      out.push(s);
    }
  } catch {
    // no ledger dir yet
  }
  return out.sort((a, b) => b.totals.costUsd - a.totals.costUsd);
}

/** Record a trip (cap or loop deny) against a session + today's daily aggregate. */
export function recordTrip(sessionId: string, kind: "capTrips" | "loopTrips"): void {
  const s = readSessionLedger(sessionId);
  if (s) {
    s.trips[kind] += 1;
    s.lastUpdated = new Date().toISOString();
    atomicWriteJson(sessionLedgerPath(sessionId), s);
  }
  const date = todayLocal();
  const d = readDailyLedger(date) ?? rebuildDailyLedger(date);
  if (kind === "capTrips") d.capTrips += 1;
  else d.loopTrips += 1;
  d.lastUpdated = new Date().toISOString();
  atomicWriteJson(dailyLedgerPath(date), d);
}
