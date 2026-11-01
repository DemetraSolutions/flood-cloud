import { Secret, REDACTED } from '../security/secret.ts';

/** Severity of a log event. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Destination of the serialized log lines (stdout in production, memory in tests). */
export interface LogSink {
  /** Receives one complete JSON line, without trailing newline. */
  write(line: string): void;
}

/** Structured logger writing one JSON line per event. */
export interface Logger {
  debug(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Normalized (lower case, alphanumerics only) field names that are always redacted. */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'pin',
  'name',
  'email',
  'telephone',
  'phone',
  'surname',
  'firstname',
  'lastname',
  'fiscalcode',
  'mongodburi',
]);

/** Substrings of a normalized field name that make it sensitive. */
export const REDACTED_KEY_PARTS: readonly string[] = [
  'password',
  'passcode',
  'secret',
  'token',
  'apikey',
  'pepper',
  'authorization',
  'cookie',
  'privatekey',
  'credential',
  'signature',
];

/** Substrings that mark a string value as a credential (token prefixes and connection strings). */
export const REDACTED_VALUE_MARKERS: readonly string[] = [
  'fc_at_',
  'fc_rt_',
  'fc_pk_',
  'mongodb://',
  'mongodb+srv://',
];

const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const UNREADABLE = '[Unreadable]';
const MAX_DEPTH = 10;
const DUPLICATE_KEY_DETAIL = /dup key: \{.*?\}/gs;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return REDACTED_KEYS.has(normalized) || REDACTED_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactString(value: string): string {
  if (REDACTED_VALUE_MARKERS.some((marker) => value.includes(marker))) {
    return REDACTED;
  }
  return value.replace(DUPLICATE_KEY_DETAIL, 'dup key: [REDACTED]');
}

function serializeError(error: Error): Record<string, unknown> {
  if (error.name.startsWith('Mongo')) {
    // Driver errors can embed documents and connection details: keep only the diagnostic codes.
    const { code, codeName } = error as { code?: unknown; codeName?: unknown };
    return { name: error.name, code, codeName };
  }
  // Error fields are not subject to key redaction (`name` is the error class),
  // but their text still is, because messages can embed connection strings.
  return {
    name: error.name,
    message: redactString(error.message),
    stack: error.stack === undefined ? undefined : redactString(error.stack),
  };
}

function redactRawHeaders(list: readonly unknown[], depth: number, ancestors: Set<object>): unknown[] {
  return list.map((item, index) => {
    const previous = list[index - 1];
    return index % 2 === 1 && typeof previous === 'string' && isSensitiveKey(previous)
      ? REDACTED
      : redactValue(item, depth + 1, ancestors);
  });
}

function redactValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (value instanceof Secret) {
    return REDACTED;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactValue(item, depth + 1, ancestors));
    }
    return redactFields(value as Record<string, unknown>, depth + 1, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

/** Builds a prototype-less object so that a `__proto__` key stays a plain logged field. */
function redactFields(fields: Readonly<Record<string, unknown>>, depth: number, ancestors: Set<object>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    let redacted: unknown;
    if (isSensitiveKey(key)) {
      redacted = REDACTED;
    } else {
      try {
        const value = fields[key];
        redacted =
          normalizeKey(key) === 'rawheaders' && Array.isArray(value)
            ? redactRawHeaders(value, depth, ancestors)
            : redactValue(value, depth, ancestors);
      } catch {
        redacted = UNREADABLE;
      }
    }
    Object.defineProperty(result, key, { value: redacted, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/**
 * Deeply copies a value, replacing sensitive keys, credential-looking strings
 * and {@link Secret} instances with `[REDACTED]`. Handles arrays, nested objects
 * and circular references. `Error` instances become `{ name, message, stack }`.
 *
 * @param value Any value destined to a log line.
 * @returns A JSON-safe, redacted copy.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new Set());
}

/**
 * Creates a JSON-lines logger. Every event is `{ time, level, msg, ...fields }`
 * with the extra fields deeply redacted (see {@link redact}); the reserved
 * keys cannot be overridden by the extra fields.
 *
 * @param sink Where the serialized lines go.
 * @returns A {@link Logger}.
 * @example
 * const logger = createLogger({ write: (line) => process.stdout.write(`${line}\n`) });
 * logger.info('server started', { port: 3000 });
 */
export function createLogger(sink: LogSink): Logger {
  const log = (level: LogLevel, msg: string, fields: Readonly<Record<string, unknown>> = {}): void => {
    const event = redactFields(fields, 0, new Set());
    event['time'] = new Date().toISOString();
    event['level'] = level;
    event['msg'] = redactString(msg);
    sink.write(JSON.stringify(event));
  };
  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };
}
