/**
 * Scope ID derivation — the local analog of Hindsight's "bank" IDs.
 *
 * Memories are stored one directory per scope, so each project (and,
 * optionally, each user/channel) gets an isolated memory store.
 *
 * Dimensions for dynamic scope IDs (joined by '::'):
 *   - project    → basename of the git worktree root when inside a repo
 *                  (so linked worktrees of the same repo share one store),
 *                  falling back to the working directory basename.
 *   - channel    → FORESIGHT_CHANNEL_ID env var (team/channel isolation)
 *   - user       → FORESIGHT_USER_ID env var (multi-user setups)
 */

import { basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { ForesightConfig } from "./config.js";

const DEFAULT_SCOPE_NAME = "opencode";
const VALID_FIELDS = new Set(["project", "user", "channel"]);

/**
 * Resolve the main worktree root for a directory inside a git repository.
 *
 * Uses `git rev-parse --path-format=absolute --git-common-dir`, which points to
 * the shared metadata directory even when invoked from a linked worktree.
 * Returns null when git is unavailable or the directory is not a repo.
 */
function getProjectRootFromGit(directory: string): string | null {
  if (!directory) return null;
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }
    ).trim();
    if (!commonDir) return null;
    if (basename(commonDir) === ".git") {
      return dirname(commonDir);
    }
    return commonDir;
  } catch {
    return null;
  }
}

/** Make a scope segment safe to use as a directory name. */
export function sanitizeScopeSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

/**
 * Derive a scope ID from context and config.
 *
 * Static mode: returns config.scopeId or "opencode".
 * Dynamic mode: composes from granularity fields joined by '::'.
 */
export function deriveScopeId(config: ForesightConfig, directory: string): string {
  if (!config.dynamicScope) {
    return config.scopeId || DEFAULT_SCOPE_NAME;
  }

  // Explicit static scope wins even in dynamic mode (escape hatch).
  if (config.scopeId) return config.scopeId;

  const fields = ["project", "channel", "user"];

  const channelId = process.env.FORESIGHT_CHANNEL_ID || "";
  const userId = process.env.FORESIGHT_USER_ID || "";

  const fieldResolvers: Record<string, () => string> = {
    project: () => {
      const root = getProjectRootFromGit(directory);
      if (root) return basename(root);
      return directory ? basename(directory) : "unknown";
    },
    user: () => userId || "default",
    channel: () => channelId || "default",
  };

  const segments: string[] = [];
  for (const f of fields) {
    if (!VALID_FIELDS.has(f)) continue;
    segments.push(fieldResolvers[f]());
  }

  // Trim trailing default::default so a solo project keeps a short scope ID.
  while (segments.length > 1 && segments[segments.length - 1] === "default") {
    segments.pop();
  }

  return segments.map(sanitizeScopeSegment).join("::");
}
