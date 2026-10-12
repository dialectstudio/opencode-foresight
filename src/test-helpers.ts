import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.js";
import { Logger } from "./logger.js";
import type { Message } from "./content.js";

export function silentLogger(): Logger {
  return new Logger({ silent: true });
}

export function makeTmpStore(): { store: MemoryStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "foresight-test-"));
  const store = new MemoryStore(join(dir, "memories.jsonl"));
  return {
    store,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function user(content: string): Message {
  return { role: "user", content };
}

export function assistant(content: string): Message {
  return { role: "assistant", content };
}

/**
 * Mock session-message reader returning a fixed history.
 *
 * Mirrors the `{ role, content }` records `hooks.ts` works on; the V2
 * session-context shape is normalized separately by `normalizeSessionMessages`.
 */
export function mockReader(messages: Array<{ role: string; text: string }>) {
  return async (): Promise<Message[]> => messages.map((m) => ({ role: m.role, content: m.text }));
}

/**
 * Mock `ctx.session.context` returning a raw V2 message list, for tests that
 * exercise `normalizeSessionMessages` end to end.
 */
export function mockSessionContext(
  messages: Array<{ role: string; text: string }>
): (input: { sessionID: string }) => Promise<unknown> {
  return async () =>
    messages.map((m) =>
      m.role === "user"
        ? { type: "user", text: m.text }
        : { type: "assistant", content: [{ type: "text", text: m.text }] }
    );
}
