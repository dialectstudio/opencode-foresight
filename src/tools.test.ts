import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./config.js";
import { createTools } from "./tools.js";
import { makeTmpStore, silentLogger } from "./test-helpers.js";
import { MemoryStore } from "./store.js";
import type { MemoryStore as MemoryStoreType } from "./store.js";
import type { ToolContext } from "@opencode-ai/plugin/tool";

let store: MemoryStoreType;
let cleanup: () => void;

beforeEach(() => {
  const tmp = makeTmpStore();
  store = tmp.store;
  cleanup = tmp.cleanup;
  delete process.env.FORESIGHT_MISSION;
});

afterEach(() => cleanup());

function toolContext(sessionID = "s1"): ToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as ToolContext;
}

describe("foresight_retain", () => {
  it("stores a fact retrievable via search", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    const result = await tools.foresight_retain.execute(
      { content: "Naming convention: files use kebab-case", tags: ["convention"] },
      toolContext()
    );
    expect(result).toBe("Memory stored successfully.");

    const entries = store.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("fact");
    expect(entries[0].tags).toEqual(["convention"]);
    expect(entries[0].sessionId).toBe("s1");
    expect(entries[0].metadata.source).toBe("explicit");
  });

  it("appends rather than replaces", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    await tools.foresight_retain.execute({ content: "first memory" }, toolContext());
    await tools.foresight_retain.execute({ content: "second memory" }, toolContext());
    expect(store.load()).toHaveLength(2);
  });
});

describe("foresight_recall", () => {
  beforeEach(() => {
    const tools = createTools(store, loadConfig(), silentLogger());
    return tools.foresight_retain.execute(
      { content: "CI runs on GitHub Actions with a pnpm cache", tags: ["ci"] },
      toolContext()
    );
  });

  it("returns formatted matches", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    const result = await tools.foresight_recall.execute({ query: "ci pipeline pnpm" }, toolContext());
    const text = typeof result === "string" ? result : result.output;
    expect(text).toContain("Found 1 relevant memories");
    expect(text).toContain("GitHub Actions");
  });

  it("reports when nothing is remembered", async () => {
    const emptyTools = createTools(
      new MemoryStore("/tmp/foresight-does-not-exist/memories.jsonl"),
      loadConfig(),
      silentLogger()
    );
    const result = await emptyTools.foresight_recall.execute({ query: "anything" }, toolContext());
    expect(result).toBe("No relevant memories found.");
  });
});

describe("foresight_reflect", () => {
  it("assembles a digest grouped by kind", async () => {
    const tools = createTools(store, loadConfig({ mission: "Keep tests green" }), silentLogger());
    store.add({ content: "We decided to drop lodash", kind: "fact", tags: ["deps"], metadata: {} });
    store.add({
      content: "[role: user]\nrefactor the utils module\n[user:end]",
      kind: "transcript",
      tags: [],
      metadata: {},
      sessionId: "past-session",
    });

    const result = await tools.foresight_reflect.execute(
      { query: "what decisions did we make about dependencies and refactors?" },
      toolContext()
    );
    const text = typeof result === "string" ? result : result.output;

    expect(text).toContain("Project mission: Keep tests green");
    expect(text).toContain("## Decisions and facts");
    expect(text).toContain("drop lodash");
    expect(text).toContain("## Prior conversation context");
    expect(text).toContain("refactor the utils module");
    expect(text).toContain("Topics: deps");
  });

  it("handles an empty store gracefully", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    const result = await tools.foresight_reflect.execute({ query: "anything" }, toolContext());
    expect(result).toBe("No relevant memories found to reflect on.");
  });
});
