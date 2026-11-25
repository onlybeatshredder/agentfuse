// AgentFuse pricing — Anthropic official pricing page, read 2026-11-25.
// All prices are $ per 1,000,000 tokens.
// Cache multipliers: 5-min write 1.25x base input, 1-hour write 2x base input;
// cache read 0.1x base input on most models, 0.05x on Opus 5.5 / Sonnet 5.5,
// 0.025x on Fable 5.1 / 5.2.
// NOTE: for Pro/Max/Ultra subscription users the dollar figure is an
// API-equivalent estimate, not a real bill.

export interface ModelPrice {
  input: number; // $/MTok
  output: number; // $/MTok
  cacheWrite5m: number; // $/MTok
  cacheWrite1h: number; // $/MTok
  cacheRead: number; // $/MTok
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // Fable 5.2: in $8, out $40, 5m $10, 1h $16, read $0.20
  "claude-fable-5-2": { input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 },
  // Opus 5.5: in $4, out $20, 5m $5, 1h $8, read $0.20
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  // Sonnet 5.5: in $2, out $10, 5m $2.50, 1h $4, read $0.10
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  // Haiku 5.5 (<=100k-token prompts): in $0.10, out $0.50, 5m $0.125, 1h $0.20, read $0.01
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
  // Haiku 5.5 (>100k-token prompts): in $0.50, out $2.50, 5m $0.625, 1h $1, read $0.05
  "claude-haiku-5-5-large": { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
  // Mythos 5.2: in $8, out $40, 5m $10, 1h $16, read $0.20
  "claude-mythos-5-2": { input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 },
  // Fable 5.1 / Mythos 5.1 / Fable 5: in $10, out $50, 5m $12.50, 1h $20, read $0.25
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  // Opus 5 / 4.8 / 4.7 / 4.6 / 4.5: in $5, out $25, 5m $6.25, 1h $10, read $0.50
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  // Opus 4.1 / Opus 4: in $15, out $75, 5m $18.75, 1h $30, read $1.50
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  // Sonnet 5 (legacy): in $2, out $10, 5m $2.50, 1h $4, read $0.20
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  // Sonnet 4.6 / 4.5 / 4: in $3, out $15, 5m $3.75, 1h $6, read $0.30
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  // Haiku 4.5: in $1, out $5, 5m $1.25, 1h $2, read $0.10
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
};

/** Fallback price for an unknown model id: Sonnet 5.5 rates, flagged as estimated. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = DEFAULT_PRICES["claude-sonnet-5-5"]!;

/**
 * Resolve a transcript model string (e.g. "claude-sonnet-5-5-20251101") to a
 * price row. Matching is prefix-based on the family key, longest match wins.
 * Haiku 5.5 switches to the >100k-token row when the line's total input
 * (input + cache creation + cache read) exceeds 100,000 tokens.
 */
export function resolvePrice(
  model: string,
  prices: Record<string, ModelPrice>,
  totalInputTokens: number,
): { price: ModelPrice; unknown: boolean } {
  let bestKey = "";
  for (const key of Object.keys(prices)) {
    if (key === "claude-haiku-5-5-large") continue; // handled by the size rule below
    if (model.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  if (bestKey === "claude-haiku-5-5" && totalInputTokens > 100_000) {
    const large = prices["claude-haiku-5-5-large"];
    if (large) return { price: large, unknown: false };
  }
  if (bestKey) return { price: prices[bestKey]!, unknown: false };
  return { price: UNKNOWN_MODEL_PRICE, unknown: true };
}

/** Cost in USD for one deduped transcript line. */
export function priceLine(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  price: ModelPrice,
  cacheWriteTtl: "5m" | "1h",
): number {
  const cacheWritePrice = cacheWriteTtl === "1h" ? price.cacheWrite1h : price.cacheWrite5m;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * price.input +
      cacheCreation * cacheWritePrice +
      cacheRead * price.cacheRead +
      usage.output_tokens * price.output) /
    1_000_000
  );
}
