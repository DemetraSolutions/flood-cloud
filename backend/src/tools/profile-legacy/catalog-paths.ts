import { Decimal128, Double, Int32, Long } from 'mongodb';
import type { Document } from 'mongodb';
import { ID_KEY } from './subobjects.ts';
import type { FlagCounts } from './subobjects.ts';
import { bsonTypeName, COLLAPSED_KEY, isPlainObject } from './walk.ts';

/** Deepest level of keys the catalog profile descends to (top-level keys are level 1). */
export const CATALOG_MAX_DEPTH = 8;

/** Safety cap on the distinct paths kept per collection, against a dynamic key that was not normalized. */
export const CATALOG_MAX_PATHS = 20_000;

/** Parents (normalized path) whose child keys are identifiers (`__<placeId>`, `__<storageId>`, supplier ids). */
const ID_MAP_PARENTS: ReadonlySet<string> = new Set([
  'quantity',
  'quantity.<id>',
  'printStations',
  'printStationsNoRooms',
  'lastAveragePrice.suppliers',
]);
/** Last path segments of the objects that map a language code to a text. */
const LANGUAGE_PARENT_NAMES: ReadonlySet<string> = new Set(['name', 'shortName', 'description', 'shortDescription']);

const LANGUAGE_KEY = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?$/;
const ID_LIKE_KEY = /^(?:__)?[0-9a-f]{24}$/i;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

/**
 * Normalizes a document key into a path segment, knowing the (already normalized) path of its parent.
 * Identifiers (`__<ObjectId>`, bare 24-digit hex) become `<id>`; the keys of the stock, print-station and
 * supplier maps become `<id>`; keys of a language map stay only when they look like a language code; any
 * other key stays only when it is a field-like word and is not a long hex string (otherwise `<key>`).
 *
 * @param parent Normalized path of the object that holds the key (`''` for the document itself).
 * @param key The key as stored.
 * @returns The segment to append to the path.
 * @example
 * normalizeCatalogKey('quantity', '__0123456789abcdef01234567'); // '<id>'
 */
export function normalizeCatalogKey(parent: string, key: string): string {
  if (ID_MAP_PARENTS.has(parent) || ID_LIKE_KEY.test(key)) {
    return ID_KEY;
  }
  if (LANGUAGE_PARENT_NAMES.has(parent.slice(parent.lastIndexOf('.') + 1))) {
    return LANGUAGE_KEY.test(key) ? key : COLLAPSED_KEY;
  }
  return SAFE_KEY.test(key) && !LONG_HEX.test(key) ? key : COLLAPSED_KEY;
}

/**
 * The numeric value of a BSON number, whatever its wrapper (documents are read with `promoteValues: false`).
 *
 * @param value Any value found in a document.
 * @returns The number (possibly `NaN` or infinite), or `undefined` when the value is not a BSON number.
 */
export function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Int32 || value instanceof Double) {
    return value.value;
  }
  if (value instanceof Long) {
    return value.toNumber();
  }
  return value instanceof Decimal128 ? Number(value.toString()) : undefined;
}

/** Counts of the numbers of a path that are not finite. */
export interface NumericAnomalies {
  nan: number;
  infinite: number;
}

/** Presence and types of one path; `flags` when booleans or nulls were seen, `numeric` when numbers were. */
export interface CatalogPathStat {
  /** Documents in which the path is present. */
  docs: number;
  /** Occurrences per BSON type (an array path counts each element). */
  types: Record<string, number>;
  /** Occurrences of `true`, `false` and `null`. Never any other value. */
  flags?: FlagCounts;
  /** `NaN` and infinite numbers among the occurrences. */
  numeric?: NumericAnomalies;
}

/** The tree of paths of a collection. */
export interface CatalogPaths {
  /** `true` when a branch was cut at {@link CATALOG_MAX_DEPTH}. */
  depthLimited: boolean;
  /** `true` when more distinct paths than the cap existed and the rest were ignored. */
  truncated: boolean;
  /** Every path, sorted, with no rarity threshold. */
  paths: Record<string, CatalogPathStat>;
}

interface Tally {
  docs: number;
  lastDoc: number;
  types: Map<string, number>;
  flags: FlagCounts | undefined;
  numeric: NumericAnomalies | undefined;
}

/**
 * Tally of the paths of whole documents: presence, BSON types, boolean/null counts and non-finite numbers.
 * It never keeps a value.
 */
export class PathTally {
  depthLimited = false;
  truncated = false;
  readonly #tallies = new Map<string, Tally>();
  readonly #maxPaths: number;

  /**
   * @param maxPaths Cap on the distinct paths kept.
   */
  constructor(maxPaths: number) {
    this.#maxPaths = maxPaths;
  }

  /**
   * Adds one document.
   *
   * @param document The document, read with `promoteValues: false`.
   * @param index Number unique to the document across the whole run (a path counts once per document).
   */
  add(document: Document, index: number): void {
    for (const [key, value] of Object.entries(document)) {
      this.#visit(value, normalizeCatalogKey('', key), 1, index);
    }
  }

  #visit(value: unknown, path: string, depth: number, index: number): void {
    this.#record(path, value, index);
    if (Array.isArray(value)) {
      for (const element of value) {
        this.#visit(element, `${path}[]`, depth, index);
      }
    } else if (isPlainObject(value)) {
      if (depth >= CATALOG_MAX_DEPTH) {
        this.depthLimited = true;
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        this.#visit(child, `${path}.${normalizeCatalogKey(path, key)}`, depth + 1, index);
      }
    }
  }

  #record(path: string, value: unknown, index: number): void {
    let tally = this.#tallies.get(path);
    if (tally === undefined) {
      if (this.#tallies.size >= this.#maxPaths) {
        this.truncated = true;
        return;
      }
      tally = { docs: 0, lastDoc: -1, types: new Map(), flags: undefined, numeric: undefined };
      this.#tallies.set(path, tally);
    }
    if (tally.lastDoc !== index) {
      tally.lastDoc = index;
      tally.docs += 1;
    }
    const type = bsonTypeName(value);
    tally.types.set(type, (tally.types.get(type) ?? 0) + 1);
    if (type === 'bool' || type === 'null') {
      tally.flags ??= { true: 0, false: 0, null: 0 };
      tally.flags[value === null ? 'null' : value === true ? 'true' : 'false'] += 1;
    }
    const number = numericValue(value);
    if (number !== undefined) {
      tally.numeric ??= { nan: 0, infinite: 0 };
      if (Number.isNaN(number)) {
        tally.numeric.nan += 1;
      } else if (!Number.isFinite(number)) {
        tally.numeric.infinite += 1;
      }
    }
  }

  /** @returns The paths found so far, sorted. */
  result(): CatalogPaths {
    const paths: Record<string, CatalogPathStat> = {};
    for (const path of [...this.#tallies.keys()].sort()) {
      const tally = this.#tallies.get(path) as Tally;
      paths[path] = {
        docs: tally.docs,
        types: Object.fromEntries([...tally.types.keys()].sort().map((type) => [type, tally.types.get(type) as number])),
        ...(tally.flags === undefined ? {} : { flags: tally.flags }),
        ...(tally.numeric === undefined ? {} : { numeric: tally.numeric }),
      };
    }
    return { depthLimited: this.depthLimited, truncated: this.truncated, paths };
  }
}
