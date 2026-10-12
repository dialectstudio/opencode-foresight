import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type ForesightConfig } from "./config.js";
import {
  createHooks,
  createPluginState,
  makeSessionMessageReader,
  normalizeSessionMessages,
  type PluginState,
  type SystemPart,
} from "./hooks.js";
import {
  makeTmpStore,
  silentLogger,
  mockReader,
  mockSessionContext,
} from "./test-helpers.js";
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

/** A system prompt starting from a single base section, as V2 supplies it. */
function baseSystem(): SystemPart[] {
  return [{ type: "text", text: "You are a helpful agent." }];
}

describe("normalizeSessionMessages", () => {
  it("maps V2 user and assistant messages to role/content records", () => {
    const raw = [
      { type: "user", text: "hello" },
      { type: "assistant", content: [{ type: "text", text: "hi there" }] },
    ];
    expect(normalizeSessionMessages(raw)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("joins multiple assistant text parts and drops non-conversation entries", () => {
    const raw = [
      { type: "system", text: "system noise" },
      { type: "user", text: "question" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "tool", tool: "bash" },
          { type: "text", text: "second" },
        ],
      },
    ];
    expect(normalizeSessionMessages(raw)).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "first\nsecond" },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeSessionMessages(undefined)).toEqual([]);
    expect(normalizeSessionMessages("nope")).toEqual([]);
  });
});

