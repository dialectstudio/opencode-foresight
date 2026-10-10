/**
 * Hook implementations for the Foresight OpenCode plugin.
 *
 * Hooks:
 *   - experimental.chat.system.transform → recall memories once per session
 *     and inject them into the system prompt
 *   - event (session.idle) → auto-retain conversation transcript
 *   - experimental.session.compacting → retain before compaction and inject
 *     recalled memories into the compaction context
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

interface EventInput {
  event: {
    type: string;
    properties: Record<string, unknown>;
  };
}

interface CompactingInput {
  sessionID: string;
}

interface CompactingOutput {
  context: string[];
  prompt?: string;
}

interface SystemTransformInput {
  sessionID?: string;
  model: unknown;
}

interface SystemTransformOutput {
  system: string[];
}

type OpencodeClient = {
  session: {
    messages: (params: { path: { id: string } }) => Promise<{
      data?: Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }>;
      error?: unknown;
    }>;
  };
};

export interface ForesightHooks {
  event: (input: EventInput) => Promise<void>;
  "experimental.session.compacting": (
    input: CompactingInput,
    output: CompactingOutput
  ) => Promise<void>;
  "experimental.chat.system.transform": (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ) => Promise<void>;
}

export function createHooks(
  store: MemoryStore,
  config: ForesightConfig,
  state: PluginState,
  opencodeClient: OpencodeClient,
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

  /** Extract plain-text messages from an OpenCode session */
  async function getSessionMessages(sessionId: string): Promise<Message[]> {
    try {
      const response = await opencodeClient.session.messages({
        path: { id: sessionId },
      });
      if (response.error) {
        logger.warn("getSessionMessages: OpenCode returned an error", {
          error: JSON.stringify(response.error)?.substring(0, 500),
        });
      }
      const rawMessages = response.data || [];
      const messages: Message[] = [];
      for (const msg of rawMessages) {
        const role = msg.info.role;
        if (role !== "user" && role !== "assistant") continue;
        const textParts = msg.parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!);
        if (textParts.length) {
          messages.push({ role, content: textParts.join("\n") });
        }
      }
      logger.debug(`getSessionMessages: raw=${rawMessages.length}, parsed=${messages.length}`);
      return messages;
    } catch (e) {
      logger.error("Failed to get session messages", e);
      return [];
    }
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

    const messages = await getSessionMessages(sessionId);
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

  const event = async (input: EventInput): Promise<void> => {
    try {
      const { event: evt } = input;
      logger.debug(`event hook fired: type=${evt.type}`);

      if (evt.type === "session.idle") {
        const sessionId = (evt.properties as { sessionID?: string }).sessionID;
        if (sessionId) {
          await handleSessionIdle(sessionId);
        }
      }
      // NOTE: autoRecall is driven entirely by `experimental.chat.system.transform`.
      // Do not key it off `session.created` — the relative firing order of
      // `session.created` vs `system.transform` is an undocumented OpenCode
      // implementation detail that has differed between versions.
    } catch (e) {
      logger.error("Event hook error", e);
    }
  };

  const compacting = async (
    input: CompactingInput,
    output: CompactingOutput
  ): Promise<void> => {
    try {
      // First, retain what we have before compaction
      const messages = await getSessionMessages(input.sessionID);
      if (messages.length && config.autoRetain) {
        try {
          await retainSession(input.sessionID, messages);
          // Reset turn tracking — after compaction the message list shrinks,
          // so the old lastRetainedTurn value would block future idle retains.
          state.lastRetainedTurn.delete(input.sessionID);
          logger.debug("Pre-compaction retain completed");
        } catch (e) {
          logger.error("Pre-compaction retain failed", e);
        }
      }

      // Then recall relevant memories to inject into compaction context
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
            output.context.push(context);
          }
        }
      }
    } catch (e) {
      logger.error("Compaction hook error", e);
    }
  };

  const systemTransform = async (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ): Promise<void> => {
    try {
      if (!config.autoRecall) return;
      const sessionId = input.sessionID;
      if (!sessionId) return;

      // Recall once per session, on the first system.transform we see for it.
      // `recalledSessions` is a dedup marker, not an event-ordering gate —
      // this keeps autoRecall independent of whether session.created fired
      // first (mirrors Hindsight #1758).
      if (state.recalledSessions.has(sessionId)) return;

      // Build the recall query from the user's own messages so session-start
      // recall adapts to what they actually asked. When there is no user text
      // yet, fall back to a generic project-context query.
      const messages = await getSessionMessages(sessionId);
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
        // Fold recall into the FIRST system section — some providers only
        // honor system[0], and a pushed section can be silently dropped.
        output.system[0] = output.system[0]
          ? `${output.system[0]}\n\n${context}`
          : context;
        logger.debug(`Injected recall context for session ${sessionId}`);
      }
    } catch (e) {
      logger.error("System transform hook error", e);
    }
  };

  return {
    event,
    "experimental.session.compacting": compacting,
    "experimental.chat.system.transform": systemTransform,
  };
}
