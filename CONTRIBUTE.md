# Contributing to opencode-foresight

Thanks for your interest in improving persistent memory for OpenCode. This document explains how to get set up and what we look for in contributions.

## Getting started

```bash
git clone https://github.com/dialectstudio/opencode-foresight.git
cd opencode-foresight
npm install
```

Requirements:

- Node.js >= 22
- npm (lockfile is committed; please use npm, not yarn/pnpm)

## Development workflow

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run bundle      # tsup → dist/
```

All three must pass before a PR is merged. `npm run test:watch` and `npm run dev` (tsc watch) are available while iterating.

`bundle` is deliberately **not** named `build`: npm's Git-dependency preparation triggers on a
`build` script and runs `npm install --force` inside the clone before packing, which fails under
OpenCode's installer with `git dep preparation failed`. Without a preparation-triggering script,
npm packs the committed `dist/` unchanged. Do not rename it back.

To dogfood changes in a live OpenCode session, point your config at the source instead of the built package:

```json
{ "plugins": ["./path/to/opencode-foresight/src/index.ts"] }
```

## Project layout

| Path               | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `src/index.ts`     | Plugin entry: wires config, scope, store, tools, hooks         |
| `src/config.ts`    | Defaults, file config, plugin options, env var resolution      |
| `src/scope.ts`     | Scope ID derivation (git root + optional channel/user)         |
| `src/store.ts`     | JSONL memory store (append, upsert, read)                      |
| `src/content.ts`   | Transcript → memory chunking, formatting, block stripping      |
| `src/tools.ts`     | `foresight_retain` / `foresight_recall` / `foresight_reflect`  |
| `src/hooks.ts`     | System transform, `session.idle`, compaction hooks             |
| `src/logger.ts`    | Non-blocking logging into OpenCode's log stream                |
| `src/*.test.ts`    | Vitest unit tests, colocated with the module they cover        |

## Conventions

- **TypeScript strict** — `strict: true`, ESM only, Node16 resolution. Avoid `any` unless bridging an untyped boundary (then isolate and document the cast).
- **Colocated tests** — new behavior needs a `*.test.ts` next to the module. Use `src/test-helpers.ts` for fixtures instead of duplicating setup.
- **Non-blocking by design** — memory operations must never fail a session. Wrap I/O and unexpected errors so they log and skip rather than throw into OpenCode.
- **No new runtime dependencies** without prior discussion in an issue; keep the plugin lightweight.
- **Private by default** — nothing may leave the local machine. No telemetry, no network calls, no external services.
- **Comments** explain *why*, not *what*.

## Submitting changes

1. Open an issue first for larger features or behavior changes — it saves rework.
2. Fork and branch from `main`: `git checkout -b fix/short-description`.
3. Keep commits focused and written in the imperative ("Add recency boost to recall", not "Added...").
4. Make sure `npm run typecheck`, `npm test`, and `npm run bundle` all pass.
5. Update `README.md` if you change configuration options, env vars, tools, or hooks. Add a `CHANGELOG.md` entry for user-visible changes.
6. Open a pull request with a short description of the problem and the approach.

## Reporting bugs

Include:

- Plugin version and how you installed it (npm / relative path)
- OpenCode version and Node.js version
- Relevant config (`plugin` entry, options, env vars)
- Logs with `debug: true` enabled (redact anything private)

## Security issues

Please do **not** open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
