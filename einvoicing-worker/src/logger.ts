import type { LogLevel } from './config.ts';
import { LOG_LEVELS } from './config.ts';
import { REDACTED, Secret } from './secret.ts';

/** Structured fields attached to a log line. */
export type LogFields = Readonly<Record<string, unknown>>;

/** JSON-lines logger. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Collaborators of {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level written. */
  readonly level: LogLevel;
  /** Receives one JSON line, without the trailing newline. */
  readonly write: (line: string) => void;
  /** Current time in milliseconds since the epoch. */
  readonly now: () => number;
}

/** Keys whose value is replaced by a placeholder, wherever they appear in the fields (case-insensitive substring). */
const SECRET_KEY = /uri|password|passwd|secret|token|authorization|api[-_]?key|credential|cookie|pepper/i;
const MAX_DEPTH = 4;

/**
 * Turns a field value into something safe to serialize: errors become name, code and message,
 * values under a secret-looking key become {@link REDACTED}, nesting is bounded.
 */
function sanitize(value: unknown, depth: number): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}), message: value.message };
  }
  if (value instanceof Secret) {
    return REDACTED;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : sanitize(inner, depth + 1);
  }
  return out;
}

/**
 * Creates a logger writing one JSON object per line (`time`, `level`, `message`, then the fields).
 * Fields under keys that look like secrets are redacted; `Error` values keep only name, code and message.
 *
 * @param options Level, sink and clock.
 * @returns The logger.
 * @example
 * createLogger({ level: 'info', write: console.log, now: Date.now }).info('started', { port: 8080 });
 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level);
  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) {
      return;
    }
    const line = JSON.stringify({ time: new Date(options.now()).toISOString(), level, message, ...(sanitize(fields, 0) as object) });
    options.write(line);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
