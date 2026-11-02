import { isDeepStrictEqual } from 'node:util';
import { ObjectId } from 'mongodb';
import { isSecretKey } from '../logging/logger.ts';

/** A JSON-like value as stored in a change: ObjectIds are hex strings and dates are ISO strings. */
export type ChangeValue = string | number | boolean | null | readonly ChangeValue[] | { readonly [key: string]: ChangeValue };

/** One changed field. A missing `before` or `after` means the field was absent on that side. */
export interface FieldChange {
  /** Dotted path of the field. */
  readonly field: string;
  readonly before?: ChangeValue;
  readonly after?: ChangeValue;
  /** True when the field is sensitive: its values are never stored. */
  readonly redacted?: true;
  /** True when a string was cut to {@link MAX_STRING_LENGTH} characters. */
  readonly truncated?: true;
}

/** Options of {@link computeChanges}. */
export interface ComputeChangesOptions {
  /**
   * Extra sensitive fields. An entry without a dot names a field at any depth (`token` hides
   * `a.token`); an entry with a dot is a path (`settings.email` hides the field itself and everything below it).
   */
  readonly sensitive?: readonly string[];
}

/** Paths deeper than this many segments are compared as a whole subtree. */
export const MAX_CHANGE_DEPTH = 4;
/** Longer strings are cut and flagged. */
export const MAX_STRING_LENGTH = 1000;

/** Fields and paths that are always sensitive (on top of every name `isSecretKey` (secrets only: personal data such as names and emails stays visible) recognizes). */
export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = Object.freeze([
  'password',
  'pin',
  'tokens',
  'apiKey',
  'passwordHash',
  'legacyHashFingerprint',
  'integrations',
  'settings.integrations',
  'fattura_elettronica',
  'settings.email',
]);

type Plain = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Plain {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const MASKED = '[REDACTED]';

function isSensitive(path: string, entries: readonly string[]): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split('.');
  return (
    segments.some((segment) => isSecretKey(segment)) ||
    entries.some((entry) => {
      const wanted = entry.toLowerCase().replace(/\.$/, '').split('.');
      // A dotted entry is a run of consecutive segments anywhere in the path (`settings.email` also hides `places.settings.email.host`).
      return segments.some((_, start) => wanted.every((name, offset) => segments[start + offset] === name));
    })
  );
}

/** What {@link serialize} needs besides the value. */
interface SerializeContext {
  /** Set when a string was cut. */
  cut: boolean;
  /** Replace the values of sensitive keys found inside the value with `[REDACTED]`. */
  readonly mask: boolean;
  readonly sensitive: readonly string[];
}

/** Converts a stored value to its {@link ChangeValue}, cutting long strings and (when masking) hiding sensitive keys at any depth. */
function serialize(value: unknown, context: SerializeContext, path: string): ChangeValue {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      context.cut = true;
      return value.slice(0, MAX_STRING_LENGTH);
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => serialize(item, context, path));
  }
  if (isPlainObject(value)) {
    const result: Record<string, ChangeValue> = {};
    for (const key of Object.keys(value)) {
      const childPath = `${path}.${key}`;
      result[key] = context.mask && isSensitive(childPath, context.sensitive) ? MASKED : serialize(value[key], context, childPath);
    }
    return result;
  }
  // undefined inside a structure, bigint, driver types such as Decimal128 or Long: their text form.
  return String(value);
}

/**
 * Compares two versions of a document and lists the changed fields. Paths are flattened with `.`
 * up to {@link MAX_CHANGE_DEPTH} segments (deeper subtrees are compared and stored whole); arrays
 * are compared whole; an absent field is distinct from `null`; ObjectIds and dates are compared by
 * value and stored as hex and ISO strings; sensitive fields (any path segment that `isSecretKey` (secrets only: personal data such as names and emails stays visible)
 * recognizes, the default and extra entries) are reported as `{ field, redacted: true }` without values,
 * and a sensitive key inside a value stored whole (array, deep subtree, change of type) is replaced by `[REDACTED]`; strings over {@link MAX_STRING_LENGTH} characters are cut and flagged.
 *
 * @param before The document before the write, or `undefined` for a creation.
 * @param after The document after the write, or `undefined` for a deletion.
 * @param options Extra sensitive fields.
 * @returns The changes, in the order of the keys (before first, then new ones). Unbounded: the
 * caller caps them.
 */
export function computeChanges(before: Plain | undefined, after: Plain | undefined, options: ComputeChangesOptions = {}): FieldChange[] {
  const sensitive = [...DEFAULT_SENSITIVE_FIELDS, ...(options.sensitive ?? [])];
  const changes: FieldChange[] = [];

  const present = (value: unknown, context: SerializeContext, path: string): ChangeValue | undefined =>
    value === undefined ? undefined : serialize(value, context, path);

  const visit = (path: string, left: unknown, right: unknown, depth: number): void => {
    // Equality is decided on the real values, so a changed secret inside a whole value is still a change.
    const raw: SerializeContext = { cut: false, mask: false, sensitive };
    if (depth > 0 && isSensitive(path, sensitive)) {
      if (!isDeepStrictEqual(present(left, raw, path), present(right, raw, path))) {
        changes.push({ field: path, redacted: true });
      }
      return;
    }
    const bothTrees = (left === undefined || isPlainObject(left)) && (right === undefined || isPlainObject(right));
    if (bothTrees && depth < MAX_CHANGE_DEPTH && (left !== undefined || right !== undefined)) {
      const l = (left ?? {}) as Plain;
      const r = (right ?? {}) as Plain;
      for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
        visit(depth === 0 ? key : `${path}.${key}`, l[key], r[key], depth + 1);
      }
      return;
    }
    if (isDeepStrictEqual(present(left, raw, path), present(right, raw, path))) {
      return;
    }
    const masked: SerializeContext = { cut: false, mask: true, sensitive };
    const serializedBefore = present(left, masked, path);
    const serializedAfter = present(right, masked, path);
    changes.push({
      field: path,
      ...(serializedBefore === undefined ? {} : { before: serializedBefore }),
      ...(serializedAfter === undefined ? {} : { after: serializedAfter }),
      ...(masked.cut ? { truncated: true as const } : {}),
    });
  };

  visit('', before, after, 0);
  return changes;
}
