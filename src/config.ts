/**
 * Configuration management for the Foresight OpenCode plugin.
 *
 * Loading order (later entries win):
 *   1. Built-in defaults
 *   2. User config file (~/.foresight/opencode.json)
 *   3. Plugin options (from opencode.json plugin tuple)
 *   4. Environment variable overrides
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type RecallBudget = "low" | "mid" | "high";
export type RetainMode = "full-session" | "last-turn";

export interface ForesightConfig {
  // Recall
  autoRecall: boolean;
  recallBudget: RecallBudget;
  /** 0 = derive the result limit from recallBudget. */
  recallMaxResults: number;
  recallContextTurns: number;
  recallMaxQueryChars: number;
  recallPromptPreamble: string;
  /** Per-memory character cap when formatting results for context injection. */
  recallResultMaxChars: number;

  // Retain
  autoRetain: boolean;
  retainMode: RetainMode;
  retainEveryNTurns: number;
  retainOverlapTurns: number;

  // Store
  /** Absolute path to the memory root. null → <project>/.opencode/foresight */
  memoryDir: string | null;

  // Scope
  /** Static scope ID. null → "opencode" (static) or derived (dynamic). */
  scopeId: string | null;
  /** Derive the scope ID from the project's git root / directory name. */
  dynamicScope: boolean;

  // Mission
  /** Project mission prepended to injected memory context and reflect framing. */
  mission: string;

  // Misc
  debug: boolean;
}

const DEFAULTS: ForesightConfig = {
  autoRecall: true,
  recallBudget: "mid",
  recallMaxResults: 0,
  recallContextTurns: 1,
  recallMaxQueryChars: 800,
  recallPromptPreamble:
    "Relevant memories from past sessions (prioritize recent when " +
    "conflicting). Only use memories that are directly useful to continue " +
    "this conversation; ignore the rest:",
  recallResultMaxChars: 1200,

  autoRetain: true,
  retainMode: "full-session",
  retainEveryNTurns: 3,
  retainOverlapTurns: 2,

  memoryDir: null,

  scopeId: null,
  dynamicScope: true,

  mission: "",

  debug: false,
};

/** Budget → number of memories returned per recall. */
export function budgetToLimit(config: ForesightConfig): number {
  if (config.recallMaxResults > 0) return config.recallMaxResults;
  switch (config.recallBudget) {
    case "low":
      return 4;
    case "high":
      return 16;
    default:
      return 8;
  }
}

/** Env var → config key + type mapping */
const ENV_OVERRIDES: Record<string, [keyof ForesightConfig, "string" | "bool" | "int"]> = {
  FORESIGHT_MEMORY_DIR: ["memoryDir", "string"],
  FORESIGHT_SCOPE_ID: ["scopeId", "string"],
  FORESIGHT_DYNAMIC_SCOPE: ["dynamicScope", "bool"],
  FORESIGHT_AUTO_RECALL: ["autoRecall", "bool"],
  FORESIGHT_AUTO_RETAIN: ["autoRetain", "bool"],
  FORESIGHT_RETAIN_MODE: ["retainMode", "string"],
  FORESIGHT_RECALL_BUDGET: ["recallBudget", "string"],
  FORESIGHT_RECALL_MAX_RESULTS: ["recallMaxResults", "int"],
  FORESIGHT_RECALL_MAX_QUERY_CHARS: ["recallMaxQueryChars", "int"],
  FORESIGHT_RECALL_CONTEXT_TURNS: ["recallContextTurns", "int"],
  FORESIGHT_RECALL_RESULT_MAX_CHARS: ["recallResultMaxChars", "int"],
  FORESIGHT_RETAIN_EVERY_N_TURNS: ["retainEveryNTurns", "int"],
  FORESIGHT_RETAIN_OVERLAP_TURNS: ["retainOverlapTurns", "int"],
  FORESIGHT_MISSION: ["mission", "string"],
  // NOTE: `debug` is intentionally NOT an env override — env vars are
  // unreliable to set for OpenCode's plugin runtime (notably on Windows).
};

function castEnv(value: string, typ: "string" | "bool" | "int"): string | boolean | number | null {
  if (typ === "bool") return ["true", "1", "yes"].includes(value.toLowerCase());
  if (typ === "int") {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }
  return value;
}

function loadSettingsFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function loadConfig(pluginOptions?: Record<string, unknown>): ForesightConfig {
  // 1. Start with defaults
  const config: Record<string, unknown> = { ...DEFAULTS };

  // 2. User config file (~/.foresight/opencode.json)
  const userConfigPath = join(homedir(), ".foresight", "opencode.json");
  const fileConfig = loadSettingsFile(userConfigPath);
  for (const [key, value] of Object.entries(fileConfig)) {
    if (value !== null && value !== undefined) {
      config[key] = value;
    }
  }

  // 3. Plugin options (from opencode.json: ["opencode-foresight", { ... }])
  if (pluginOptions) {
    for (const [key, value] of Object.entries(pluginOptions)) {
      if (value !== null && value !== undefined) {
        config[key] = value;
      }
    }
  }

  // 4. Environment variable overrides (highest priority)
  for (const [envName, [key, typ]] of Object.entries(ENV_OVERRIDES)) {
    const val = process.env[envName];
    if (val !== undefined) {
      const castVal = castEnv(val, typ);
      if (castVal !== null) {
        config[key] = castVal;
      }
    }
  }

  const result = config as unknown as ForesightConfig;

  // Validate enum-like fields to catch typos early
  const VALID_RETAIN_MODES: RetainMode[] = ["full-session", "last-turn"];
  if (!VALID_RETAIN_MODES.includes(result.retainMode)) {
    console.error(
      `[Foresight] Unknown retainMode "${result.retainMode}" — ` +
        `valid: ${VALID_RETAIN_MODES.join(", ")}. Falling back to "full-session".`
    );
    result.retainMode = "full-session";
  }

  const VALID_BUDGETS: RecallBudget[] = ["low", "mid", "high"];
  if (!VALID_BUDGETS.includes(result.recallBudget)) {
    console.error(
      `[Foresight] Unknown recallBudget "${result.recallBudget}" — ` +
        `valid: ${VALID_BUDGETS.join(", ")}. Falling back to "mid".`
    );
    result.recallBudget = "mid";
  }

  return result;
}
