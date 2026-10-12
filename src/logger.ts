/**
 * Lightweight logger for the Foresight OpenCode plugin.
 *
 * OpenCode 2 removed the V1 `client.app.log` API and the V2 plugin context
 * exposes no replacement, so a log line cannot be routed into OpenCode's own
 * log stream from inside a plugin. Each line is therefore emitted two ways:
 *
 *   - `console.warn`, which reaches the server's stderr and is visible with
 *     `--print-logs`. `console.log` is deliberately avoided: server stdout is
 *     the stdio RPC channel under `opencode run`, so writing to it corrupts
 *     the transport.
 *   - a plugin-owned file under the OpenCode log directory, so debug output
 *     survives a session and can be inspected after the fact.
 *
 * All levels share those two sinks, so the level is carried in the line
 * itself rather than by the stream.
 *
 * Levels:
 *   - error / warn / info → always emitted
 *   - debug               → emitted only when `debug` is enabled in config
 */

import { appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /** When true, `debug()` messages are emitted. */
  debug?: boolean;
  /** When true, the logger emits nothing (used as a safe default in tests). */
  silent?: boolean;
  /** Override the plugin log file path (used by tests). */
  logFile?: string | null;
}

const SERVICE = "foresight";
const LOG_FILENAME = `${SERVICE}.log`;
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;

/** Directory OpenCode writes its own logs to, honouring OPENCODE_LOG_DIR. */
function defaultLogDir(): string {
  const dir = process.env.OPENCODE_LOG_DIR;
  if (dir) return dir;
  return join(homedir(), ".local", "share", "opencode", "log");
}

function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size > LOG_ROTATE_BYTES) {
      renameSync(path, `${path}.old`);
    }
  } catch {
    // A missing or unreadable file just means there is nothing to rotate.
  }
}

export class Logger {
  private readonly debugEnabled: boolean;
  private readonly silent: boolean;
  private readonly logFile: string | null;

  constructor(options: LoggerOptions = {}) {
    this.debugEnabled = options.debug ?? false;
    this.silent = options.silent ?? false;
    this.logFile =
      options.logFile === undefined ? join(defaultLogDir(), LOG_FILENAME) : options.logFile;
  }

  private emit(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (this.silent) return;

    let line = `service=${SERVICE} level=${level} message=${JSON.stringify(message)}`;
    if (extra && Object.keys(extra).length) {
      try {
        line += ` extra=${JSON.stringify(extra)}`;
      } catch {
        // Extra payloads that cannot be serialised are simply omitted.
      }
    }

    try {
      // console.warn reaches the server's stderr; console.log does not.
      console.warn(line);
    } catch {
      // Logging must never break the plugin's real behaviour.
    }

    if (this.logFile) {
      try {
        rotateIfNeeded(this.logFile);
        appendFileSync(this.logFile, `${line}\n`, "utf-8");
      } catch {
        // The log directory may not be writable; drop the line rather than throw.
      }
    }
  }

  error(message: string, error?: unknown): void {
    this.emit("error", message, error === undefined ? undefined : { error: errorToString(error) });
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.emit("warn", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.emit("info", message, extra);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    if (this.debugEnabled) this.emit("debug", message, extra);
  }
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}
