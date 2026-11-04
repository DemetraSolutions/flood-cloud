import { ObjectId } from 'mongodb';
import { AppError } from '../http/errors.ts';

/** The closed list of reasons a field can be rejected (`error.details[].issue`). */
export const VALIDATION_ISSUES = Object.freeze([
  'required',
  'type',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'enum',
  'unknown',
  'forbiddenKey',
  'format',
  'tooDeep',
  'tooMany',
  'incorrect',
] as const);

/** A reason a field was rejected. */
export type ValidationIssue = (typeof VALIDATION_ISSUES)[number];

/** One problem found by the validator: where (dot notation) and why. Never carries the received value. */
export interface FieldIssue {
  readonly field: string;
  readonly issue: ValidationIssue;
}

/** Deepest nesting (objects and arrays) a validated value may have. */
export const MAX_DEPTH = 8;

/** Most problems collected for one value: a hostile payload cannot make the response grow without bound. */
export const MAX_ISSUES = 50;

/** Result of a failed field: schemas return it instead of throwing so that every problem is collected. */
export const INVALID: unique symbol = Symbol('invalid');

/** Collector shared by the schemas while one value is validated. */
export interface ValidationContext {
  /** Records a problem at a path (ignored once {@link MAX_ISSUES} are collected). */
  report(path: string, issue: ValidationIssue): typeof INVALID;
}

/**
 * A declarative validator of one value. `T` is the type of the validated value and `O` tells
 * whether, inside an object, the key may be absent.
 */
export interface Schema<T, O extends boolean = boolean> {
  /** Whether a key with this schema may be missing from its object. */
  readonly optional: O;
  /**
   * Validates and converts a value.
   *
   * @param value Untrusted value.
   * @param path Dot-notation path of the value (empty for the root).
   * @param context Problem collector.
   * @param depth Nesting level of the value (1 for the root).
   * @returns The converted value, or {@link INVALID} after reporting at least one problem.
   */
  parse(value: unknown, path: string, context: ValidationContext, depth: number): T | typeof INVALID;
}

/** The TypeScript type a schema produces. */
export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;

type Shape = Readonly<Record<string, Schema<unknown>>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends Schema<unknown, true> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type InferShape<S extends Shape> = Simplify<{ [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }>;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/**
 * Tells whether an object key can never be accepted: operators (`$…`), paths (`a.b`) and the
 * prototype-pollution names.
 *
 * @param key Key of an untrusted object.
 */
export function isForbiddenKey(key: string): boolean {
  return key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key);
}

/** Name used in a `field` for a key: the key itself only if it is short and harmless, so a hostile key is never echoed. */
function keyLabel(key: string): string {
  return SAFE_KEY_NAME.test(key) && !isForbiddenKey(key) ? key : '(key)';
}

function join(path: string, segment: string): string {
  return path === '' ? segment : `${path}.${segment}`;
}

/** Builds a schema, defaulting to a required one. */
function schemaOf<T, O extends boolean>(optional: O, parse: Schema<T, O>['parse']): Schema<T, O> {
  return Object.freeze({ optional, parse });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Options of {@link string}. */
export interface StringOptions {
  /** Minimum length in UTF-16 units, after trim and normalization (default 0). */
  readonly min?: number;
  /** Maximum length in UTF-16 units, after trim and normalization. Mandatory: every string is bounded. */
  readonly max: number;
  /** Remove leading and trailing whitespace (default `false`; never trim a password). */
  readonly trim?: boolean;
  /** Pattern the final value must match. */
  readonly pattern?: RegExp;
  /** Unicode normalization form (default `NFC`); `false` keeps the value as sent. */
  readonly normalize?: 'NFC' | 'NFKC' | false;
}

/** Common checks of the string-based schemas: type, well-formed Unicode, trim and normalization. */
function readString(value: unknown, path: string, context: ValidationContext, options: { trim: boolean; normalize: 'NFC' | 'NFKC' | false }): string | typeof INVALID {
  if (typeof value !== 'string') {
    return context.report(path, 'type');
  }
  if (!value.isWellFormed()) {
    return context.report(path, 'format');
  }
  const trimmed = options.trim ? value.trim() : value;
  return options.normalize === false ? trimmed : trimmed.normalize(options.normalize);
}

/**
 * A bounded string. Rejects non-strings (`type`), ill-formed Unicode (`format`), lengths outside
 * the range (`minLength`, `maxLength`) and values not matching the pattern (`pattern`).
 *
 * @param options Bounds, trim, pattern and normalization.
 * @example
 * const name = string({ min: 1, max: 100, trim: true });
 */
export function string(options: StringOptions): Schema<string, false> {
  const { min = 0, max, trim = false, pattern, normalize = 'NFC' } = options;
  return schemaOf(false, (value, path, context) => {
    const text = readString(value, path, context, { trim, normalize });
    if (text === INVALID) {
      return INVALID;
    }
    if (text.length < min) {
      return context.report(path, 'minLength');
    }
    if (text.length > max) {
      return context.report(path, 'maxLength');
    }
    if (pattern !== undefined && !pattern.test(text)) {
      return context.report(path, 'pattern');
    }
    return text;
  });
}

/** Options of {@link integer}. */
export interface IntegerOptions {
  readonly min?: number;
  readonly max?: number;
}

/**
 * A safe integer (no coercion from strings). Out of range gives `minimum` or `maximum`.
 *
 * @param options Inclusive bounds.
 */
export function integer(options: IntegerOptions = {}): Schema<number, false> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  return schemaOf(false, (value, path, context) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return context.report(path, 'type');
    }
    if (value < min) {
      return context.report(path, 'minimum');
    }
    if (value > max) {
      return context.report(path, 'maximum');
    }
    return value;
  });
}

