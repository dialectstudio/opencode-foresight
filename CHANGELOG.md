# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Migrated to the OpenCode 2 plugin API.** The plugin now default-exports a
  `{ id, setup(ctx) }` definition instead of a V1 plugin factory. OpenCode 2
  only loads a module's default export, so the V1 entrypoint was never
  discovered by 2.x and the plugin did not load at all.
  - Tools register through `ctx.tool.transform` and return `{ content }`
    rather than a bare string, with JSON Schema inputs replacing the V1
    `tool.schema` builders.
  - `experimental.chat.system.transform` became `ctx.session.hook("context")`.
    System entries are now `{ type: "text", text }` parts rather than
    strings; recall is still folded into the first section so providers that
    only honor `system[0]` receive it.
  - `experimental.session.compacting` became `ctx.session.hook("compaction")`.
  - The `event` hook became an `ctx.event.subscribe()` loop, aborted from the
    cleanup function `setup` returns.
  - Session history is read via `ctx.session.context({ sessionID })`, which
    carries text per role (`text` for user, `content` parts for assistant),
    and is normalized to the plugin's `{ role, content }` records.
  - Plugin options come from `ctx.options`, and the project directory from
    `ctx.location.directory`.
- **Logging no longer uses `client.app.log`**, which OpenCode 2 removed. Lines
  go to `console.warn` (server stderr, visible with `--print-logs`) and to
  `~/.local/share/opencode/log/foresight.log`.
- Replaced the `@opencode-ai/plugin` dependency with `@opencode/plugin`. The
  V2 package is type-only in the build, so `dist/index.js` has no runtime
  dependency on it. It is declared under `devDependencies`, leaving the
  published package with no production dependencies.
- Configuration examples use the V2 `plugins` array. Options now use the
  object form (`{ "package": ..., "options": { ... } }`) instead of the V1
  package-and-options tuple.
- **Commit `dist/` and drop the `prepare` script**, so a Git install needs no
  build step at all. `prepublishOnly` still rebuilds before `npm publish`.
- **Renamed the `build` script to `bundle`.** npm's Git-dependency
  preparation (pacote) runs `npm install --force` inside the clone before
  packing, but only when the package declares a `build`, `prepare`, `prepack`,
  or install-lifecycle script. `build: tsup` therefore triggered a full
  install that fails under OpenCode's installer with
  `git dep preparation failed`, aborting `opencode plugin add` even though
  nothing ever ran that build. With no preparation-triggering script, npm
  packs the committed `dist/` unchanged. Do not rename it back.

## [0.1.0] - 2026-10-10

### Added

- Initial release of `opencode-foresight`, a persistent long-term memory plugin for OpenCode.
- Explicit tools: `foresight_retain`, `foresight_recall`, `foresight_reflect`.
- Automatic hooks: system prompt injection on session start, auto-retain on `session.idle`, retain + inject around context compaction.
- Local JSONL memory store with BM25 lexical retrieval and recency boost.
- Dynamic scoping from the git project root with optional channel/user isolation.
- Configuration via defaults, `~/.foresight/opencode.json`, plugin options, and `FORESIGHT_*` environment variables.
