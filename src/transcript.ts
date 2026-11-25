// Transcript parsing — Claude Code session files at
// ~/.claude/projects/<slug>/<session-id>.jsonl
// (slug = cwd path with every non-alphanumeric byte folded to "-").
// Subagent transcripts live in <session-id>/subagents/*.jsonl.
//
// DEDUP TRAP (load-bearing): one API response is recorded as several
// transcript lines repeating the identical usage object. Naive summation
// overcounts ~1.9-2.2x. Rule: count each message.id ONCE; for output_tokens
// take the max across duplicate lines. Prices are per line by its own
// message.model (model can change mid-session). Totals are validated against
// costUSD when present; discrepancies are reported, not silently fixed.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { priceLine, resolvePrice, type ModelPrice } from "./pricing";
import type { AgentFuseConfig } from "./config";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ParsedLine {
  messageId: string;
  model: string;
  usage: Usage;
  costUsd: number;
  costUsdReported: number | null;
  unknownModel: boolean;
}

export interface ModelTotals {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  lines: number;
  unknownModel: boolean;
}

export interface ParseResult {
  lines: ParsedLine[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
  perModel: ModelTotals[];
  reportedCostUsd: number | null;
  reportedCostDiscrepancy: number | null;
  unknownModels: string[];
  toolCalls: number;
  subagentSpawns: number;
  lastToolSignature: string | null;
  consecutiveCount: number;
}

const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Stable stringify: object keys sorted recursively, so identical tool_input
 *  with different key order produces the same signature. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Tool signature used for loop detection: tool_name + stable tool_input. */
export function toolSignature(toolName: string, toolInput: unknown): string {
  return `${toolName}:${stableStringify(toolInput ?? null)}`;
}

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** Parse one .jsonl file's lines into the accumulator. */
function parseFileLines(
  filePath: string,
  byId: Map<string, ParsedLine>,
  acc: {
    toolCalls: number;
    subagentSpawns: number;
    lastToolSignature: string | null;
    consecutiveCount: number;
  },
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return; // missing/unreadable transcript: skip, do not crash the hook
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // tolerate a truncated/corrupt line
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const usageRaw = message.usage as Record<string, unknown> | undefined;
    if (!usageRaw || typeof usageRaw !== "object") continue;
    const messageId = typeof message.id === "string" ? message.id : null;
    if (!messageId) continue;

    const usage: Usage = {
      input_tokens: num(usageRaw.input_tokens),
      output_tokens: num(usageRaw.output_tokens),
      cache_creation_input_tokens: num(usageRaw.cache_creation_input_tokens),
      cache_read_input_tokens: num(usageRaw.cache_read_input_tokens),
    };
    const model = typeof message.model === "string" ? message.model : "unknown";
    const reported =
      typeof obj.costUSD === "number" && Number.isFinite(obj.costUSD) ? obj.costUSD : null;

    const existing = byId.get(messageId);
    if (existing) {
      // Duplicate line for the same API response: keep the first usage for
      // input/cache (identical across duplicates), take max output_tokens.
      existing.usage.output_tokens = Math.max(existing.usage.output_tokens, usage.output_tokens);
      if (reported !== null && existing.costUsdReported === null) {
        existing.costUsdReported = reported;
      }
    } else {
      byId.set(messageId, {
        messageId,
        model,
        usage,
        costUsd: 0, // priced in a second pass
        costUsdReported: reported,
        unknownModel: false,
      });
    }

    // Tool-use blocks ride on assistant lines too; count them for loop/cap
    // tracking. This scan runs on EVERY line, including duplicates: duplicate
    // lines repeat the identical usage object, not the content blocks, so
    // each tool_use block is counted exactly once. (Scanning only the first
    // line per message.id would drop tool calls whose tool_use block rides
    // on a later line of the same response — the common text-then-tool_use
    // shape — and silently break loop/subagent detection.)
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_use"
        ) {
          const b = block as Record<string, unknown>;
          const toolName = typeof b.name === "string" ? b.name : "unknown";
          acc.toolCalls += 1;
          if (SUBAGENT_TOOLS.has(toolName)) acc.subagentSpawns += 1;
          const sig = toolSignature(toolName, b.input);
          if (sig === acc.lastToolSignature) {
            acc.consecutiveCount += 1;
          } else {
            acc.lastToolSignature = sig;
            acc.consecutiveCount = 1;
          }
        }
      }
    }
  }
}

