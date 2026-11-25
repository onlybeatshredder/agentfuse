// Shared hook plumbing: read the hook JSON from stdin, print exactly one
// JSON object to stdout (nothing else — diagnostics go to stderr), and
// reconcile the ledger from the transcript when a transcript is available.

import * as fs from "fs";
import { loadConfig, todayLocal } from "../config";
import {
  parseTranscript,
  transcriptPathFor,
  type ParseResult,
} from "../transcript";
import {
  updateSessionLedgerFromParse,
  rebuildDailyLedger,
  type SessionLedger,
} from "../ledger";

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  stop_hook_active?: boolean;
  agent_id?: string;
  agent_type?: string;
  [key: string]: unknown;
}

export function readStdinJson(): Promise<HookInput> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(data.trim() ? (JSON.parse(data) as HookInput) : {});
      } catch (err) {
        console.error(`AgentFuse: could not parse hook input: ${err}`);
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

/** Print exactly one JSON object to stdout and exit 0. */
export function emit(obj: unknown): never {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}

/** Deny a PreToolUse call: exit 0 + the deny JSON object, nothing else. */
export function emitDeny(reason: string): never {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Reconcile the session ledger from the transcript (+ subagent transcripts).
 * Returns the updated ledger, or null when there is no transcript to read.
 * Never throws.
 */
export function reconcile(
  input: HookInput,
): { ledger: SessionLedger; parsed: ParseResult } | null {
  try {
    const config = loadConfig();
    const sessionId = input.session_id;
    if (!sessionId) return null;
    const transcriptPath =
      input.transcript_path ||
      (input.cwd ? transcriptPathFor(sessionId, input.cwd) : null);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const parsed = parseTranscript(transcriptPath, config);
    const ledger = updateSessionLedgerFromParse(sessionId, todayLocal(), parsed);
    rebuildDailyLedger(todayLocal());
    return { ledger, parsed };
  } catch (err) {
    console.error(`AgentFuse: reconcile failed: ${err}`);
    return null;
  }
}
