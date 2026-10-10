import { describe, it, expect } from "vitest";
import {
  stripMemoryTags,
  formatMemories,
  composeRecallQuery,
  truncateRecallQuery,
  sliceLastTurnsByUserBoundary,
  prepareRetentionTranscript,
} from "./content.js";
import { user, assistant } from "./test-helpers.js";

describe("stripMemoryTags", () => {
  it("removes foresight_memories blocks", () => {
    const input = "keep <foresight_memories>\ninjected\n</foresight_memories> this";
    expect(stripMemoryTags(input).trim()).toBe("keep  this");
  });

  it("removes relevant_memories blocks", () => {
    const input = "a<relevant_memories>x</relevant_memories>b";
    expect(stripMemoryTags(input)).toBe("ab");
  });
});

describe("formatMemories", () => {
  it("formats entries with kind and date", () => {
    const out = formatMemories([
      { content: "fact one", kind: "fact", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(out).toBe("- fact one [fact] (2026-01-01T00:00:00.000Z)");
  });

  it("truncates long content", () => {
    const out = formatMemories([{ content: "x".repeat(100) }], 10);
    expect(out).toContain("… [truncated]");
    expect(out.length).toBeLessThan(60);
  });
});

describe("sliceLastTurnsByUserBoundary", () => {
  const messages = [
    user("u1"),
    assistant("a1"),
    user("u2"),
    assistant("a2"),
    user("u3"),
    assistant("a3"),
  ];

  it("returns everything when turns exceed history", () => {
    expect(sliceLastTurnsByUserBoundary(messages, 10)).toEqual(messages);
  });

  it("slices on the user boundary", () => {
    const sliced = sliceLastTurnsByUserBoundary(messages, 2);
    expect(sliced[0]).toEqual(user("u2"));
    expect(sliced).toHaveLength(4);
  });

  it("returns empty for no messages or zero turns", () => {
    expect(sliceLastTurnsByUserBoundary([], 2)).toEqual([]);
    expect(sliceLastTurnsByUserBoundary(messages, 0)).toEqual([]);
  });
});

describe("prepareRetentionTranscript", () => {
  it("formats full window with role markers", () => {
    const { transcript, messageCount } = prepareRetentionTranscript(
      [user("hello"), assistant("hi")],
      true
    );
    expect(messageCount).toBe(2);
    expect(transcript).toContain("[role: user]");
    expect(transcript).toContain("[assistant:end]");
  });

  it("strips memory tags from the transcript", () => {
    const { transcript } = prepareRetentionTranscript(
      [user("before <foresight_memories>x</foresight_memories> after")],
      true
    );
    expect(transcript).not.toContain("foresight_memories");
  });

  it("returns null for empty input", () => {
    expect(prepareRetentionTranscript([], true).transcript).toBeNull();
  });

  it("returns null when all content is empty", () => {
    expect(prepareRetentionTranscript([user("   "), assistant("")], true).transcript).toBeNull();
  });
});

describe("composeRecallQuery", () => {
  it("returns the latest query when context turns <= 1", () => {
    expect(composeRecallQuery("what now", [user("earlier"), user("what now")], 1)).toBe("what now");
  });

  it("includes prior context for multi-turn queries", () => {
    const out = composeRecallQuery("next step", [user("we use vitest"), user("next step")], 2);
    expect(out).toContain("Prior context:");
    expect(out).toContain("user: we use vitest");
    expect(out.endsWith("next step")).toBe(true);
  });
});

describe("truncateRecallQuery", () => {
  const latest = "short latest message";

  it("passes through when under the limit", () => {
    expect(truncateRecallQuery("tiny", latest, 100)).toBe("tiny");
  });

  it("drops oldest context lines first", () => {
    const query = composeRecallQuery(
      latest,
      [user("old context one"), user("old context two"), user(latest)],
      3
    );
    const truncated = truncateRecallQuery(query, latest, 120);
    expect(truncated.length).toBeLessThanOrEqual(120);
    expect(truncated.endsWith(latest)).toBe(true);
  });

  it("falls back to the latest message when there is no context block", () => {
    const out = truncateRecallQuery("x".repeat(50), latest, 20);
    expect(out).toBe(latest);
  });
});
