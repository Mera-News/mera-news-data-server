/**
 * Structured JSON logger for the Job Execution Model (plan "Logging policy").
 *
 * - JSON to stdout, one object per line, GCP-severity tagged.
 * - Levels are the alerting contract, not style: info = cumulative run narrative,
 *   warn = recoverable anomalies (DLQ, safety block, cap hit), error = infra-fatal.
 * - `debug` is a reserved level: NO debug lines are written by this codebase.
 *   `LOG_LEVEL=debug` would enable them once someone adds them.
 * - Default level: info.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const GCP_SEVERITY: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

export interface JobLoggerOptions {
  /** Stamped onto every line as `job`. */
  job: string;
  /** Minimum level to emit. Default `info`. */
  level?: LogLevel;
  /** Sink; defaults to stdout. Injected in tests. */
  write?: (line: string) => void;
  /** Clock; injected in tests. */
  now?: () => Date;
}

export type LogFields = Record<string, unknown>;

export class JobLogger {
  private readonly job: string;
  private readonly threshold: number;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(opts: JobLoggerOptions) {
    this.job = opts.job;
    this.threshold = LEVEL_ORDER[opts.level ?? 'info'];
    this.write =
      opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
    this.now = opts.now ?? (() => new Date());
  }

  /** Parse a LOG_LEVEL string, falling back to `info` for anything unknown. */
  static parseLevel(raw?: string): LogLevel {
    const v = (raw ?? '').trim().toLowerCase();
    return v === 'debug' || v === 'info' || v === 'warn' || v === 'error'
      ? v
      : 'info';
  }

  private emit(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const entry = {
      severity: GCP_SEVERITY[level],
      level,
      timestamp: this.now().toISOString(),
      job: this.job,
      message,
      ...fields,
    };
    this.write(JSON.stringify(entry));
  }

  info(message: string, fields: LogFields = {}): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.emit('error', message, fields);
  }

  /**
   * Reserved. Intentionally emits nothing unless LOG_LEVEL=debug — kept so the
   * runner can call it without debug lines
   * sprinkled through the code. Do NOT add debug logging in v3 code.
   */
  debug(message: string, fields: LogFields = {}): void {
    this.emit('debug', message, fields);
  }
}
