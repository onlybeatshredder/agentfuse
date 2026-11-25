import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_PRICES, type ModelPrice } from "./pricing";

export type CacheWriteTtl = "5m" | "1h";

export interface AgentFuseConfig {
  dailyCapUsd: number;
  sessionCapUsd: number;
  loopThreshold: number;
  maxSubagentsPerSession: number;
  cacheWriteTtl: CacheWriteTtl;
  prices: Record<string, ModelPrice>;
}

export const DEFAULT_CONFIG: AgentFuseConfig = {
  dailyCapUsd: 5,
  sessionCapUsd: 2,
  loopThreshold: 5,
  maxSubagentsPerSession: 3,
  cacheWriteTtl: "1h",
  prices: DEFAULT_PRICES,
};

export function agentFuseDir(): string {
  return path.join(os.homedir(), ".agentfuse");
}

export function configPath(): string {
  return path.join(agentFuseDir(), "config.json");
}

export function ledgerDir(): string {
  return path.join(agentFuseDir(), "ledger");
}

/** Load config, merging over defaults so missing keys stay valid. */
export function loadConfig(): AgentFuseConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentFuseConfig>;
    const merged: AgentFuseConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      prices: { ...DEFAULT_PRICES, ...(parsed.prices ?? {}) },
    };
    if (merged.cacheWriteTtl !== "5m" && merged.cacheWriteTtl !== "1h") {
      merged.cacheWriteTtl = "1h";
    }
    return merged;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Write config atomically (temp file + rename). Never overwrites blindly. */
export function writeConfig(config: AgentFuseConfig): void {
  fs.mkdirSync(agentFuseDir(), { recursive: true });
  const tmp = configPath() + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, configPath());
}

/** Today's local date as YYYY-MM-DD. */
export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
