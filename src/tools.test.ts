import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./config.js";
import { createTools, type ForesightTool } from "./tools.js";
import { makeTmpStore, silentLogger } from "./test-helpers.js";
import { MemoryStore } from "./store.js";
import type { MemoryStore as MemoryStoreType } from "./store.js";

let store: MemoryStoreType;
let cleanup: () => void;

beforeEach(() => {
  const tmp = makeTmpStore();
  store = tmp.store;
  cleanup = tmp.cleanup;
  delete process.env.FORESIGHT_MISSION;
});

afterEach(() => cleanup());

/** Look up a tool by name, as the V2 `ctx.tool.transform` editor does. */
function toolNamed(tools: ForesightTool[], name: string): ForesightTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

function toolContext(sessionID = "s1"): { sessionID: string } {
  return { sessionID };
}

describe("tool registration", () => {
  it("registers the three foresight tools with JSON Schema inputs", () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    expect(tools.map((t) => t.name)).toEqual([
      "foresight_retain",
      "foresight_recall",
      "foresight_reflect",
    ]);
    for (const tool of tools) {
      expect(tool.input.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
    expect(toolNamed(tools, "foresight_retain").input.required).toEqual(["content"]);
    expect(toolNamed(tools, "foresight_recall").input.required).toEqual(["query"]);
  });
});

describe("foresight_retain", () => {
  it("stores a fact retrievable via search", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    const result = await toolNamed(tools, "foresight_retain").execute(
      { content: "Naming convention: files use kebab-case", tags: ["convention"] },
      toolContext()
    );
    expect(result.content).toBe("Memory stored successfully.");

    const entries = store.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("fact");
    expect(entries[0].tags).toEqual(["convention"]);
    expect(entries[0].sessionId).toBe("s1");
    expect(entries[0].metadata.source).toBe("explicit");
  });

  it("appends rather than replaces", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    const retain = toolNamed(tools, "foresight_retain");
    await retain.execute({ content: "first memory" }, toolContext());
    await retain.execute({ content: "second memory" }, toolContext());
    expect(store.load()).toHaveLength(2);
  });
});

describe("foresight_recall", () => {
  beforeEach(async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    await toolNamed(tools, "foresight_retain").execute(
      { content: "CI runs on GitHub Actions with a pnpm cache", tags: ["ci"] },
      toolContext()
    );
  });

  it("returns formatted matches", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    const result = await toolNamed(tools, "foresight_recall").execute(
      { query: "ci pipeline pnpm" },
      toolContext()
    );
    expect(result.content).toContain("Found 1 relevant memories");
    expect(result.content).toContain("GitHub Actions");
  });

  it("reports when nothing is remembered", async () => {
    const emptyTools = createTools(
      new MemoryStore("/tmp/foresight-does-not-exist/memories.jsonl"),
      loadConfig(),
      silentLogger()
    );
    const result = await toolNamed(emptyTools, "foresight_recall").execute(
      { query: "anything" },
      toolContext()
    );
    expect(result.content).toBe("No relevant memories found.");
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

    const result = await toolNamed(tools, "foresight_reflect").execute(
      { query: "what decisions did we make about dependencies and refactors?" },
      toolContext()
    );

    expect(result.content).toContain("Project mission: Keep tests green");
    expect(result.content).toContain("## Decisions and facts");
    expect(result.content).toContain("drop lodash");
    expect(result.content).toContain("## Prior conversation context");
    expect(result.content).toContain("refactor the utils module");
    expect(result.content).toContain("Topics: deps");
  });

  it("handles an empty store gracefully", async () => {
    const tools = createTools(store, loadConfig(), silentLogger());
    const result = await toolNamed(tools, "foresight_reflect").execute(
      { query: "anything" },
      toolContext()
    );
    expect(result.content).toBe("No relevant memories found to reflect on.");
  });
});
