import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, tokenize } from "./store.js";
import { makeTmpStore } from "./test-helpers.js";

let store: MemoryStore;
let cleanup: () => void;

beforeEach(() => {
  const tmp = makeTmpStore();
  store = tmp.store;
  cleanup = tmp.cleanup;
});

afterEach(() => cleanup());

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Hello, World! 123")).toEqual(["hello", "world", "123"]);
  });

  it("drops stopwords and short tokens", () => {
    expect(tokenize("the test of a it")).toEqual(["test"]);
  });
});

describe("MemoryStore persistence", () => {
  it("returns [] for a store with no file", () => {
    expect(store.load()).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("adds and reloads entries", () => {
    store.add({
      content: "Uses vitest for testing",
      kind: "fact",
      tags: ["testing"],
      metadata: { source: "explicit" },
    });
    const reloaded = new MemoryStore(store.filePath).load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].content).toBe("Uses vitest for testing");
    expect(reloaded[0].kind).toBe("fact");
    expect(reloaded[0].tags).toEqual(["testing"]);
  });

  it("upserts by id instead of duplicating", () => {
    store.upsert({ id: "session-1", content: "first", kind: "transcript", tags: [], metadata: {} });
    store.upsert({ id: "session-1", content: "second", kind: "transcript", tags: [], metadata: {} });
    const entries = store.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("second");
    // createdAt is preserved across upserts
    const created = entries[0].createdAt;
    store.upsert({ id: "session-1", content: "third", kind: "transcript", tags: [], metadata: {} });
    expect(store.load()[0].createdAt).toBe(created);
  });

  it("skips corrupt lines instead of failing", () => {
    writeFileSync(store.filePath, '{"id":"a","content":"ok","kind":"fact","tags":[],"metadata":{}}\nnot-json\n');
    const entries = store.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("ok");
  });
});

describe("MemoryStore.search", () => {
  it("ranks term matches above unrelated memories", () => {
    store.add({ content: "The project uses pnpm workspaces", kind: "fact", tags: ["tooling"], metadata: {} });
    store.add({ content: "Deploy targets AWS Lambda", kind: "fact", tags: ["deploy"], metadata: {} });
    store.add({ content: "Frontend built with Vite and React", kind: "fact", tags: ["frontend"], metadata: {} });

    const results = store.search("pnpm workspace setup", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("pnpm");
  });

  it("respects the limit", () => {
    for (let i = 0; i < 10; i++) {
      store.add({ content: `memory about topic ${i}`, kind: "fact", tags: [], metadata: {} });
    }
    expect(store.search("topic", 3)).toHaveLength(3);
  });

  it("falls back to recent memories when nothing matches", () => {
    store.add({ content: "old fact", kind: "fact", tags: [], metadata: {}, createdAt: daysAgo(30) });
    store.add({ content: "recent fact", kind: "fact", tags: [], metadata: {}, createdAt: daysAgo(1) });

    const results = store.search("zzzzunmatchablezzzz", 1);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("recent fact");
    expect(results[0].score).toBe(0);
  });

  it("boosts tag matches", () => {
    store.add({ content: "Indent with two spaces", kind: "fact", tags: ["convention"], metadata: {} });
    store.add({ content: "Indent with four spaces", kind: "fact", tags: [], metadata: {} });

    const results = store.search("convention", 5);
    expect(results[0].content).toContain("two spaces");
  });

  it("prefers newer memories of similar relevance", () => {
    store.add({ content: "database uses postgres", kind: "fact", tags: [], metadata: {}, createdAt: daysAgo(60) });
    store.add({ content: "database uses postgres", kind: "fact", tags: [], metadata: {}, createdAt: daysAgo(1) });

    const results = store.search("database postgres", 5);
    expect(results).toHaveLength(2);
    expect(Date.parse(results[0].createdAt)).toBeGreaterThan(Date.parse(results[1].createdAt));
  });

  it("returns empty for an empty store", () => {
    expect(store.search("anything", 5)).toEqual([]);
  });
});
