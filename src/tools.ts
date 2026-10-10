/**
 * Custom tool definitions for the Foresight OpenCode plugin.
 *
 * Registers foresight_retain, foresight_recall, and foresight_reflect
 * as tools the agent can call explicitly.
 */

import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { ForesightConfig } from "./config.js";
import { budgetToLimit } from "./config.js";
import { formatMemories, formatCurrentTime } from "./content.js";
import type { MemoryStore, ScoredMemory } from "./store.js";
import { Logger } from "./logger.js";

export interface ForesightTools {
  foresight_retain: ToolDefinition;
  foresight_recall: ToolDefinition;
  foresight_reflect: ToolDefinition;
  // Index signature so the object is assignable to OpenCode's Hooks.tool
  // (Record<string, ToolDefinition>) without losing the specific keys above.
  [key: string]: ToolDefinition;
}

export function createTools(
  store: MemoryStore,
  config: ForesightConfig,
  logger: Logger = new Logger({ silent: true })
): ForesightTools {
  const foresight_retain = tool({
    description:
      "Store information in long-term memory. Use this to remember important facts, " +
      "user preferences, project context, decisions, conventions, and anything worth " +
      "recalling in future sessions. Be specific — include who, what, when, and why.",
    args: {
      content: tool.schema
        .string()
        .describe("The information to remember. Be specific and self-contained."),
      tags: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe('Optional topic tags, e.g. ["convention", "architecture"].'),
      context: tool.schema
        .string()
        .optional()
        .describe("Optional context about where this information came from."),
    },
    async execute(args, context) {
      store.add({
        content: args.content.trim(),
        kind: "fact",
        tags: args.tags ?? [],
        metadata: {
          source: "explicit",
          ...(args.context ? { context: args.context } : {}),
        },
        sessionId: context.sessionID,
      });
      logger.debug("foresight_retain stored a memory", { session: context.sessionID });
      return "Memory stored successfully.";
    },
  });

  const foresight_recall = tool({
    description:
      "Search long-term memory for relevant information. Use this proactively before " +
      "answering questions about past conversations, user preferences, project history, " +
      "or any topic where prior context would help. When in doubt, recall first.",
    args: {
      query: tool.schema
        .string()
        .describe("Natural language search query. Be specific about what you need to know."),
      limit: tool.schema
        .number()
        .optional()
        .describe("Maximum memories to return (defaults to the configured recall budget)."),
    },
    async execute(args) {
      const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : budgetToLimit(config);
      const results = store.search(args.query, limit);
      if (!results.length) return "No relevant memories found.";

      const formatted = formatMemories(results, config.recallResultMaxChars);
      return `Found ${results.length} relevant memories (as of ${formatCurrentTime()} UTC):\n\n${formatted}`;
    },
  });

  const foresight_reflect = tool({
    description:
      "Synthesize a structured digest from long-term memory. Unlike recall (which returns " +
      "raw ranked matches), reflect gathers a wider slice of relevant memories, groups them " +
      "by kind and recency, and frames them as a coherent answer. Use for questions like " +
      '"What do you know about this project?" or "Summarize our past decisions."',
    args: {
      query: tool.schema.string().describe("The question to answer using long-term memory."),
      context: tool.schema
        .string()
        .optional()
        .describe("Optional additional context to guide the reflection."),
    },
    async execute(args) {
      const results = store.search(args.query, budgetToLimit(config) * 2);
      if (!results.length) {
        return "No relevant memories found to reflect on.";
      }

      const sections: string[] = [];
      if (config.mission.trim()) {
        sections.push(`Project mission: ${config.mission.trim()}`);
      }
      if (args.context?.trim()) {
        sections.push(`Additional context: ${args.context.trim()}`);
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
      return sections.join("\n\n");
    },
  });

  return { foresight_retain, foresight_recall, foresight_reflect };
}

/** Re-exported for tests. */
export type { ScoredMemory };