/** A boolean (no coercion from strings). */
export function boolean(): Schema<boolean, false> {
  return schemaOf(false, (value, path, context) => (typeof value === 'boolean' ? value : context.report(path, 'type')));
}

/**
 * One of a closed list of strings. A non-string is a `type` problem, any other string an `enum` one.
 *
 * @param values Allowed values.
 */
export function enumOf<const T extends readonly string[]>(values: T): Schema<T[number], false> {
  return schemaOf(false, (value, path, context) => {
    if (typeof value !== 'string') {
      return context.report(path, 'type');
    }
    return values.includes(value) ? (value as T[number]) : context.report(path, 'enum');
  });
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** A 24-character hexadecimal string, converted to an `ObjectId` (`format` otherwise). */
export function objectId(): Schema<ObjectId, false> {
  return schemaOf(false, (value, path, context) => {
    if (typeof value !== 'string') {
      return context.report(path, 'type');
    }
    return OBJECT_ID.test(value) ? ObjectId.createFromHexString(value) : context.report(path, 'format');
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * An ISO 8601 calendar date (`2026-10-30`) or UTC date-time (`2026-10-30T14:05:00.000Z`),
 * converted to a `Date`. Impossible dates (`2026-02-30`) are a `format` problem.
 */
export function isoDate(): Schema<Date, false> {
  return schemaOf(false, (value, path, context) => {
    if (typeof value !== 'string') {
      return context.report(path, 'type');
    }
    const dateOnly = ISO_DATE.test(value);
    if (!dateOnly && !ISO_DATE_TIME.test(value)) {
      return context.report(path, 'format');
    }
    const date = new Date(value);
    const significant = dateOnly ? 10 : 19;
    // Round trip through the calendar: `2026-02-30` would otherwise silently become March.
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, significant) !== value.slice(0, significant) ? context.report(path, 'format') : date;
  });
}

/** Longest address allowed by RFC 5321. */
const MAX_EMAIL = 254;
const MAX_EMAIL_LOCAL = 64;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * An e-mail address of reasonable syntax (ASCII, one `@`, a dotted domain), trimmed and lower-cased,
 * at most 254 characters.
 */
export function email(): Schema<string, false> {
  return schemaOf(false, (value, path, context) => {
    const text = readString(value, path, context, { trim: true, normalize: 'NFKC' });
    if (text === INVALID) {
      return INVALID;
    }
    if (text.length > MAX_EMAIL) {
      return context.report(path, 'maxLength');
    }
    const address = text.toLowerCase();
    return EMAIL.test(address) && address.indexOf('@') <= MAX_EMAIL_LOCAL ? address : context.report(path, 'format');
  });
}

const MAX_PHONE = 32;
const PHONE = /^[0-9 +()-]+$/;

/** A telephone number: digits, spaces, `+`, `-`, `(` and `)`, with at least one digit, trimmed, at most 32 characters. */
export function phone(): Schema<string, false> {
  return schemaOf(false, (value, path, context) => {
    const text = readString(value, path, context, { trim: true, normalize: false });
    if (text === INVALID) {
      return INVALID;
    }
    if (text.length > MAX_PHONE) {
      return context.report(path, 'maxLength');
    }
    return PHONE.test(text) && /\d/.test(text) ? text : context.report(path, 'format');
  });
}

/** C0 and C1 control characters and the bidirectional overrides and isolates, and invisible formatting characters (zero-width, marks, BOM, word joiner), which can disguise a name. */
const HIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\uFEFF\u2060-\u2064]/;

/**
 * A person's name: trimmed, NFC, 1 to `max` units, without control characters (C0, C1) and without
 * bidirectional overrides or isolates (U+202A to U+202E, U+2066 to U+2069), which are a `format` problem.
 *
 * @param max Longest accepted length in UTF-16 units.
 */
export function personName(max: number): Schema<string, false> {
  const text = string({ min: 1, max, trim: true });
  return schemaOf(false, (value, path, context, depth) => {
    const parsed = text.parse(value, path, context, depth);
    return parsed !== INVALID && HIDDEN_CHARACTERS.test(parsed) ? context.report(path, 'format') : parsed;
  });
}

/**
 * Also accepts an explicit `null`, which is kept.
 *
 * @param inner Schema of the non-null value.
 */
export function nullable<T, O extends boolean>(inner: Schema<T, O>): Schema<T | null, O> {
  return schemaOf(inner.optional, (value, path, context, depth) => (value === null ? null : inner.parse(value, path, context, depth)));
}

/**
 * Allows the key to be absent from its object (or `undefined`); when absent it is left out of the result.
 *
 * @param inner Schema of the value when present.
 */
export function optional<T>(inner: Schema<T>): Schema<T, true> {
  return schemaOf(true, inner.parse);
}

/** Options of {@link array}. */
export interface ArrayOptions {
  /** Minimum number of elements (default 0), reported as `minLength`. */
  readonly min?: number;
  /** Maximum number of elements, reported as `tooMany` without looking at the elements. Mandatory. */
  readonly max: number;
}

/**
 * An array whose elements all match a schema. Problems inside elements have the index in the field
 * (`placeIds.2`).
 *
 * @param item Schema of each element.
 * @param options Size bounds.
 */
export function array<T>(item: Schema<T>, options: ArrayOptions): Schema<T[], false> {
  const { min = 0, max } = options;
  return schemaOf(false, (value, path, context, depth) => {
    if (!Array.isArray(value)) {
      return context.report(path, 'type');
    }
    if (depth > MAX_DEPTH) {
      return context.report(path, 'tooDeep');
    }
    if (value.length > max) {
      return context.report(path, 'tooMany');
    }
    if (value.length < min) {
      return context.report(path, 'minLength');
    }
    const items: T[] = [];
    let valid = true;
    value.forEach((element: unknown, index) => {
      const parsed = item.parse(element, join(path, String(index)), context, depth + 1);
      if (parsed === INVALID) {
        valid = false;
      } else {
        items.push(parsed);
      }
    });
    return valid ? items : INVALID;
  });
}

/** Options of {@link object}. */
export interface ObjectOptions {
  /**
   * Silently drop properties that are not in the shape (default `false`: they are a problem).
   * Keys that are forbidden (`$…`, `a.b`, `__proto__`…) are rejected either way.
   */
  readonly allowUnknown?: boolean;
}

/**
 * An object with a closed list of properties. Rejects unknown properties (`unknown`), forbidden
 * keys (`forbiddenKey`), missing required ones (`required`) and nesting deeper than {@link MAX_DEPTH}
 * (`tooDeep`). The result holds only the declared keys.
 *
 * @param shape Schema of each property.
 * @param options Unknown-property policy.
 * @throws {Error} At definition time, if the shape itself uses a forbidden key.
 */
export function object<S extends Shape>(shape: S, options: ObjectOptions = {}): Schema<InferShape<S>, false> {
  const { allowUnknown = false } = options;
  const keys = Object.keys(shape);
  for (const key of keys) {
    if (isForbiddenKey(key)) {
      throw new Error(`Schema key "${key}" is forbidden`);
    }
  }
  return schemaOf(false, (value, path, context, depth) => {
    if (!isPlainObject(value)) {
      return context.report(path, 'type');
    }
    if (depth > MAX_DEPTH) {
      return context.report(path, 'tooDeep');
    }
    let valid = true;
    for (const key of Object.keys(value)) {
      if (isForbiddenKey(key)) {
        valid = false;
        context.report(join(path, keyLabel(key)), 'forbiddenKey');
      } else if (!allowUnknown && !Object.hasOwn(shape, key)) {
        valid = false;
        context.report(join(path, keyLabel(key)), 'unknown');
      }
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const raw = Object.hasOwn(value, key) ? value[key] : undefined;
      const field = shape[key] as Schema<unknown>;
      if (raw === undefined) {
        if (!field.optional) {
          valid = false;
          context.report(join(path, key), 'required');
        }
        continue;
      }
      const parsed = field.parse(raw, join(path, key), context, depth + 1);
      if (parsed === INVALID) {
        valid = false;
      } else {
        result[key] = parsed;
      }
    }
    return valid ? (result as InferShape<S>) : INVALID;
  });
}

/**
 * Validates an untrusted value against a schema.
 *
 * @param schema The schema.
 * @param value The untrusted value.
 * @param root Label used as `field` for problems of the value itself, such as `(body)`.
 * @returns The converted value, typed from the schema.
 * @throws {AppError} `VALIDATION_ERROR` with a `{ field, issue }` entry for every problem found
 * (at most {@link MAX_ISSUES}); the details never contain the received values.
 */
export function validate<S extends Schema<unknown>>(schema: S, value: unknown, root: string): Infer<S> {
  const issues: FieldIssue[] = [];
  const context: ValidationContext = {
    report: (path, issue) => {
      if (issues.length < MAX_ISSUES) {
        issues.push({ field: path === '' ? root : path, issue });
      }
      return INVALID;
    },
  };
  const parsed = schema.parse(value, '', context, 1);
  if (parsed === INVALID) {
    throw new AppError('VALIDATION_ERROR', { details: issues });
  }
  return parsed as Infer<S>;
}
