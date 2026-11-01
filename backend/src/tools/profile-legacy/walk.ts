/** Deepest level of keys the field inventory descends to (top-level keys are level 1). */
export const MAX_DEPTH = 4;

/** Placeholder standing in for any map key that could be an identifier or personal data. */
export const COLLAPSED_KEY = '<key>';

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const REGEX_SPECIAL = '.*+?^${}()|[]\\';

const BSON_TYPE_NAMES: Readonly<Record<string, string>> = {
  Int32: 'int',
  Long: 'long',
  Double: 'double',
  Decimal128: 'decimal',
  ObjectId: 'objectId',
  Binary: 'binData',
};

/** A plain document or sub-document (never an array, a date or a BSON wrapper). */
export type PlainObject = Record<string, unknown>;

/**
 * Tells whether a value is a plain document as produced by the BSON deserializer.
 *
 * @param value Any value.
 * @returns `true` for plain objects only.
 */
export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Names the BSON type of a deserialized value. Documents must be read with `promoteValues: false`
 * so that integers, longs and doubles stay distinguishable.
 *
 * @param value A value found in a document.
 * @returns One of `null`, `string`, `bool`, `int`, `long`, `double`, `decimal`, `objectId`, `binData`,
 * `date`, `array`, `object` or `other`.
 */
export function bsonTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'double';
    default:
      break;
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value instanceof Date) {
    return 'date';
  }
  if (isPlainObject(value)) {
    return 'object';
  }
  const bsonType = typeof value === 'object' ? (value as { _bsontype?: unknown })._bsontype : undefined;
  return (typeof bsonType === 'string' ? BSON_TYPE_NAMES[bsonType] : undefined) ?? 'other';
}

/**
 * Turns a document key into a safe path segment. Only short field-like words survive; anything
 * else collapses to {@link COLLAPSED_KEY}: free text, e-mail addresses, numbers, hex strings of
 * 16 or more characters, keys with four or more digits (tax codes, VAT numbers) and mixed
 * letter-and-digit keys longer than 12 characters (fiscal codes, tokens).
 *
 * @param key A key of a document.
 * @returns The key itself when it is a short field-like word, otherwise `<key>`.
 */
export function collapseKey(key: string): string {
  if (!PLAIN_KEY.test(key) || LONG_HEX.test(key) || key.split(/\d/).length - 1 >= 4) {
    return COLLAPSED_KEY;
  }
  return key.length > 12 && /[A-Za-z]/.test(key) && /\d/.test(key) ? COLLAPSED_KEY : key;
}

/** Receives every value of a document with its normalized path (`a.b[].c`). */
export type Visitor = (path: string, value: unknown) => void;

function walkValue(value: unknown, path: string, depth: number, visit: Visitor): void {
  visit(path, value);
  if (Array.isArray(value)) {
    for (const element of value) {
      walkValue(element, `${path}[]`, depth, visit);
    }
  } else if (isPlainObject(value) && depth < MAX_DEPTH) {
    walkKeys(value, path, depth + 1, visit);
  }
}

function walkKeys(object: PlainObject, prefix: string, depth: number, visit: Visitor): void {
  for (const [key, value] of Object.entries(object)) {
    const segment = collapseKey(key);
    walkValue(value, prefix === '' ? segment : `${prefix}.${segment}`, depth, visit);
  }
}

/**
 * Visits every value of a document down to {@link MAX_DEPTH} levels of keys. Array elements are
 * reported under `<path>[]`; map keys are collapsed by {@link collapseKey}.
 *
 * @param document A document read from MongoDB.
 * @param visit Called for each value with its normalized path.
 */
export function walkDocument(document: PlainObject, visit: Visitor): void {
  walkKeys(document, '', 1, visit);
}

/**
 * Compiles a path pattern (`devices[].type`, `warehouseRules.*.type`) where `*` stands for exactly
 * one path segment.
 *
 * @param pattern The pattern, relative to the collection.
 * @returns A regular expression matching normalized paths.
 */
export function compilePathPattern(pattern: string): RegExp {
  const body = pattern
    .split('.')
    .map((segment) =>
      segment === '*' ? '[^.]+' : [...segment].map((char) => (REGEX_SPECIAL.includes(char) ? `\\${char}` : char)).join(''),
    )
    .join('\\.');
  return new RegExp(`^${body}$`);
}
