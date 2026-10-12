/**
 * Foresight OpenCode Plugin — persistent long-term memory for OpenCode agents.
 *
 * Backed by a local JSONL file store (no external server or API key).
 *
 * Provides:
 *   - Custom tools: foresight_retain, foresight_recall, foresight_reflect
 *   - Auto-retain on session.idle
 *   - Memory injection on the first model context of each session
 *   - Memory preservation during context compaction
 *
 * This is an OpenCode 2 plugin: it default-exports a `Plugin.define`
 * definition with a stable `id` and a `setup(ctx)` that registers its tools
 * and hooks on the plugin context.
 *
 * @example
 * ```jsonc
 * // opencode.jsonc
 * { "plugins": ["github:dialectstudio/opencode-foresight"] }
 *
 * // With options:
 * {
 *   "plugins": [
 *     {
 *       "package": "github:dialectstudio/opencode-foresight",
 *       "options": { "mission": "TypeScript monorepo" }
 *     }
 *   ]
 * }
 * ```
 */

import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { loadConfig, type ForesightConfig } from "./config.js";import { deriveScopeId, sanitizeScopeSegment } from "./scope.js";
import { MemoryStore } from "./store.js";
import { createTools } from "./tools.js";
import {
  createHooks,
  createPluginState,
  makeSessionMessageReader,
  type PluginState,
} from "./hooks.js";
import { Logger } from "./logger.js";

/** Stable plugin ID — OpenCode scopes plugin storage and status by this. */
export const PLUGIN_ID = "opencode-foresight";

// Module-level state persists across sessions (the plugin is instantiated per
// location, but the module is loaded once per OpenCode server process).
const state: PluginState = createPluginState();

/** Default memory root: <project>/.opencode/foresight */
function defaultMemoryDir(directory: string): string {
  return join(directory, ".opencode", "foresight");
}

/** Resolve the JSONL file path for a scope under a memory root. */
function resolveStorePath(memoryDir: string, scopeId: string): string {
  return join(memoryDir, sanitizeScopeSegment(scopeId), "memories.jsonl");
}

/**
 * The V2 plugin definition.
 *
 * V2 requires a default-exported object with a stable `id` and a `setup(ctx)`
 * function. `Plugin.define` from `@opencode/plugin` is only an identity
 * function, so this uses a plain object typed as the namespace's `Plugin`
 * interface instead: identical behavior, with `@opencode/plugin` erased at
 * build time. That keeps the built entrypoint free of any runtime dependency
 * on module resolution when OpenCode loads it from a cloned repository.
 */
const ForesightPlugin: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const config: ForesightConfig = loadConfig(ctx.options);
    const logger = new Logger({ debug: config.debug });

    const directory = ctx.location.directory;
    const scopeId = deriveScopeId(config, directory);
    const memoryDir = config.memoryDir || defaultMemoryDir(directory);
    const store = new MemoryStore(resolveStorePath(memoryDir, scopeId));

    logger.info("Foresight plugin initialized", {
      store: store.filePath,
      scope: scopeId,
      autoRecall: config.autoRecall,
      autoRetain: config.autoRetain,
      memories: store.count(),
    });

    const readMessages = makeSessionMessageReader((input) => ctx.session.context(input));
    const hooks = createHooks(store, config, state, readMessages, logger);

    // 1. Custom tools (foresight_retain / recall / reflect)
    const tools = createTools(store, config, logger);
    await ctx.tool.transform((editor) => {
      for (const definition of tools) {
        editor.add(definition as never);
      }
    });

    // 2. Inject recalled memories into the system prompt, once per session.
    await ctx.session.hook("context", async (event) => {
      await hooks.recallIntoSystem(event.sessionID, event.system);
    });

    // 3. Retain before compaction, then inject recall into compaction.
    await ctx.session.hook("compaction", async (event) => {
      await hooks.retainBeforeCompaction(event.sessionID, event.system);
    });

    // 4. Auto-retain the transcript when a session goes idle.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await hooks.handleEvent(event as { type?: unknown; data?: unknown });
        }
      } catch (error) {
        // An aborted subscription is the normal shutdown path, not a failure.
        if (!controller.signal.aborted) {
          logger.error("Event subscription failed", error);
        }
      }
    })();

    return () => controller.abort();
  },
};

export default ForesightPlugin;

// Re-export types for consumers
export type { ForesightConfig } from "./config.js";
export type { PluginState } from "./hooks.js";
