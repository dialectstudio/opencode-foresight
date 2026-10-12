import { Plugin } from '@opencode/plugin';

/**
 * Configuration management for the Foresight OpenCode plugin.
 *
 * Loading order (later entries win):
 *   1. Built-in defaults
 *   2. User config file (~/.foresight/opencode.json)
 *   3. Plugin options (from opencode.json plugin tuple)
 *   4. Environment variable overrides
 */
type RecallBudget = "low" | "mid" | "high";
type RetainMode = "full-session" | "last-turn";
interface ForesightConfig {
    autoRecall: boolean;
    recallBudget: RecallBudget;
    /** 0 = derive the result limit from recallBudget. */
    recallMaxResults: number;
    recallContextTurns: number;
    recallMaxQueryChars: number;
    recallPromptPreamble: string;
    /** Per-memory character cap when formatting results for context injection. */
    recallResultMaxChars: number;
    autoRetain: boolean;
    retainMode: RetainMode;
    retainEveryNTurns: number;
    retainOverlapTurns: number;
    /** Absolute path to the memory root. null → <project>/.opencode/foresight */
    memoryDir: string | null;
    /** Static scope ID. null → "opencode" (static) or derived (dynamic). */
    scopeId: string | null;
    /** Derive the scope ID from the project's git root / directory name. */
    dynamicScope: boolean;
    /** Project mission prepended to injected memory context and reflect framing. */
    mission: string;
    debug: boolean;
}

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

interface PluginState {
    /** Track sessions we've already injected recall into */
    recalledSessions: Set<string>;
    /** Track last retained turn count per session to avoid duplicates */
    lastRetainedTurn: Map<string, number>;
}

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

/** Stable plugin ID — OpenCode scopes plugin storage and status by this. */
declare const PLUGIN_ID = "opencode-foresight";
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
declare const ForesightPlugin: Plugin.Plugin;

export { type ForesightConfig, PLUGIN_ID, type PluginState, ForesightPlugin as default };
