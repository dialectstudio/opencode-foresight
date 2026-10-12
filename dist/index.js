// src/index.ts
import { join as join3 } from "path";

// src/config.ts
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var DEFAULTS = {
  autoRecall: true,
  recallBudget: "mid",
  recallMaxResults: 0,
  recallContextTurns: 1,
  recallMaxQueryChars: 800,
  recallPromptPreamble: "Relevant memories from past sessions (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:",
  recallResultMaxChars: 1200,
  autoRetain: true,
  retainMode: "full-session",
  retainEveryNTurns: 3,
  retainOverlapTurns: 2,
  memoryDir: null,
  scopeId: null,
  dynamicScope: true,
  mission: "",
  debug: false
};
function budgetToLimit(config) {
  if (config.recallMaxResults > 0) return config.recallMaxResults;
  switch (config.recallBudget) {
    case "low":
      return 4;
    case "high":
      return 16;
    default:
      return 8;
  }
}
var ENV_OVERRIDES = {
  FORESIGHT_MEMORY_DIR: ["memoryDir", "string"],
  FORESIGHT_SCOPE_ID: ["scopeId", "string"],
  FORESIGHT_DYNAMIC_SCOPE: ["dynamicScope", "bool"],
  FORESIGHT_AUTO_RECALL: ["autoRecall", "bool"],
  FORESIGHT_AUTO_RETAIN: ["autoRetain", "bool"],
  FORESIGHT_RETAIN_MODE: ["retainMode", "string"],
  FORESIGHT_RECALL_BUDGET: ["recallBudget", "string"],
  FORESIGHT_RECALL_MAX_RESULTS: ["recallMaxResults", "int"],
  FORESIGHT_RECALL_MAX_QUERY_CHARS: ["recallMaxQueryChars", "int"],
  FORESIGHT_RECALL_CONTEXT_TURNS: ["recallContextTurns", "int"],
  FORESIGHT_RECALL_RESULT_MAX_CHARS: ["recallResultMaxChars", "int"],
  FORESIGHT_RETAIN_EVERY_N_TURNS: ["retainEveryNTurns", "int"],
  FORESIGHT_RETAIN_OVERLAP_TURNS: ["retainOverlapTurns", "int"],
  FORESIGHT_MISSION: ["mission", "string"]
  // NOTE: `debug` is intentionally NOT an env override — env vars are
  // unreliable to set for OpenCode's plugin runtime (notably on Windows).
};
function castEnv(value, typ) {
  if (typ === "bool") return ["true", "1", "yes"].includes(value.toLowerCase());
  if (typ === "int") {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }
  return value;
}
function loadSettingsFile(path) {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function loadConfig(pluginOptions) {
  const config = { ...DEFAULTS };
  const userConfigPath = join(homedir(), ".foresight", "opencode.json");
  const fileConfig = loadSettingsFile(userConfigPath);
  for (const [key, value] of Object.entries(fileConfig)) {
    if (value !== null && value !== void 0) {
      config[key] = value;
    }
  }
  if (pluginOptions) {
    for (const [key, value] of Object.entries(pluginOptions)) {
      if (value !== null && value !== void 0) {
        config[key] = value;
      }
    }
  }
  for (const [envName, [key, typ]] of Object.entries(ENV_OVERRIDES)) {
    const val = process.env[envName];
    if (val !== void 0) {
      const castVal = castEnv(val, typ);
      if (castVal !== null) {
        config[key] = castVal;
      }
    }
  }
  const result = config;
  const VALID_RETAIN_MODES = ["full-session", "last-turn"];
  if (!VALID_RETAIN_MODES.includes(result.retainMode)) {
    console.error(
      `[Foresight] Unknown retainMode "${result.retainMode}" \u2014 valid: ${VALID_RETAIN_MODES.join(", ")}. Falling back to "full-session".`
    );
    result.retainMode = "full-session";
  }
  const VALID_BUDGETS = ["low", "mid", "high"];
  if (!VALID_BUDGETS.includes(result.recallBudget)) {
    console.error(
      `[Foresight] Unknown recallBudget "${result.recallBudget}" \u2014 valid: ${VALID_BUDGETS.join(", ")}. Falling back to "mid".`
    );
    result.recallBudget = "mid";
  }
  return result;
}

// src/scope.ts
import { basename, dirname } from "path";
import { execFileSync } from "child_process";
var DEFAULT_SCOPE_NAME = "opencode";
var VALID_FIELDS = /* @__PURE__ */ new Set(["project", "user", "channel"]);
function getProjectRootFromGit(directory) {
  if (!directory) return null;
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: directory,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1e3
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
function sanitizeScopeSegment(segment) {
  const cleaned = segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}
function deriveScopeId(config, directory) {
  if (!config.dynamicScope) {
    return config.scopeId || DEFAULT_SCOPE_NAME;
  }
  if (config.scopeId) return config.scopeId;
  const fields = ["project", "channel", "user"];
  const channelId = process.env.FORESIGHT_CHANNEL_ID || "";
  const userId = process.env.FORESIGHT_USER_ID || "";
  const fieldResolvers = {
    project: () => {
      const root = getProjectRootFromGit(directory);
      if (root) return basename(root);
      return directory ? basename(directory) : "unknown";
    },
    user: () => userId || "default",
    channel: () => channelId || "default"
  };
  const segments = [];
  for (const f of fields) {
    if (!VALID_FIELDS.has(f)) continue;
    segments.push(fieldResolvers[f]());
  }
  while (segments.length > 1 && segments[segments.length - 1] === "default") {
    segments.pop();
  }
  return segments.map(sanitizeScopeSegment).join("::");
}

// src/store.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync, existsSync } from "fs";
import { dirname as dirname2 } from "path";
import { randomUUID } from "crypto";
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "s",
  "so",
  "t",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your"
]);
function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}
var K1 = 1.2;
var B = 0.75;
var MemoryStore = class {
  constructor(filePath) {
    this.filePath = filePath;
  }
  filePath;
  /** Read all entries; returns [] when the file does not exist yet. */
  load() {
    if (!existsSync(this.filePath)) return [];
    let raw;
    try {
      raw = readFileSync2(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const entries = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.content === "string" && parsed.id) {
          entries.push(parsed);
        }
      } catch {
      }
    }
    return entries;
  }
  persist(entries) {
    mkdirSync(dirname2(this.filePath), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(this.filePath, body ? `${body}
` : "", "utf-8");
  }
  /** Append a new entry. */
  add(entry) {
    const full = {
      id: entry.id || randomUUID(),
      createdAt: entry.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
      content: entry.content,
      kind: entry.kind,
      tags: entry.tags,
      metadata: entry.metadata,
      sessionId: entry.sessionId
    };
    const entries = this.load();
    entries.push(full);
    this.persist(entries);
    return full;
  }
  /**
   * Upsert by id — replaces any existing entry with the same id.
   * Used by full-session retain so re-retaining a session replaces,
   * rather than duplicates, its transcript.
   */
  upsert(entry) {
    const entries = this.load();
    const idx = entries.findIndex((e) => e.id === entry.id);
    const full = {
      ...entry,
      createdAt: entry.createdAt || (idx >= 0 ? entries[idx].createdAt : (/* @__PURE__ */ new Date()).toISOString())
    };
    if (idx >= 0) {
      entries[idx] = full;
    } else {
      entries.push(full);
    }
    this.persist(entries);
    return full;
  }
  /**
   * Search memories with BM25 scoring plus a recency boost.
   * Falls back to the most recent entries when no term matches.
   */
  search(query, limit, now = /* @__PURE__ */ new Date()) {
    const entries = this.load();
    if (!entries.length || limit <= 0) return [];
    const queryTokens = tokenize(query);
    const docs = entries.map((e) => tokenize(`${e.content} ${e.tags.join(" ")} ${e.tags.join(" ")}`));
    const df = /* @__PURE__ */ new Map();
    for (const tokens of docs) {
      const seen = new Set(tokens);
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = docs.length;
    const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / N;
    const idf = (term) => {
      const n = df.get(term) || 0;
      return Math.log(1 + (N - n + 0.5) / (n + 0.5));
    };
    const scored = [];
    for (let i = 0; i < entries.length; i++) {
      const tokens = docs[i];
      const tf = /* @__PURE__ */ new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const term of queryTokens) {
        const termTf = tf.get(term);
        if (!termTf) continue;
        const norm = termTf * (K1 + 1);
        const denom = termTf + K1 * (1 - B + B * tokens.length / (avgLen || 1));
        score += idf(term) * (norm / denom);
      }
      if (score <= 0) continue;
      const ageDays = Math.max(0, (now.getTime() - Date.parse(entries[i].createdAt)) / 864e5);
      score *= 1 + 0.3 * Math.exp(-ageDays / 7);
      const querySet = new Set(queryTokens);
      const tagHits = entries[i].tags.filter((t) => querySet.has(t.toLowerCase())).length;
      score += tagHits * 0.5;
      scored.push({ ...entries[i], score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) {
      const recent = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return recent.slice(0, limit).map((e) => ({ ...e, score: 0 }));
    }
    return scored.slice(0, limit);
  }
  count() {
    return this.load().length;
  }
};

// src/content.ts
var MEMORY_TAG = "foresight_memories";
function stripMemoryTags(content) {
  content = content.replace(/<foresight_memories>[\s\S]*?<\/foresight_memories>/g, "");
  content = content.replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "");
  return content;
}
function formatMemories(results, maxChars = 1200) {
  if (!results.length) return "";
  return results.map((r) => {
    let text = r.content;
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars).trimEnd()}\u2026 [truncated]`;
    }
    const kindStr = r.kind ? ` [${r.kind}]` : "";
    const dateStr = r.createdAt ? ` (${r.createdAt})` : "";
    return `- ${text}${kindStr}${dateStr}`;
  }).join("\n\n");
}
function formatCurrentTime() {
  const now = /* @__PURE__ */ new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}
function composeRecallQuery(latestQuery, messages, recallContextTurns) {
  const latest = latestQuery.trim();
  if (recallContextTurns <= 1 || !messages.length) return latest;
  const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
  const contextLines = [];
  for (const msg of contextual) {
    const content = stripMemoryTags(msg.content).trim();
    if (!content) continue;
    if (msg.role === "user" && content === latest) continue;
    contextLines.push(`${msg.role}: ${content}`);
  }
  if (!contextLines.length) return latest;
  return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}
function truncateRecallQuery(query, latestQuery, maxChars) {
  if (maxChars <= 0 || query.length <= maxChars) return query;
  const latest = latestQuery.trim();
  const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;
  if (!query.includes("Prior context:")) return latestOnly;
  const contextMarker = "Prior context:\n\n";
  const markerIndex = query.indexOf(contextMarker);
  if (markerIndex === -1) return latestOnly;
  const suffix = "\n\n" + latest;
  const suffixIndex = query.lastIndexOf(suffix);
  if (suffixIndex === -1) return latestOnly;
  if (suffix.length >= maxChars) return latestOnly;
  const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
  const contextLines = contextBody.split("\n").filter(Boolean);
  const kept = [];
  for (let i = contextLines.length - 1; i >= 0; i--) {
    kept.unshift(contextLines[i]);
    const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
    if (candidate.length > maxChars) {
      kept.shift();
      break;
    }
  }
  if (kept.length) return `${contextMarker}${kept.join("\n")}${suffix}`;
  return latestOnly;
}
function sliceLastTurnsByUserBoundary(messages, turns) {
  if (!messages.length || turns <= 0) return [];
  let userTurnsSeen = 0;
  let startIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= turns) {
        startIndex = i;
        break;
      }
    }
  }
  return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}
function prepareRetentionTranscript(messages, retainFullWindow = false) {
  if (!messages.length) return { transcript: null, messageCount: 0 };
  let targetMessages;
  if (retainFullWindow) {
    targetMessages = messages;
  } else {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
    targetMessages = messages.slice(lastUserIdx);
  }
  const parts = [];
  for (const msg of targetMessages) {
    const content = stripMemoryTags(msg.content).trim();
    if (!content) continue;
    parts.push(`[role: ${msg.role}]
${content}
[${msg.role}:end]`);
  }
  if (!parts.length) return { transcript: null, messageCount: 0 };
  const transcript = parts.join("\n\n");
  if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };
  return { transcript, messageCount: parts.length };
}

// src/logger.ts
import { appendFileSync, renameSync, statSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
var SERVICE = "foresight";
var LOG_FILENAME = `${SERVICE}.log`;
var LOG_ROTATE_BYTES = 4 * 1024 * 1024;
function defaultLogDir() {
  const dir = process.env.OPENCODE_LOG_DIR;
  if (dir) return dir;
  return join2(homedir2(), ".local", "share", "opencode", "log");
}
function rotateIfNeeded(path) {
  try {
    if (statSync(path).size > LOG_ROTATE_BYTES) {
      renameSync(path, `${path}.old`);
    }
  } catch {
  }
}
var Logger = class {
  debugEnabled;
  silent;
  logFile;
  constructor(options = {}) {
    this.debugEnabled = options.debug ?? false;
    this.silent = options.silent ?? false;
    this.logFile = options.logFile === void 0 ? join2(defaultLogDir(), LOG_FILENAME) : options.logFile;
  }
  emit(level, message, extra) {
    if (this.silent) return;
    let line = `service=${SERVICE} level=${level} message=${JSON.stringify(message)}`;
    if (extra && Object.keys(extra).length) {
      try {
        line += ` extra=${JSON.stringify(extra)}`;
      } catch {
      }
    }
    try {
      console.warn(line);
    } catch {
    }
    if (this.logFile) {
      try {
        rotateIfNeeded(this.logFile);
        appendFileSync(this.logFile, `${line}
`, "utf-8");
      } catch {
      }
    }
  }
  error(message, error) {
    this.emit("error", message, error === void 0 ? void 0 : { error: errorToString(error) });
  }
  warn(message, extra) {
    this.emit("warn", message, extra);
  }
  info(message, extra) {
    this.emit("info", message, extra);
  }
  debug(message, extra) {
    if (this.debugEnabled) this.emit("debug", message, extra);
  }
};
function errorToString(error) {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}

// src/tools.ts
function createTools(store, config, logger = new Logger({ silent: true })) {
  const foresight_retain = {
    name: "foresight_retain",
    description: "Store information in long-term memory. Use this to remember important facts, user preferences, project context, decisions, conventions, and anything worth recalling in future sessions. Be specific \u2014 include who, what, when, and why.",
    input: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The information to remember. Be specific and self-contained."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional topic tags, e.g. ["convention", "architecture"].'
        },
        context: {
          type: "string",
          description: "Optional context about where this information came from."
        }
      },
      required: ["content"],
      additionalProperties: false
    },
    async execute(input, context) {
      const content = String(input.content ?? "").trim();
      const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t)) : [];
      const note = input.context ? String(input.context) : void 0;
      store.add({
        content,
        kind: "fact",
        tags,
        metadata: {
          source: "explicit",
          ...note ? { context: note } : {}
        },
        sessionId: context.sessionID
      });
      logger.debug("foresight_retain stored a memory", { session: context.sessionID });
      return { content: "Memory stored successfully." };
    }
  };
  const foresight_recall = {
    name: "foresight_recall",
    description: "Search long-term memory for relevant information. Use this proactively before answering questions about past conversations, user preferences, project history, or any topic where prior context would help. When in doubt, recall first.",
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query. Be specific about what you need to know."
        },
        limit: {
          type: "number",
          description: "Maximum memories to return (defaults to the configured recall budget)."
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(input) {
      const query = String(input.query ?? "");
      const rawLimit = typeof input.limit === "number" ? input.limit : 0;
      const limit = rawLimit > 0 ? Math.floor(rawLimit) : budgetToLimit(config);
      const results = store.search(query, limit);
      if (!results.length) return { content: "No relevant memories found." };
      const formatted = formatMemories(results, config.recallResultMaxChars);
      return {
        content: `Found ${results.length} relevant memories (as of ${formatCurrentTime()} UTC):

${formatted}`
      };
    }
  };
  const foresight_reflect = {
    name: "foresight_reflect",
    description: 'Synthesize a structured digest from long-term memory. Unlike recall (which returns raw ranked matches), reflect gathers a wider slice of relevant memories, groups them by kind and recency, and frames them as a coherent answer. Use for questions like "What do you know about this project?" or "Summarize our past decisions."',
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The question to answer using long-term memory."
        },
        context: {
          type: "string",
          description: "Optional additional context to guide the reflection."
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(input) {
      const query = String(input.query ?? "");
      const results = store.search(query, budgetToLimit(config) * 2);
      if (!results.length) {
        return { content: "No relevant memories found to reflect on." };
      }
      const sections = [];
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
        sections.push(`## Decisions and facts
${formatMemories(facts, config.recallResultMaxChars)}`);
      }
      if (transcripts.length) {
        sections.push(
          `## Prior conversation context
${formatMemories(transcripts, config.recallResultMaxChars)}`
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
    }
  };
  return [foresight_retain, foresight_recall, foresight_reflect];
}

// src/hooks.ts
function createPluginState() {
  return {
    recalledSessions: /* @__PURE__ */ new Set(),
    lastRetainedTurn: /* @__PURE__ */ new Map()
  };
}
function makeSessionMessageReader(context) {
  return async (sessionID) => {
    try {
      const raw = await context({ sessionID });
      return normalizeSessionMessages(raw);
    } catch (e) {
      return [];
    }
  };
}
function normalizeSessionMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const messages = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const msg = entry;
    if (msg.type === "user") {
      if (typeof msg.text === "string" && msg.text) {
        messages.push({ role: "user", content: msg.text });
      }
      continue;
    }
    if (msg.type === "assistant") {
      if (!Array.isArray(msg.content)) continue;
      const textParts = msg.content.filter(
        (p) => !!p && typeof p === "object" && p.type === "text" && typeof p.text === "string"
      ).map((p) => p.text);
      if (textParts.length) {
        messages.push({ role: "assistant", content: textParts.join("\n") });
      }
    }
  }
  return messages;
}
function createHooks(store, config, state2, readMessages, logger = new Logger({ silent: true })) {
  async function recallForContext(query) {
    try {
      const results = store.search(query, budgetToLimit(config));
      if (!results.length) return { context: null, ok: true };
      const missionLine = config.mission.trim() ? `Project mission: ${config.mission.trim()}

` : "";
      const formatted = formatMemories(results, config.recallResultMaxChars);
      const context = `<${MEMORY_TAG}>
${config.recallPromptPreamble}
${missionLine}Current time: ${formatCurrentTime()} UTC

${formatted}
</${MEMORY_TAG}>`;
      return { context, ok: true };
    } catch (e) {
      logger.error("Recall failed", e);
      return { context: null, ok: false };
    }
  }
  function foldIntoSystem(system, context) {
    const first = system[0];
    if (first && first.type === "text") {
      system[0] = { ...first, text: `${first.text}

${context}` };
      return;
    }
    system.unshift({ type: "text", text: context });
  }
  async function retainSession(sessionId, messages) {
    const retainFullWindow = config.retainMode === "full-session";
    let targetMessages;
    let id;
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
      kind: "transcript",
      tags: [],
      metadata: { source: "auto", session_id: sessionId, messages: String(messageCount) },
      sessionId
    };
    if (retainFullWindow) {
      store.upsert(entry);
    } else {
      store.add(entry);
    }
    logger.debug(`Retained ${messageCount} messages`, { mode: config.retainMode, id });
  }
  async function handleSessionIdle(sessionId) {
    logger.debug(`handleSessionIdle called for session ${sessionId}`);
    if (!config.autoRetain) return;
    const messages = await readMessages(sessionId);
    if (!messages.length) return;
    const userTurns = messages.filter((m) => m.role === "user").length;
    const lastRetained = state2.lastRetainedTurn.get(sessionId) || 0;
    if (userTurns - lastRetained < config.retainEveryNTurns) return;
    try {
      await retainSession(sessionId, messages);
      state2.lastRetainedTurn.set(sessionId, userTurns);
      logger.info(`Auto-retained ${messages.length} messages`, { session: sessionId });
    } catch (e) {
      logger.error("Auto-retain failed", e);
    }
  }
  const handleEvent = async (event) => {
    try {
      if (event.type !== "session.idle") return;
      const payload = (event.data && typeof event.data === "object" ? event.data : void 0) ?? (event.properties && typeof event.properties === "object" ? event.properties : void 0);
      const sessionId = payload?.sessionID;
      if (typeof sessionId !== "string" || !sessionId) return;
      await handleSessionIdle(sessionId);
    } catch (e) {
      logger.error("Event hook error", e);
    }
  };
  const retainBeforeCompaction = async (sessionId, system) => {
    try {
      const messages = await readMessages(sessionId);
      if (messages.length && config.autoRetain) {
        try {
          await retainSession(sessionId, messages);
          state2.lastRetainedTurn.delete(sessionId);
          logger.debug("Pre-compaction retain completed");
        } catch (e) {
          logger.error("Pre-compaction retain failed", e);
        }
      }
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
  const recallIntoSystem = async (sessionId, system) => {
    try {
      if (!config.autoRecall) return;
      if (!sessionId) return;
      if (state2.recalledSessions.has(sessionId)) return;
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
      if (ok) {
        state2.recalledSessions.add(sessionId);
        if (state2.recalledSessions.size > 1e3) {
          const first = state2.recalledSessions.values().next().value;
          if (first) state2.recalledSessions.delete(first);
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
    handleEvent
  };
}

// src/index.ts
var PLUGIN_ID = "opencode-foresight";
var state = createPluginState();
function defaultMemoryDir(directory) {
  return join3(directory, ".opencode", "foresight");
}
function resolveStorePath(memoryDir, scopeId) {
  return join3(memoryDir, sanitizeScopeSegment(scopeId), "memories.jsonl");
}
var ForesightPlugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = loadConfig(ctx.options);
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
      memories: store.count()
    });
    const readMessages = makeSessionMessageReader((input) => ctx.session.context(input));
    const hooks = createHooks(store, config, state, readMessages, logger);
    const tools = createTools(store, config, logger);
    await ctx.tool.transform((editor) => {
      for (const definition of tools) {
        editor.add(definition);
      }
    });
    await ctx.session.hook("context", async (event) => {
      await hooks.recallIntoSystem(event.sessionID, event.system);
    });
    await ctx.session.hook("compaction", async (event) => {
      await hooks.retainBeforeCompaction(event.sessionID, event.system);
    });
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await hooks.handleEvent(event);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          logger.error("Event subscription failed", error);
        }
      }
    })();
    return () => controller.abort();
  }
};
var index_default = ForesightPlugin;
export {
  PLUGIN_ID,
  index_default as default
};
//# sourceMappingURL=index.js.map