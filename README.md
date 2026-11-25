# AgentFuse

A local-only cost circuit breaker for Claude Code. It watches what your
sessions actually cost, and vetoes the next tool call when a cap trips —
before a runaway agent burns another dollar.

Thesis in five lines:

1. Claude Code agents can loop, spawn subagents, and burn tokens with no
   built-in spend limit; the bill (or the subscription's fair-use patience)
   is the only brake.
2. The transcript already records every token — AgentFuse prices it from
   Anthropic's public price list and keeps the running total on disk.
3. A PreToolUse hook reads that ledger and denies the next call the moment
   a daily cap, session cap, loop, or subagent cap trips.
4. Everything runs locally: no network, no accounts, no credentials, no
   subscription login routed anywhere. Hooks can only deny, never allow.
5. It is a circuit breaker, not a cage — caps are yours to raise, and the
   tool tells you exactly how.

## Install

```bash
npm install
npm run build
node dist/cli.js init        # or `npm link` / link the bin, then `fuse init`
```

`fuse init` creates `~/.agentfuse/config.json` with defaults (never
overwrites an existing config) and merges four hooks into
`~/.claude/settings.json` without clobbering your existing hooks or
settings. It warns if `claude` is missing or older than 2.1.295
(`onFailure: "block"` needs >= 2.1.295) but does not fail.

Requires Node >= 20. Zero runtime dependencies; TypeScript +
`@types/node` are dev-only.

## Usage

```bash
fuse status                  # today's spend, caps, trips
fuse report                  # today's per-session breakdown
fuse report --date 2026-11-25
fuse report --all
```

## Config reference (`~/.agentfuse/config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `dailyCapUsd` | `5` | Max API-equivalent spend per local day across all sessions. |
| `sessionCapUsd` | `2` | Max API-equivalent spend per session. |
| `loopThreshold` | `5` | Identical tool call (same `tool_name` + stable-stringified `tool_input`) repeated this many times consecutively trips the loop breaker. |
| `maxSubagentsPerSession` | `3` | Max `Agent`/`Task` spawns per session. |
| `cacheWriteTtl` | `"1h"` | Cache-write price tier: `"1h"` (subscription sessions) or `"5m"` (API-key sessions). |
| `prices` | (full table) | `$` per 1M tokens per model: `input`, `output`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`. Override any model; unknown models fall back to Sonnet 5.5 rates and are flagged `estimated/unknown-model` in the ledger. |

Prices are from Anthropic's official pricing page, read 2026-11-25.
For Pro/Max/Ultra subscription users the dollar figure is an
API-equivalent estimate, not a real bill — the CLI and README say so
wherever dollars appear.

## How caps and loop detection work

- **Ledger** (`~/.agentfuse/ledger/`): per-session `<session-id>.json` plus
  a daily aggregate `daily-YYYY-MM-DD.json`. Writes are atomic (temp file
  + rename).
- **PostToolUse** re-parses the session transcript (plus
  `<session-id>/subagents/*.jsonl`), recomputes totals, and rewrites the
  ledger. **PreToolUse reads the ledger only** — never re-parses per tool
  call — so the gate stays fast. SessionStart and Stop reconcile too.
- **Deny behavior:** PreToolUse exits 0 and prints exactly one JSON object
  with `permissionDecision: "deny"` and a reason stating the cap, the
  current spend/count, and how to raise it
  (`~/.agentfuse/config.json` or `fuse status`). Checks run in order:
  daily cap, session cap, loop, subagent cap. Hooks never emit `"allow"`.
  A Write/Edit to `**/settings.json` or `**/.agentfuse/**` is also denied
  (self-protection, so a runaway agent cannot disable its own breaker).
- **Stop** is a backstop only: if the session cap is exceeded it returns
  `{"decision": "block"}`; after 8 consecutive Stop blocks Claude
  overrides, so Stop is never the enforcement point. It honors
  `stop_hook_active` (exits 0 immediately when true).
- **SessionStart** warns via `additionalContext` when today's spend is
  already >= 80% of the daily cap.

### Dedup (load-bearing)

One API response is recorded as several transcript lines repeating the
identical usage object. Naive summation overcounts ~1.9–2.2x. AgentFuse
counts each `message.id` once and takes the max `output_tokens` across
duplicate lines. Each line is priced by its own `message.model` (the model
can change mid-session). Totals are validated against `costUSD` when the
transcript carries it; discrepancies are recorded in the ledger, not
silently fixed.

## Test evidence

`npm test` (build + `node --test`): **17 tests, 17 pass, 0 fail.**

- Dedup: duplicate `message.id` lines counted once; naive sum $0.61 vs
  deduped $0.29 (~2.1x overcount proven).
- Pricing: mixed Sonnet 5.5 + Haiku 5.5 per-line pricing; `costUSD`
  cross-check; unknown model at Sonnet 5.5 rates + flagged; Haiku 5.5
  switches to the >100k-token row for large prompts.
- Loop: same Bash command 6x consecutively fires at threshold 5; a
  different 5th call resets the streak; a tool_use block riding on a
  duplicate line of the same response is still counted (regression test —
  the parser used to scan tool_use blocks only on first-seen message.ids,
  which dropped calls in the common text-then-tool_use shape and blinded
  loop detection).
- Caps: daily-over + session-over denies daily-cap first; session-over
  alone denies session-cap; under both caps allows; subagent cap at 3
  denies, at 2 allows.
- Self-protection: Write/Edit to settings.json and `.agentfuse` denied;
  normal paths unaffected.
- CLI: `fuse status` / `fuse report` against a fixture ledger show the
  correct dollar/token figures; empty ledger says so plainly.
- Hook end-to-end: fabricated PreToolUse stdin + over-cap fixture ledger
  yields exactly the deny JSON on stdout, exit code 0, no `"allow"`;
  under-cap yields `{}`; Stop honors `stop_hook_active` and blocks an
  over-cap session.

Fixtures under `test/fixtures/` are fabricated test data, marked as such
in a header comment on each file.

Additionally verified by hand in a sandbox `$HOME` (no real `~/.claude`
on this machine): `fuse init` creates config + settings with all four
hooks, is idempotent on re-run, and warns that `claude` is not installed;
a fabricated transcript (1.5M Sonnet input + a subagent transcript with
0.5M input, one line duplicated) reconciled by PostToolUse to a $4.20
ledger, after which PreToolUse denied the next call with the session-cap
reason, `fuse status` showed $4.20 / 84% of the daily cap with 1 cap trip,
and SessionStart emitted the 80% warning.

## Known limitations

- **Transcript lag:** the transcript file lags the live conversation.
  PreToolUse can only block the *next* call — the call that crossed the
  cap is already paid for.
- **Fail-open without `onFailure: "block"`:** on Claude Code older than
  2.1.295, a hook timeout/crash/invalid JSON fails open. The registration
  sets `onFailure: "block"` and a 10s timeout; upgrade Claude Code to
  close the gap.
- **Bypassable by design:** `--bare`, `disableAllHooks`, editing or
  deleting settings, or removing `~/.agentfuse` all bypass the breaker.
  This is a guardrail for your own sessions, not a sandbox.
- **Subscription dollars are estimates:** API-equivalent figures from list
  prices, not a bill.
- **Skill-injected shell commands bypass PreToolUse** (known gap;
  PreSkillShellCommand is not registered yet).
- **Dedup key choice:** `message.id` is the dedup key. An unresolved
  counter-claim exists that `uuid` may be the more correct key; if
  transcripts ever show the same `message.id` for genuinely distinct API
  responses, totals would undercount — watch for it.
- **Stop-hook fallback:** when no transcript is available, Stop falls back
  to the on-disk ledger; if the ledger is also missing it fails open.

## What's next

- Phase 2: persistent cross-tool policy (one policy file enforced for
  Claude Code, Codex, Cursor, Gemini), a real sandbox for shell execution,
  and a kill switch.
- Phase 3: Codex / Cursor / Gemini adapters reusing the same ledger and
  pricing core.

## License & support

AgentFuse is open source under the MIT License — see LICENSE. The local
engine is free forever; a paid cloud tier (policy sync across machines,
teams, hosted sandbox) comes later.

If it saves you money, tip the builder: https://cash.app/$beatshredder
