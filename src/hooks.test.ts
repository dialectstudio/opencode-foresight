import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type ForesightConfig } from "./config.js";
import { createHooks, createPluginState, type PluginState } from "./hooks.js";
import { makeTmpStore, silentLogger, mockClient } from "./test-helpers.js";
import type { MemoryStore } from "./store.js";

const ENV_KEYS = ["FORESIGHT_AUTO_RECALL", "FORESIGHT_AUTO_RETAIN", "FORESIGHT_RETAIN_EVERY_N_TURNS"];

let store: MemoryStore;
let cleanup: () => void;
let state: PluginState;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  clearEnv();
  const tmp = makeTmpStore();
  store = tmp.store;
  cleanup = tmp.cleanup;
  state = createPluginState();
});

afterEach(() => cleanup());

function makeConfig(options: Record<string, unknown> = {}): ForesightConfig {
  return loadConfig(options);
}

describe("experimental.chat.system.transform", () => {
  it("injects recalled memories into system[0]", async () => {
    store.add({ content: "The repo uses pnpm workspaces", kind: "fact", tags: ["tooling"], metadata: {} });
    const hooks = createHooks(store, makeConfig(), state, mockClient([]), silentLogger());

    const output = { system: ["You are a helpful agent."] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output);

    expect(output.system[0]).toContain("You are a helpful agent.");
    expect(output.system[0]).toContain("<foresight_memories>");
    expect(output.system[0]).toContain("pnpm workspaces");
  });

  it("only injects once per session", async () => {
    store.add({ content: "Deployment uses GitHub Actions", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(store, makeConfig(), state, mockClient([]), silentLogger());

    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output);
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output);

    const count = output.system[0].split("<foresight_memories>").length - 1;
    expect(count).toBe(1);
  });

  it("retries a new session separately", async () => {
    store.add({ content: "Uses vitest", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(store, makeConfig(), state, mockClient([]), silentLogger());

    const first = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, first);
    const second = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s2", model: {} }, second);

    expect(first.system[0]).toContain("<foresight_memories>");
    expect(second.system[0]).toContain("<foresight_memories>");
  });

  it("does nothing when autoRecall is disabled", async () => {
    store.add({ content: "Uses vitest", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(store, makeConfig({ autoRecall: false }), state, mockClient([]), silentLogger());

    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output);
    expect(output.system[0]).toBe("base");
  });

  it("leaves system untouched when the store is empty", async () => {
    const hooks = createHooks(store, makeConfig(), state, mockClient([]), silentLogger());
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output);
    expect(output.system[0]).toBe("base");
  });

  it("includes the mission when configured", async () => {
    store.add({ content: "Uses vitest", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(
      store,
      makeConfig({ mission: "TypeScript monorepo" }),
      state,
      mockClient([]),
      silentLogger()
    );
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output);
    expect(output.system[0]).toContain("Project mission: TypeScript monorepo");
  });
});

describe("event (session.idle)", () => {
  const conversation = [
    { role: "user", text: "Remember that staging uses a separate database" },
    { role: "assistant", text: "Noted, staging uses a separate database." },
    { role: "user", text: "Next, wire up the CI pipeline" },
    { role: "assistant", text: "CI pipeline configured with GitHub Actions." },
    { role: "user", text: "Add a lint step too" },
    { role: "assistant", text: "Lint step added to CI." },
  ];

  it("retains the transcript after retainEveryNTurns turns", async () => {
    const hooks = createHooks(
      store,
      makeConfig({ retainEveryNTurns: 3 }),
      state,
      mockClient(conversation),
      silentLogger()
    );

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const entries = store.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("transcript");
    expect(entries[0].content).toContain("staging uses a separate database");
  });

  it("skips retain until enough new turns accumulate", async () => {
    const hooks = createHooks(
      store,
      makeConfig({ retainEveryNTurns: 3 }),
      state,
      mockClient(conversation),
      silentLogger()
    );

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    // No new turns since the last retain → upsert, not duplicate
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    expect(store.load()).toHaveLength(1);
  });

  it("ignores other event types", async () => {
    const hooks = createHooks(store, makeConfig(), state, mockClient(conversation), silentLogger());
    await hooks.event({ event: { type: "session.updated", properties: { sessionID: "s1" } } });
    expect(store.load()).toHaveLength(0);
  });

  it("does not retain when autoRetain is disabled", async () => {
    const hooks = createHooks(
      store,
      makeConfig({ autoRetain: false }),
      state,
      mockClient(conversation),
      silentLogger()
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    expect(store.load()).toHaveLength(0);
  });
});

describe("experimental.session.compacting", () => {
  it("retains the conversation and injects recalled context", async () => {
    store.add({ content: "Release process tags versions with changesets", kind: "fact", tags: [], metadata: {} });

    const hooks = createHooks(
      store,
      makeConfig(),
      state,
      mockClient([
        { role: "user", text: "how do we cut a release?" },
        { role: "assistant", text: "We use changesets to tag versions." },
      ]),
      silentLogger()
    );

    const output = { context: ["summarized history"] };
    await hooks["experimental.session.compacting"]({ sessionID: "s1" }, output);

    expect(output.context).toHaveLength(2);
    expect(output.context[1]).toContain("<foresight_memories>");

    const transcripts = store.load().filter((e) => e.kind === "transcript");
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].id).toBe("s1");
  });

  it("still injects recall even when autoRetain is off", async () => {
    store.add({ content: "Frontend state lives in zustand", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(
      store,
      makeConfig({ autoRetain: false }),
      state,
      mockClient([{ role: "user", text: "where is state stored?" }]),
      silentLogger()
    );

    const output = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: "s1" }, output);
    expect(output.context).toHaveLength(1);
    expect(store.load().filter((e) => e.kind === "transcript")).toHaveLength(0);
  });
});
