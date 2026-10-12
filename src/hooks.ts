/**
 * Hook implementations for the Foresight OpenCode plugin, ported to the
 * OpenCode 2 plugin API.
 *
 * V1 hooks and their V2 destinations:
 *   - experimental.chat.system.transform → ctx.session.hook("context")
 *       recall memories once per session and fold them into the system prompt
 *   - event (session.idle)               → ctx.event.subscribe()
 *       auto-retain the conversation transcript
 *   - experimental.session.compacting    → ctx.session.hook("compaction")
 *       retain before compaction and inject recalled memories
 *
 * The handlers below take plain V2 event shapes so they stay unit-testable
 * without a live OpenCode context. `index.ts` wires them to `ctx`.
 */

import type { ForesightConfig } from "./config.js";
import { budgetToLimit } from "./config.js";
import { Logger } from "./logger.js";
import {
  formatMemories,
  formatCurrentTime,
  composeRecallQuery,
  truncateRecallQuery,
  prepareRetentionTranscript,
  sliceLastTurnsByUserBoundary,
  MEMORY_TAG,
  type Message,
} from "./content.js";
import type { MemoryStore } from "./store.js";

export interface PluginState {
  /** Track sessions we've already injected recall into */
  recalledSessions: Set<string>;
  /** Track last retained turn count per session to avoid duplicates */
  lastRetainedTurn: Map<string, number>;
}

export function createPluginState(): PluginState {
  return {
    recalledSessions: new Set(),
    lastRetainedTurn: new Map(),
  };
}

/** A system prompt entry as passed to the V2 `context` and `compaction` hooks. */
export interface SystemPart {
  type: string;
  text: string;
}

/** Reads the plain-text user/assistant history of a session. */
export type SessionMessageReader = (sessionID: string) => Promise<Message[]>;

/**
 * Reads messages via `ctx.session.context({ sessionID })` and normalizes the
 * V2 message shape into the `{ role, content }` records the recall and retain
 * logic works on.
 */
export function makeSessionMessageReader(
  context: (input: { sessionID: string }) => Promise<unknown>
): SessionMessageReader {
  return async (sessionID: string): Promise<Message[]> => {
    try {
      const raw = await context({ sessionID });
      return normalizeSessionMessages(raw);
    } catch (e) {
      // A reader that throws must never break the request it was called from.
      return [];
    }
  };
}

/**
 * V2 session messages carry their text differently per role:
 *   - user messages:      { type: "user", text }
 *   - assistant messages: { type: "assistant", content: [{ type: "text", text }] }
 * Anything else (system, skill, shell, compaction, tool) is not conversation
 * history and is skipped, matching the V1 behavior of keeping only
 * user/assistant text parts.
 */
export function normalizeSessionMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];

  const messages: Message[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const msg = entry as { type?: unknown; text?: unknown; content?: unknown };

    if (msg.type === "user") {
      if (typeof msg.text === "string" && msg.text) {
        messages.push({ role: "user", content: msg.text });
      }
      continue;
    }

    if (msg.type === "assistant") {
      if (!Array.isArray(msg.content)) continue;
      const textParts = msg.content
        .filter((p): p is { type: string; text: string } =>
          !!p && typeof p === "object" && p.type === "text" && typeof p.text === "string"
        )
        .map((p) => p.text);
      if (textParts.length) {
        messages.push({ role: "assistant", content: textParts.join("\n") });
      }
    }
  }
  return messages;
}

export interface ForesightHooks {
  /** `ctx.session.hook("context")` — inject recalled memories into the system prompt. */
  recallIntoSystem: (sessionID: string, system: SystemPart[]) => Promise<void>;
  /** `ctx.session.hook("compaction")` — retain, then inject recall into compaction. */
  retainBeforeCompaction: (sessionID: string, system: SystemPart[]) => Promise<void>;
  /** Called for each subscribed server event; handles `session.idle`. */
  handleEvent: (event: { type?: unknown; data?: unknown; properties?: unknown }) => Promise<void>;
}