describe("session context hook", () => {
  it("injects recalled memories into system[0]", async () => {
    store.add({ content: "The repo uses pnpm workspaces", kind: "fact", tags: ["tooling"], metadata: {} });
    const hooks = createHooks(store, makeConfig(), state, mockReader([]), silentLogger());

    const system = baseSystem();
    await hooks.recallIntoSystem("s1", system);

    expect(system[0].text).toContain("You are a helpful agent.");
    expect(system[0].text).toContain("<foresight_memories>");
    expect(system[0].text).toContain("pnpm workspaces");
  });

  it("unshifts a text section when the system prompt is empty", async () => {
    store.add({ content: "Uses vitest", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(store, makeConfig(), state, mockReader([]), silentLogger());

    const system: SystemPart[] = [];
    await hooks.recallIntoSystem("s1", system);

    expect(system).toHaveLength(1);
    expect(system[0].type).toBe("text");
    expect(system[0].text).toContain("<foresight_memories>");
  });

  it("only injects once per session", async () => {
    store.add({ content: "Deployment uses GitHub Actions", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(store, makeConfig(), state, mockReader([]), silentLogger());

    const system = baseSystem();
    await hooks.recallIntoSystem("s1", system);
    await hooks.recallIntoSystem("s1", system);

    const count = system[0].text.split("<foresight_memories>").length - 1;
    expect(count).toBe(1);
  });

  it("retries a new session separately", async () => {
    store.add({ content: "Uses vitest", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(store, makeConfig(), state, mockReader([]), silentLogger());

    const first = baseSystem();
    await hooks.recallIntoSystem("s1", first);
    const second = baseSystem();
    await hooks.recallIntoSystem("s2", second);

    expect(first[0].text).toContain("<foresight_memories>");
    expect(second[0].text).toContain("<foresight_memories>");
  });

  it("does nothing when autoRecall is disabled", async () => {
    store.add({ content: "Uses vitest", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(store, makeConfig({ autoRecall: false }), state, mockReader([]), silentLogger());

    const system = [{ type: "text", text: "base" }];
    await hooks.recallIntoSystem("s1", system);
    expect(system[0].text).toBe("base");
  });

  it("leaves system untouched when the store is empty", async () => {
    const hooks = createHooks(store, makeConfig(), state, mockReader([]), silentLogger());
    const system = [{ type: "text", text: "base" }];
    await hooks.recallIntoSystem("s1", system);
    expect(system[0].text).toBe("base");
  });

  it("includes the mission when configured", async () => {
    store.add({ content: "Uses vitest", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(
      store,
      makeConfig({ mission: "TypeScript monorepo" }),
      state,
      mockReader([]),
      silentLogger()
    );
    const system = [{ type: "text", text: "base" }];
    await hooks.recallIntoSystem("s1", system);
    expect(system[0].text).toContain("Project mission: TypeScript monorepo");
  });

  it("builds the recall query from a V2 session context payload", async () => {
    store.add({ content: "Staging database credentials live in 1Password", kind: "fact", tags: [], metadata: {} });
    const hooks = createHooks(
      store,
      makeConfig(),
      state,
      makeSessionMessageReader(
        mockSessionContext([{ role: "user", text: "where are the staging credentials?" }])
      ),
      silentLogger()
    );

    const system = baseSystem();
    await hooks.recallIntoSystem("s1", system);
    expect(system[0].text).toContain("<foresight_memories>");
    expect(system[0].text).toContain("1Password");
  });
});

describe("session.idle event", () => {
  const conversation = [
    { role: "user", text: "Remember that staging uses a separate database" },
    { role: "assistant", text: "Noted, staging uses a separate database." },
    { role: "user", text: "Next, wire up the CI pipeline" },
    { role: "assistant", text: "CI pipeline configured with GitHub Actions." },
    { role: "user", text: "Add a lint step too" },
    { role: "assistant", text: "Lint step added to CI." },
  ];

  const idleEvent = { type: "session.idle", data: { sessionID: "s1" } };

  it("retains the transcript after retainEveryNTurns turns", async () => {
    const hooks = createHooks(
      store,
      makeConfig({ retainEveryNTurns: 3 }),
      state,
      mockReader(conversation),
      silentLogger()
    );

    await hooks.handleEvent(idleEvent);
    const entries = store.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("transcript");
    expect(entries[0].content).toContain("staging uses a separate database");
  });

  it("accepts the V1-style properties payload as a fallback", async () => {
    const hooks = createHooks(
      store,
      makeConfig({ retainEveryNTurns: 3 }),
      state,
      mockReader(conversation),
      silentLogger()
    );

    await hooks.handleEvent({ type: "session.idle", properties: { sessionID: "s1" } });
    expect(store.load()).toHaveLength(1);
  });

  it("skips retain until enough new turns accumulate", async () => {
    const hooks = createHooks(
      store,
      makeConfig({ retainEveryNTurns: 3 }),
      state,
      mockReader(conversation),
      silentLogger()
    );

    await hooks.handleEvent(idleEvent);
    // No new turns since the last retain → upsert, not duplicate
    await hooks.handleEvent(idleEvent);
    expect(store.load()).toHaveLength(1);
  });

  it("ignores other event types", async () => {
    const hooks = createHooks(store, makeConfig(), state, mockReader(conversation), silentLogger());
    await hooks.handleEvent({ type: "session.updated", data: { sessionID: "s1" } });
    expect(store.load()).toHaveLength(0);
  });

  it("ignores a session.idle event without a sessionID", async () => {
    const hooks = createHooks(store, makeConfig(), state, mockReader(conversation), silentLogger());
    await hooks.handleEvent({ type: "session.idle", data: {} });
    expect(store.load()).toHaveLength(0);
  });

  it("does not retain when autoRetain is disabled", async () => {
    const hooks = createHooks(
      store,
      makeConfig({ autoRetain: false }),
      state,
      mockReader(conversation),
      silentLogger()
    );
    await hooks.handleEvent(idleEvent);
    expect(store.load()).toHaveLength(0);
  });
});

describe("compaction hook", () => {
  it("retains the conversation and injects recalled context", async () => {
    store.add({ content: "Release process tags versions with changesets", kind: "fact", tags: [], metadata: {} });

    const hooks = createHooks(
      store,
      makeConfig(),
      state,
      mockReader([
        { role: "user", text: "how do we cut a release?" },
        { role: "assistant", text: "We use changesets to tag versions." },
      ]),
      silentLogger()
    );

    const system: SystemPart[] = [{ type: "text", text: "summarized history" }];
    await hooks.retainBeforeCompaction("s1", system);

    expect(system).toHaveLength(2);
    expect(system[1].text).toContain("<foresight_memories>");

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
      mockReader([{ role: "user", text: "where is state stored?" }]),
      silentLogger()
    );

    const system: SystemPart[] = [];
    await hooks.retainBeforeCompaction("s1", system);
    expect(system).toHaveLength(1);
    expect(store.load().filter((e) => e.kind === "transcript")).toHaveLength(0);
  });
});
