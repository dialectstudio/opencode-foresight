import { describe, it, expect, afterEach } from "vitest";
import { deriveScopeId, sanitizeScopeSegment } from "./scope.js";
import { loadConfig } from "./config.js";

const ENV_KEYS = ["FORESIGHT_CHANNEL_ID", "FORESIGHT_USER_ID", "FORESIGHT_SCOPE_ID"];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(clearEnv);

describe("deriveScopeId", () => {
  it("returns the static scope id when dynamic scope is off", () => {
    clearEnv();
    const config = loadConfig({ dynamicScope: false, scopeId: "my-project" });
    expect(deriveScopeId(config, "/any/dir")).toBe("my-project");
  });

  it("falls back to 'opencode' when static and unset", () => {
    clearEnv();
    const config = loadConfig({ dynamicScope: false });
    expect(deriveScopeId(config, "/any/dir")).toBe("opencode");
  });

  it("uses the directory basename for dynamic scope outside git", () => {
    clearEnv();
    // /tmp is not a git repo on CI machines; fallback path is exercised.
    const config = loadConfig({ dynamicScope: true });
    const scope = deriveScopeId(config, "/tmp/definitely-not-a-repo-xyz");
    expect(typeof scope).toBe("string");
    expect(scope.length).toBeGreaterThan(0);
  });

  it("uses the git root basename when inside a repository", () => {
    clearEnv();
    const config = loadConfig({ dynamicScope: true });
    // This test file lives inside a git repo (created during scaffold).
    const scope = deriveScopeId(config, process.cwd());
    expect(scope).toContain("opencode-persistent-memory-foresight");
  });

  it("appends channel and user when provided", () => {
    clearEnv();
    process.env.FORESIGHT_CHANNEL_ID = "team-backend";
    process.env.FORESIGHT_USER_ID = "alice";
    const config = loadConfig({ dynamicScope: true });
    const scope = deriveScopeId(config, "/tmp/definitely-not-a-repo-xyz");
    expect(scope.endsWith("::team-backend::alice")).toBe(true);
  });

  it("lets an explicit scope id win in dynamic mode", () => {
    clearEnv();
    const config = loadConfig({ dynamicScope: true, scopeId: "explicit-scope" });
    expect(deriveScopeId(config, "/tmp/anything")).toBe("explicit-scope");
  });
});

describe("sanitizeScopeSegment", () => {
  it("replaces unsafe characters", () => {
    expect(sanitizeScopeSegment("my project/branch")).toBe("my-project-branch");
  });

  it("never returns an empty string", () => {
    expect(sanitizeScopeSegment("///")).toBe("unknown");
  });
});
