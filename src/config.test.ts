import { describe, it, expect, afterEach, vi } from "vitest";
import { loadConfig, budgetToLimit } from "./config.js";

const ENV_KEYS = [
  "FORESIGHT_MEMORY_DIR",
  "FORESIGHT_SCOPE_ID",
  "FORESIGHT_DYNAMIC_SCOPE",
  "FORESIGHT_AUTO_RECALL",
  "FORESIGHT_AUTO_RETAIN",
  "FORESIGHT_RETAIN_MODE",
  "FORESIGHT_RECALL_BUDGET",
  "FORESIGHT_RECALL_MAX_RESULTS",
  "FORESIGHT_RECALL_CONTEXT_TURNS",
  "FORESIGHT_RECALL_MAX_QUERY_CHARS",
  "FORESIGHT_RECALL_RESULT_MAX_CHARS",
  "FORESIGHT_RETAIN_EVERY_N_TURNS",
  "FORESIGHT_RETAIN_OVERLAP_TURNS",
  "FORESIGHT_MISSION",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

describe("loadConfig", () => {
  it("returns defaults when nothing overrides them", () => {
    clearEnv();
    const config = loadConfig();
    expect(config.autoRecall).toBe(true);
    expect(config.autoRetain).toBe(true);
    expect(config.recallBudget).toBe("mid");
    expect(config.retainMode).toBe("full-session");
    expect(config.retainEveryNTurns).toBe(3);
    expect(config.dynamicScope).toBe(true);
    expect(config.memoryDir).toBeNull();
  });

  it("applies plugin options over defaults", () => {
    clearEnv();
    const config = loadConfig({ autoRecall: false, recallBudget: "high", mission: "Ship fast" });
    expect(config.autoRecall).toBe(false);
    expect(config.recallBudget).toBe("high");
    expect(config.mission).toBe("Ship fast");
  });

  it("applies env vars over plugin options", () => {
    clearEnv();
    process.env.FORESIGHT_AUTO_RECALL = "false";
    process.env.FORESIGHT_RETAIN_EVERY_N_TURNS = "5";
    process.env.FORESIGHT_SCOPE_ID = "env-scope";
    const config = loadConfig({ autoRecall: true, retainEveryNTurns: 3 });
    expect(config.autoRecall).toBe(false);
    expect(config.retainEveryNTurns).toBe(5);
    expect(config.scopeId).toBe("env-scope");
  });

  it("coerces boolean env vars", () => {
    clearEnv();
    process.env.FORESIGHT_AUTO_RETAIN = "yes";
    expect(loadConfig().autoRetain).toBe(true);
    process.env.FORESIGHT_AUTO_RETAIN = "0";
    expect(loadConfig().autoRetain).toBe(false);
  });

  it("falls back on invalid enum values", () => {
    clearEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadConfig({ retainMode: "bogus", recallBudget: "enormous" });
    expect(config.retainMode).toBe("full-session");
    expect(config.recallBudget).toBe("mid");
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe("budgetToLimit", () => {
  it("derives limits from the budget when maxResults is unset", () => {
    clearEnv();
    expect(budgetToLimit(loadConfig({ recallBudget: "low" }))).toBe(4);
    expect(budgetToLimit(loadConfig({ recallBudget: "mid" }))).toBe(8);
    expect(budgetToLimit(loadConfig({ recallBudget: "high" }))).toBe(16);
  });

  it("honors explicit recallMaxResults", () => {
    clearEnv();
    expect(budgetToLimit(loadConfig({ recallMaxResults: 3, recallBudget: "high" }))).toBe(3);
  });
});