/**
 * Parse a session transcript plus its subagent transcripts, deduped by
 * message.id, and price every line. `transcriptPath` is the main session
 * .jsonl; subagent files are globbed from <session-id>/subagents/*.jsonl.
 */
export function parseTranscript(
  transcriptPath: string,
  config: AgentFuseConfig,
): ParseResult {
  const byId = new Map<string, ParsedLine>();
  const acc = { toolCalls: 0, subagentSpawns: 0, lastToolSignature: null as string | null, consecutiveCount: 0 };

  parseFileLines(transcriptPath, byId, acc);

  // Subagent transcripts: <dir>/<session-id>/subagents/*.jsonl
  const dir = path.dirname(transcriptPath);
  const base = path.basename(transcriptPath, ".jsonl");
  const subDir = path.join(dir, base, "subagents");
  try {
    for (const entry of fs.readdirSync(subDir)) {
      if (entry.endsWith(".jsonl")) parseFileLines(path.join(subDir, entry), byId, acc);
    }
  } catch {
    // no subagent dir: fine
  }

  const lines: ParsedLine[] = [];
  const perModelMap = new Map<string, ModelTotals>();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  let reportedSum = 0;
  let reportedSeen = false;
  const unknownModels = new Set<string>();

  for (const line of byId.values()) {
    const totalInput =
      line.usage.input_tokens + line.usage.cache_creation_input_tokens + line.usage.cache_read_input_tokens;
    const { price, unknown } = resolvePrice(line.model, config.prices, totalInput);
    line.unknownModel = unknown;
    if (unknown) unknownModels.add(line.model);
    line.costUsd = priceLine(line.usage, price, config.cacheWriteTtl);
    lines.push(line);

    totals.inputTokens += line.usage.input_tokens;
    totals.outputTokens += line.usage.output_tokens;
    totals.cacheCreationTokens += line.usage.cache_creation_input_tokens;
    totals.cacheReadTokens += line.usage.cache_read_input_tokens;
    totals.costUsd += line.costUsd;

    if (line.costUsdReported !== null) {
      reportedSum += line.costUsdReported;
      reportedSeen = true;
    }

    const mt = perModelMap.get(line.model) ?? {
      model: line.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      lines: 0,
      unknownModel: unknown,
    };
    mt.inputTokens += line.usage.input_tokens;
    mt.outputTokens += line.usage.output_tokens;
    mt.cacheCreationTokens += line.usage.cache_creation_input_tokens;
    mt.cacheReadTokens += line.usage.cache_read_input_tokens;
    mt.costUsd += line.costUsd;
    mt.lines += 1;
    perModelMap.set(line.model, mt);
  }

  const reportedCostUsd = reportedSeen ? reportedSum : null;
  const reportedCostDiscrepancy =
    reportedCostUsd !== null ? totals.costUsd - reportedCostUsd : null;

  return {
    lines,
    totals,
    perModel: [...perModelMap.values()],
    reportedCostUsd,
    reportedCostDiscrepancy,
    unknownModels: [...unknownModels],
    toolCalls: acc.toolCalls,
    subagentSpawns: acc.subagentSpawns,
    lastToolSignature: acc.lastToolSignature,
    consecutiveCount: acc.consecutiveCount,
  };
}

/** Slug for a cwd: every non-alphanumeric byte folded to "-". */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Locate a session transcript file from session_id + cwd. */
export function transcriptPathFor(sessionId: string, cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", slugForCwd(cwd), `${sessionId}.jsonl`);
}

export function emptyUsage(): Usage {
  return { ...EMPTY_USAGE };
}

export type { ModelPrice };
