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

/** Mock OpenCode client returning a fixed message list. */
export function mockClient(messages: Array<{ role: string; text: string }>) {
  return {
    session: {
      messages: async () => ({
        data: messages.map((m) => ({
          info: { role: m.role },
          parts: [{ type: "text", text: m.text }],
        })),
      }),
    },
  };
}
