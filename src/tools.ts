/**
 * Custom tool definitions for the Foresight OpenCode plugin.
 *
 * Registers foresight_retain, foresight_recall, and foresight_reflect
 * as tools the agent can call explicitly.
 *
 * V2 tools are registered through `ctx.tool.transform`, which takes a JSON
 * Schema `input` and returns a structured `{ content }` result.
 */

import type { ForesightConfig } from "./config.js";
import { budgetToLimit } from "./config.js";
import { formatMemories, formatCurrentTime } from "./content.js";
import type { MemoryStore, ScoredMemory } from "./store.js";
import { Logger } from "./logger.js";

/** Minimal JSON Schema shape we emit for tool inputs. */
interface JsonSchemaProperty {
  type: string;
  description?: string;
  items?: { type: string };
}

/** The subset of a V2 tool definition that Foresight builds. */
export interface ForesightTool {
  name: string;
  description: string;
  input: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties: false;
  };
  execute: (
    input: Record<string, unknown>,
    context: { sessionID: string }
  ) => Promise<{ content: string }>;
}

export function createTools(
  store: MemoryStore,
  config: ForesightConfig,
  logger: Logger = new Logger({ silent: true })
): ForesightTool[] {
  const foresight_retain: ForesightTool = {
    name: "foresight_retain",
    description:
      "Store information in long-term memory. Use this to remember important facts, " +
      "user preferences, project context, decisions, conventions, and anything worth " +
      "recalling in future sessions. Be specific — include who, what, when, and why.",
    input: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The information to remember. Be specific and self-contained.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional topic tags, e.g. ["convention", "architecture"].',
        },
        context: {
          type: "string",
          description: "Optional context about where this information came from.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const content = String(input.content ?? "").trim();
      const tags = Array.isArray(input.tags)
        ? (input.tags as unknown[]).map((t) => String(t))
        : [];
      const note = input.context ? String(input.context) : undefined;

      store.add({
        content,
        kind: "fact",
        tags,
        metadata: {
          source: "explicit",
          ...(note ? { context: note } : {}),
        },
        sessionId: context.sessionID,
      });
      logger.debug("foresight_retain stored a memory", { session: context.sessionID });
      return { content: "Memory stored successfully." };
    },
  };

  const foresight_recall: ForesightTool = {
    name: "foresight_recall",
    description:
      "Search long-term memory for relevant information. Use this proactively before " +
      "answering questions about past conversations, user preferences, project history, " +
      "or any topic where prior context would help. When in doubt, recall first.",
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query. Be specific about what you need to know.",
        },
        limit: {
          type: "number",
          description: "Maximum memories to return (defaults to the configured recall budget).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input) {
      const query = String(input.query ?? "");
      const rawLimit = typeof input.limit === "number" ? input.limit : 0;
      const limit = rawLimit > 0 ? Math.floor(rawLimit) : budgetToLimit(config);
      const results = store.search(query, limit);
      if (!results.length) return { content: "No relevant memories found." };

      const formatted = formatMemories(results, config.recallResultMaxChars);
      return {
        content: `Found ${results.length} relevant memories (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
      };
    },
  };

  const foresight_reflect: ForesightTool = {
    name: "foresight_reflect",
    description:
      "Synthesize a structured digest from long-term memory. Unlike recall (which returns " +
      "raw ranked matches), reflect gathers a wider slice of relevant memories, groups them " +
      "by kind and recency, and frames them as a coherent answer. Use for questions like " +
      '"What do you know about this project?" or "Summarize our past decisions."',
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The question to answer using long-term memory.",
        },
        context: {
          type: "string",
          description: "Optional additional context to guide the reflection.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input) {
      const query = String(input.query ?? "");
      const results = store.search(query, budgetToLimit(config) * 2);
      if (!results.length) {
        return { content: "No relevant memories found to reflect on." };
      }

      const sections: string[] = [];
      if (config.mission.trim()) {
        sections.push(`Project mission: ${config.mission.trim()}`);
      }
      const extraContext = input.context ? String(input.context).trim() : "";
      if (extraContext) {
        sections.push(`Additional context: ${extraContext}`);
      }

      const facts = results.filter((r) => r.kind === "fact");
      const transcripts = results.filter((r) => r.kind === "transcript");

      if (facts.length) {
        sections.push(`## Decisions and facts\n${formatMemories(facts, config.recallResultMaxChars)}`);
      }
      if (transcripts.length) {
        sections.push(
          `## Prior conversation context\n${formatMemories(transcripts, config.recallResultMaxChars)}`
        );
      }

      const tags = [...new Set(results.flatMap((r) => r.tags))].sort();
      if (tags.length) {
        sections.push(`Topics: ${tags.join(", ")}`);
      }
      sections.push(
        `Digest assembled from ${results.length} memories as of ${formatCurrentTime()} UTC.`
      );

      logger.debug("foresight_reflect assembled digest", { results: results.length });
      return { content: sections.join("\n\n") };
    },
  };

  return [foresight_retain, foresight_recall, foresight_reflect];
}

/** Re-exported for tests. */
export type { ScoredMemory };
