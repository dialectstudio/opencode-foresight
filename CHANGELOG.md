# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-10

### Added

- Initial release of `opencode-foresight`, a persistent long-term memory plugin for OpenCode.
- Explicit tools: `foresight_retain`, `foresight_recall`, `foresight_reflect`.
- Automatic hooks: system prompt injection on session start, auto-retain on `session.idle`, retain + inject around context compaction.
- Local JSONL memory store with BM25 lexical retrieval and recency boost.
- Dynamic scoping from the git project root with optional channel/user isolation.
- Configuration via defaults, `~/.foresight/opencode.json`, plugin options, and `FORESIGHT_*` environment variables.
