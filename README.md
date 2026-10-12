# opencode-foresight

Persistent long-term memory for [OpenCode](https://opencode.ai) — give your AI coding agent memory across sessions, with **automatic hooks** plus **explicit tools**, backed entirely by a **local file store**. No server, no API key, nothing leaves your machine.

Structure modeled on [`@vectorize-io/opencode-hindsight`](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/opencode) (hooks + retain/recall/reflect tools), with the memory backend swapped for a local JSONL store and BM25 lexical retrieval.

## Features

- **Explicit tools** the agent can call:
  - `foresight_retain` — store a specific fact, decision, or convention
  - `foresight_recall` — ranked search over past memories
  - `foresight_reflect` — assemble a structured digest of related memories
- **Automatic hooks**:
  - `experimental.chat.system.transform` — recalls relevant memories once per session and injects them into the system prompt (so the agent has context before you say anything)
  - `session.idle` — auto-retains the conversation transcript every N user turns
  - `experimental.session.compacting` — retains before context compaction and injects recalled memories into the compaction context
- **Local & private**: memories live in `.opencode/foresight/<scope>/memories.jsonl` inside your project
- **Scoped**: one store per project (derived from the git worktree root), with optional `::channel::user` isolation for multi-user setups
- **Non-blocking**: memory operations never fail the session; errors are logged and skipped

## Install

Requires OpenCode 2.x. The plugin implements the V2 plugin API (`{ id, setup(ctx) }`),
which OpenCode 1.x does not load.

```bash
opencode plugin add github:dialectstudio/opencode-foresight
```

Or register it manually in `opencode.jsonc` (project) or `~/.config/opencode/opencode.jsonc` (global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:dialectstudio/opencode-foresight"]
}
```

Restart OpenCode to load the plugin.

### With options

Options use the V2 object form — a `package` key plus an `options` object:

```jsonc
{
  "plugins": [
    {
      "package": "github:dialectstudio/opencode-foresight",
      "options": {
        "mission": "TypeScript monorepo. Focus on architecture decisions, test patterns, and deployment procedures.",
        "recallBudget": "high",
        "retainEveryNTurns": 5
      }
    }
  ]
}
```

## How it works

```
Session start
│   ▼
│  System prompt
│  + recalled memories (automatic, first system transform)
├──────────────────────────────────────
│  OpenCode Agent
│  ├── foresight_retain   (explicit)
│  ├── foresight_recall   (explicit)
│  └── foresight_reflect  (explicit)
└──────────────────────────────────────
        │                    ▲
     retain              recall
        │                    │
        ▼                    ▼
  .opencode/foresight/<scope>/memories.jsonl
```

1. **Session starts** — first system transform recalls memories (query built from your messages, falling back to "project context and recent work") and folds them into `system[0]`.
2. **During the session** — the agent calls the three tools explicitly when useful.
3. **Session idles** — after `retainEveryNTurns` user turns, the transcript is retained (`full-session` upserts one record per session; `last-turn` appends chunked windows with overlap).
4. **Context compaction** — the conversation is retained first, then recalled memories are injected into the compaction context so nothing important is lost.

Retrieval is BM25 lexical scoring over content + tags, with a recency boost; when nothing matches, the most recent memories are surfaced instead of nothing.

## Configuration

Loaded in order (later wins):

1. Built-in defaults
2. `~/.foresight/opencode.json` (user-wide defaults)
3. Plugin options in `opencode.json`
4. Environment variables

### Options

| Option               | Default   | What it does                                              |
| -------------------- | --------- | --------------------------------------------------------- |
| `autoRecall`         | `true`    | Inject memories into the system prompt on session start    |
| `autoRetain`         | `true`    | Capture the conversation on `session.idle`                 |
| `recallBudget`       | `mid`     | Result limit: `low` (4), `mid` (8), `high` (16)            |
| `recallMaxResults`   | `0`       | Explicit result limit overriding the budget                |
| `recallContextTurns` | `1`       | Prior turns folded into the auto-recall query              |
| `recallMaxQueryChars`| `800`     | Truncation cap for the composed recall query               |
| `recallResultMaxChars`| `1200`   | Per-memory truncation when formatting results              |
| `retainMode`         | `full-session` | `full-session` upserts; `last-turn` appends chunks    |
| `retainEveryNTurns`  | `3`       | Auto-retain cadence in user turns                          |
| `retainOverlapTurns` | `2`       | Overlap between `last-turn` chunks                         |
| `memoryDir`          | `<project>/.opencode/foresight` | Memory root directory            |
| `scopeId`            | derived   | Static scope ID (skips derivation)                         |
| `dynamicScope`       | `true`    | Derive scope from the git project (+ channel/user)         |
| `mission`            | `""`      | Project mission prepended to injected context and reflects |
| `debug`              | `false`   | Emit debug logs into OpenCode's log stream                 |

### Environment variables

| Variable | Type | Purpose |
| -------- | ---- | ------- |
| `FORESIGHT_MEMORY_DIR` | string | Memory root directory |
| `FORESIGHT_SCOPE_ID` | string | Static scope ID |
| `FORESIGHT_DYNAMIC_SCOPE` | bool | Enable/disable dynamic scope derivation |
| `FORESIGHT_AUTO_RECALL` | bool | Toggle session-start injection |
| `FORESIGHT_AUTO_RETAIN` | bool | Toggle idle retain |
| `FORESIGHT_RECALL_BUDGET` | `low\|mid\|high` | Recall budget |
| `FORESIGHT_RECALL_MAX_RESULTS` | int | Explicit result limit |
| `FORESIGHT_RECALL_CONTEXT_TURNS` | int | Context turns for the recall query |
| `FORESIGHT_RECALL_MAX_QUERY_CHARS` | int | Query truncation cap |
| `FORESIGHT_RECALL_RESULT_MAX_CHARS` | int | Per-memory formatting cap |
| `FORESIGHT_RETAIN_MODE` | `full-session\|last-turn` | Retain mode |
| `FORESIGHT_RETAIN_EVERY_N_TURNS` | int | Retain cadence |
| `FORESIGHT_RETAIN_OVERLAP_TURNS` | int | Chunk overlap |
| `FORESIGHT_MISSION` | string | Project mission |
| `FORESIGHT_CHANNEL_ID` | string | Channel segment for dynamic scope |
| `FORESIGHT_USER_ID` | string | User segment for dynamic scope |

## Scoping

- **Dynamic (default)**: scope = `<git-project>[:channel:user]`, e.g. `my-app`, or `my-app::team-backend::alice` with `FORESIGHT_CHANNEL_ID`/`FORESIGHT_USER_ID` set. Linked git worktrees of the same repo share one store.
- **Static**: set `dynamicScope: false` and `scopeId: "my-project"` (or `FORESIGHT_SCOPE_ID`).

Each scope is a separate directory: `.opencode/foresight/<scope>/memories.jsonl`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsup → dist/
```

To dogfood during development, add a relative plugin path to your OpenCode config:

```jsonc
{ "plugins": ["./path/to/opencode-foresight"] }
```

OpenCode loads a plugin package directory (or a direct `.ts`/`.js` file), so point it at the
repository root. `dist/` is committed, so a Git install needs no build step — OpenCode's
installer omits devDependencies and cannot run the build itself. Run `npm run build` after
changing `src/` and commit the rebuilt `dist/`.

## Pitfalls

- **Cold start**: the first session in a new scope has nothing to recall; memories accumulate from the second session onward (or pre-populate `memories.jsonl` manually).
- **Lexical search**: retrieval matches keywords, not semantics. Tag memories (`tags: ["architecture"]`) and prefer specific nouns in recall queries for best results.
- **Feedback loops**: `<foresight_memories>` blocks are stripped from transcripts before retention, so injected context is never re-stored as a memory.
- **Context budget**: recalled memories consume context window tokens — use `recallBudget: "low"` for long sessions.

## License

MIT
