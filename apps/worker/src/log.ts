/**
 * JSON log lines.
 *
 * One object per line on stdout, and nothing else. There is no telemetry, no
 * exporter, no network call and no OpenTelemetry bootstrap in this process: the
 * specification makes observability opt-in and no-telemetry-by-default a hard
 * rule, and a background worker is exactly where an unrequested phone-home would
 * hide. A deployment that wants spans can tail this stream.
 *
 * stdout rather than stderr because these lines *are* the worker's interface —
 * it has no HTTP surface — and the standard convention for a container's log
 * stream is stdout.
 */

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Build a logger.
 *
 * `sink` is injectable so a test can capture lines and assert their shape without
 * patching `process.stdout`, which would leak across test files in the same
 * process.
 */
export function createLogger(options: {
  readonly service: string;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, message: string, fields: Record<string, unknown> = {}): void => {
    // Keys are sorted so that two lines describing the same event diff cleanly,
    // and so a log-based assertion in a test does not depend on insertion order.
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      service: options.service,
      msg: message,
    };
    for (const key of Object.keys(fields).sort()) {
      record[key] = fields[key];
    }
    sink(JSON.stringify(record));
  };

  return {
    log,
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

/**
 * Render an unknown thrown value for a log field.
 *
 * `unknown` in a catch is deliberate repository-wide, so every error path has to
 * decide how to stringify it. Doing it in one place means a log line cannot end up
 * with `[object Object]` where the message should be.
 */
export function describeError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack !== undefined ? { error: error.message, stack: error.stack } : { error: error.message };
  }
  return { error: String(error) };
}