export function createHooks(
  store: MemoryStore,
  config: ForesightConfig,
  state: PluginState,
  readMessages: SessionMessageReader,
  logger: Logger = new Logger({ silent: true })
): ForesightHooks {
  interface RecallOutcome {
    context: string | null;
    ok: boolean;
  }

  /** Recall memories and format as context string */
  async function recallForContext(query: string): Promise<RecallOutcome> {
    try {
      const results = store.search(query, budgetToLimit(config));
      if (!results.length) return { context: null, ok: true };

      const missionLine = config.mission.trim()
        ? `Project mission: ${config.mission.trim()}\n\n`
        : "";
      const formatted = formatMemories(results, config.recallResultMaxChars);
      const context =
        `<${MEMORY_TAG}>\n` +
        `${config.recallPromptPreamble}\n` +
        `${missionLine}` +
        `Current time: ${formatCurrentTime()} UTC\n\n` +
        `${formatted}\n` +
        `</${MEMORY_TAG}>`;
      return { context, ok: true };
    } catch (e) {
      logger.error("Recall failed", e);
      return { context: null, ok: false };
    }
  }

  /**
   * Fold recall into the FIRST system section — some providers only honor
   * system[0], and a separately pushed section can be silently dropped.
   */
  function foldIntoSystem(system: SystemPart[], context: string): void {
    const first = system[0];
    if (first && first.type === "text") {
      system[0] = { ...first, text: `${first.text}\n\n${context}` };
      return;
    }
    system.unshift({ type: "text", text: context });
  }

  /**
   * Retain messages for a session, respecting retainMode.
   * full-session upserts a single record per session; last-turn appends
   * a chunked window with overlap.
   */
  async function retainSession(sessionId: string, messages: Message[]): Promise<void> {
    const retainFullWindow = config.retainMode === "full-session";
    let targetMessages: Message[];
    let id: string;

    if (retainFullWindow) {
      targetMessages = messages;
      id = sessionId;
    } else {
      const windowTurns = config.retainEveryNTurns + config.retainOverlapTurns;
      targetMessages = sliceLastTurnsByUserBoundary(messages, windowTurns);
      id = `${sessionId}-${Date.now()}`;
    }

    const { transcript, messageCount } = prepareRetentionTranscript(targetMessages, true);
    if (!transcript) return;

    const entry = {
      id,
      content: transcript,
      kind: "transcript" as const,
      tags: [],
      metadata: { source: "auto", session_id: sessionId, messages: String(messageCount) },
      sessionId,
    };

    if (retainFullWindow) {
      store.upsert(entry);
    } else {
      store.add(entry);
    }
    logger.debug(`Retained ${messageCount} messages`, { mode: config.retainMode, id });
  }

  /** Auto-retain conversation transcript on session idle */
  async function handleSessionIdle(sessionId: string): Promise<void> {
    logger.debug(`handleSessionIdle called for session ${sessionId}`);
    if (!config.autoRetain) return;

    const messages = await readMessages(sessionId);
    if (!messages.length) return;

    const userTurns = messages.filter((m) => m.role === "user").length;
    const lastRetained = state.lastRetainedTurn.get(sessionId) || 0;

    // Only retain if enough new turns since last retain
    if (userTurns - lastRetained < config.retainEveryNTurns) return;

    try {
      await retainSession(sessionId, messages);
      state.lastRetainedTurn.set(sessionId, userTurns);
      logger.info(`Auto-retained ${messages.length} messages`, { session: sessionId });
    } catch (e) {
      logger.error("Auto-retain failed", e);
    }
  }

  const handleEvent = async (event: {
    type?: unknown;
    data?: unknown;
    properties?: unknown;
  }): Promise<void> => {
    try {
      if (event.type !== "session.idle") return;

      // V2 exposes the payload under `data`; `properties` is accepted as a
      // fallback so the handler keeps working against an adapted event.
      const payload =
        (event.data && typeof event.data === "object" ? event.data : undefined) ??
        (event.properties && typeof event.properties === "object" ? event.properties : undefined);
      const sessionId = (payload as { sessionID?: unknown } | undefined)?.sessionID;
      if (typeof sessionId !== "string" || !sessionId) return;

      await handleSessionIdle(sessionId);
      // NOTE: autoRecall is driven entirely by the `context` hook. Do not key
      // it off `session.created` — the relative firing order of
      // `session.created` vs the context hook is an undocumented OpenCode
      // implementation detail that has differed between versions.
    } catch (e) {
      logger.error("Event hook error", e);
    }
  };

  const retainBeforeCompaction = async (
    sessionId: string,
    system: SystemPart[]
  ): Promise<void> => {
    try {
      // First, retain what we have before compaction
      const messages = await readMessages(sessionId);
      if (messages.length && config.autoRetain) {
        try {
          await retainSession(sessionId, messages);
          // Reset turn tracking — after compaction the message list shrinks,
          // so the old lastRetainedTurn value would block future idle retains.
          state.lastRetainedTurn.delete(sessionId);
          logger.debug("Pre-compaction retain completed");
        } catch (e) {
          logger.error("Pre-compaction retain failed", e);
        }
      }

      // Then recall relevant memories to inject into the compaction context
      if (messages.length) {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (lastUserMsg) {
          const query = composeRecallQuery(
            lastUserMsg.content,
            messages,
            config.recallContextTurns
          );
          const truncated = truncateRecallQuery(
            query,
            lastUserMsg.content,
            config.recallMaxQueryChars
          );
          const { context } = await recallForContext(truncated);
          if (context) {
            system.push({ type: "text", text: context });
          }
        }
      }
    } catch (e) {
      logger.error("Compaction hook error", e);
    }
  };

  const recallIntoSystem = async (
    sessionId: string,
    system: SystemPart[]
  ): Promise<void> => {
    try {
      if (!config.autoRecall) return;
      if (!sessionId) return;

      // Recall once per session, on the first context hook we see for it.
      // `recalledSessions` is a dedup marker, not an event-ordering gate —
      // this keeps autoRecall independent of whether session.created fired
      // first (mirrors Hindsight #1758).
      if (state.recalledSessions.has(sessionId)) return;

      // Build the recall query from the user's own messages so session-start
      // recall adapts to what they actually asked. When there is no user text
      // yet, fall back to a generic project-context query.
      const messages = await readMessages(sessionId);
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      let query = `project context and recent work`;
      if (lastUserMsg && lastUserMsg.content.trim()) {
        const composed = composeRecallQuery(
          lastUserMsg.content,
          messages,
          config.recallContextTurns
        );
        query = truncateRecallQuery(composed, lastUserMsg.content, config.recallMaxQueryChars);
      }
      const { context, ok } = await recallForContext(query);

      // Mark as recalled only after a successful round-trip so transient
      // failures retry on the next message.
      if (ok) {
        state.recalledSessions.add(sessionId);
        if (state.recalledSessions.size > 1000) {
          const first = state.recalledSessions.values().next().value;
          if (first) state.recalledSessions.delete(first);
        }
      }

      if (context) {
        foldIntoSystem(system, context);
        logger.debug(`Injected recall context for session ${sessionId}`);
      }
    } catch (e) {
      logger.error("System transform hook error", e);
    }
  };

  return {
    recallIntoSystem,
    retainBeforeCompaction,
    handleEvent,
  };
}
