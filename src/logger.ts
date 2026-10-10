/**
 * Lightweight logger for the Foresight OpenCode plugin.
 *
 * Routes through OpenCode's server log API (`client.app.log`) when available so
 * messages land in OpenCode's own log stream — visible via `--print-logs` and
 * the OpenCode log files — without writing to stdout/stderr and corrupting the
 * TUI. Falls back to `console.error` when the OpenCode client is unavailable.
 *
 * Levels:
 *   - error / warn / info → always emitted
 *   - debug               → emitted only when `debug` is enabled in config
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Minimal shape of OpenCode's `client.app.log` that we depend on. */
export interface OpencodeLogClient {
  app?: {
    log?: (options: {
      body: {
        service: string;
        level: LogLevel;
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => unknown;
  };
}

export interface LoggerOptions {
  /** OpenCode client used to write into the server log stream. */
  client?: OpencodeLogClient;
  /** When true, `debug()` messages are emitted. */
  debug?: boolean;
  /** When true, the logger emits nothing (used as a safe default in tests). */
  silent?: boolean;
}

const SERVICE = "foresight";

export class Logger {
  private readonly client?: OpencodeLogClient;
  private readonly debugEnabled: boolean;
  private readonly silent: boolean;

  constructor(options: LoggerOptions = {}) {
    this.client = options.client;
    this.debugEnabled = options.debug ?? false;
    this.silent = options.silent ?? false;
  }

  private emit(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (this.silent) return;

    const app = this.client?.app;
    if (app && typeof app.log === "function") {
      try {
        // Call as a method on `app` so `this` is preserved — a detached
        // reference throws inside OpenCode's class method and would be
        // swallowed, producing no log at all.
        const result = app.log({ body: { service: SERVICE, level, message, extra } });
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(undefined, () => {});
        }
        return;
      } catch {
        // Fall through to the console fallback.
      }
    }

    const line = extra
      ? `[Foresight] ${message} ${JSON.stringify(extra)}`
      : `[Foresight] ${message}`;
    console.error(line);
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
