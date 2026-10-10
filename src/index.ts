/**
 * Foresight OpenCode Plugin — persistent long-term memory for OpenCode agents.
 *
 * Backed by a local JSONL file store (no external server or API key).
 *
 * Provides:
 *   - Custom tools: foresight_retain, foresight_recall, foresight_reflect
 *   - Auto-retain on session.idle
 *   - Memory injection on the first chat system transform of each session
 *   - Memory preservation during context compaction
 *
 * @example
 * ```json
 * // opencode.json
 * { "plugin": ["opencode-foresight"] }
 *
 * // With options:
 * { "plugin": [["opencode-foresight", { "mission": "TypeScript monorepo" }]] }
 * ```
 */

import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig, type ForesightConfig } from "./config.js";
import { deriveScopeId, sanitizeScopeSegment } from "./scope.js";
import { MemoryStore } from "./store.js";
import { createTools } from "./tools.js";
import { createHooks, createPluginState, type PluginState } from "./hooks.js";
import { Logger, type OpencodeLogClient } from "./logger.js";

// Module-level state persists across sessions (the plugin is instantiated per
// session, but the module is loaded once per OpenCode server process).
const state: PluginState = createPluginState();

/** Default memory root: <project>/.opencode/foresight */
function defaultMemoryDir(directory: string): string {
  return join(directory, ".opencode", "foresight");
}

/** Resolve the JSONL file path for a scope under a memory root. */
function resolveStorePath(memoryDir: string, scopeId: string): string {
  return join(memoryDir, sanitizeScopeSegment(scopeId), "memories.jsonl");
}

const ForesightPlugin: Plugin = async (input, options) => {
  const config: ForesightConfig = loadConfig(options);

  const logger = new Logger({
    client: input.client as unknown as OpencodeLogClient,
    debug: config.debug,
  });

  const scopeId = deriveScopeId(config, input.directory);
  const memoryDir = config.memoryDir || defaultMemoryDir(input.directory);
  const store = new MemoryStore(resolveStorePath(memoryDir, scopeId));

  logger.info("Foresight plugin initialized", {
    store: store.filePath,
    scope: scopeId,
    autoRecall: config.autoRecall,
    autoRetain: config.autoRetain,
    memories: store.count(),
  });

  const tools = createTools(store, config, logger);
  const hooks = createHooks(
    store,
    config,
    state,
    input.client as unknown as Parameters<typeof createHooks>[3],
    logger
  );

  return {
    tool: tools,
    ...hooks,
  };
};

// Named export for direct import
export { ForesightPlugin };

// Default export is the Plugin function itself — OpenCode's loader iterates
// exports and calls function exports as Plugin factories. Keep the entry
// surface free of utility re-exports so they are not invoked as plugins.
export default ForesightPlugin;

// Re-export types for consumers
export type { ForesightConfig } from "./config.js";
export type { PluginState } from "./hooks.js";
