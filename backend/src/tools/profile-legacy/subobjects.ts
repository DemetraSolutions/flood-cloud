import type { Db, Document } from 'mongodb';
import type { AppEnv } from '../../config.ts';
import { streamDocuments } from './read.ts';
import { bsonTypeName, COLLAPSED_KEY, isPlainObject } from './walk.ts';

/** Deepest level of keys below a root that the sub-object profile descends to (the root itself is level 0). */
export const MAX_SUBOBJECT_DEPTH = 8;

/** Safety cap on the distinct paths kept per root, against an unknown dynamic key that was not normalized. */
export const MAX_SUBOBJECT_PATHS = 20_000;

/** Placeholder of a map key that is an identifier. */
export const ID_KEY = '<id>';
/** Placeholder of a map key that is a code. */
export const CODE_KEY = '<code>';
/** Placeholder of a map key that is a date. */
export const DATE_KEY = '<date>';
/** Placeholder of a map key that is a day of the week. */
export const DAY_KEY = '<day>';

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const DAY = /^[0-6]$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

/** Roots profiled for each common collection. */
export const SUBOBJECT_ROOTS: Readonly<Record<'users' | 'groups', readonly string[]>> = {
  users: ['permissions', 'settings', 'shiftTime'],
  groups: [
    'settings',
    'priceLists',
    'taxes',
    'currencies',
    'measureUnits',
    'warehouseRules',
    'fidelityCardRules',
    'fidelity',
    'productsFavorites',
    'promotions',
  ],
};

/** Parents (normalized path) whose child keys are identifiers. */
const ID_PARENTS: ReadonlySet<string> = new Set([
  'priceLists',
  'measureUnits',
  'warehouseRules',
  'permissions.apps.cash.options.priceLists',
]);
/** Parents whose child keys are codes. */
const CODE_PARENTS: ReadonlySet<string> = new Set(['fidelityCardRules']);
/** Parents whose child keys are dates. */
const DATE_PARENTS: ReadonlySet<string> = new Set(['shiftTime.daySpecial']);
/** Parents whose child keys are days of the week (0-6). */
const DAY_PARENTS: ReadonlySet<string> = new Set(['shiftTime.weeksGeneric[].days', 'shiftTime.weekGeneric', 'shiftTime.weekGeneric.days']);
/** Parents whose child keys are ISO currency codes. */
const CURRENCY_PARENT = 'currencies';

/**
 * Normalizes a map key into a path segment, knowing the (already normalized) path of its parent.
 * Real identifiers and dates never leave: only field-like words, ISO currency codes and day numbers do.
 *
 * @param parent Normalized path of the object that holds the key.
 * @param key The key as stored.
 * @returns The segment to append to the path.
 */
export function normalizeSubobjectKey(parent: string, key: string): string {
  if (ID_PARENTS.has(parent)) {
    return ID_KEY;
  }
  if (CODE_PARENTS.has(parent)) {
    return CODE_KEY;
  }
  if (DATE_PARENTS.has(parent)) {
    return DATE_KEY;
  }
  if (parent === CURRENCY_PARENT) {
    return ISO_CURRENCY.test(key) ? key : CODE_KEY;
  }
  if (DAY_PARENTS.has(parent) && DAY.test(key)) {
    return DAY_KEY;
  }
  return SAFE_KEY.test(key) && !LONG_HEX.test(key) ? key : COLLAPSED_KEY;
}

/** Counts of the values of a boolean or null path. */
export interface FlagCounts {
  true: number;
  false: number;
  null: number;
}

/** Presence and types of one path; `flags` only when booleans or nulls were seen there. */
export interface SubobjectPathStat {
  /** Documents in which the path is present. */
  docs: number;
  /** Occurrences per BSON type (an array path counts each element). */
  types: Record<string, number>;
  /** Occurrences of `true`, `false` and `null`. Never any other value. */
  flags?: FlagCounts;
}

/** Everything learned about one root. */
export interface SubobjectRootProfile {
  /** Documents in which the root is present. */
  documents: number;
  /** `true` when a branch was cut at {@link MAX_SUBOBJECT_DEPTH}. */
  depthLimited: boolean;
  /** `true` when more distinct paths than the cap existed and the rest were ignored. */
  truncated: boolean;
  /** Every path under the root (the root included), sorted, with no rarity threshold. */
  paths: Record<string, SubobjectPathStat>;
}

/** The report of `--focus subobjects`: counts, types and flags only. */
export interface SubobjectsProfile {
  generatedAt: string;
  appEnv: AppEnv;
  focus: 'subobjects';
  collections: Record<'users' | 'groups', { documents: number; roots: Record<string, SubobjectRootProfile> }>;
}

interface Tally {
  docs: number;
  lastDoc: number;
  types: Map<string, number>;
  flags: FlagCounts | undefined;
}

class RootAccumulator {
  documents = 0;
  depthLimited = false;
  truncated = false;
  readonly #tallies = new Map<string, Tally>();
  readonly #maxPaths: number;

  constructor(maxPaths: number) {
    this.#maxPaths = maxPaths;
  }

  /** Adds the value of the root of one document (`index` is unique per document). */
  add(root: string, value: unknown, index: number): void {
    this.documents += 1;
    this.#visit(value, root, 0, index);
  }

  #visit(value: unknown, path: string, depth: number, index: number): void {
    this.#record(path, value, index);
    if (Array.isArray(value)) {
      for (const element of value) {
        this.#visit(element, `${path}[]`, depth, index);
      }
    } else if (isPlainObject(value)) {
      if (depth >= MAX_SUBOBJECT_DEPTH) {
        this.depthLimited = true;
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        this.#visit(child, `${path}.${normalizeSubobjectKey(path, key)}`, depth + 1, index);
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
      tally = { docs: 0, lastDoc: -1, types: new Map(), flags: undefined };
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
  }

  result(): SubobjectRootProfile {
    const paths: Record<string, SubobjectPathStat> = {};
    for (const path of [...this.#tallies.keys()].sort()) {
      const tally = this.#tallies.get(path) as Tally;
      paths[path] = {
        docs: tally.docs,
        types: Object.fromEntries([...tally.types.keys()].sort().map((type) => [type, tally.types.get(type) as number])),
        ...(tally.flags === undefined ? {} : { flags: tally.flags }),
      };
    }
    return { documents: this.documents, depthLimited: this.depthLimited, truncated: this.truncated, paths };
  }
}

async function profileCollection(
  name: 'users' | 'groups',
  documents: AsyncIterable<Document>,
  maxPaths: number,
): Promise<SubobjectsProfile['collections']['users']> {
  const roots = SUBOBJECT_ROOTS[name];
  const accumulators = new Map(roots.map((root) => [root, new RootAccumulator(maxPaths)]));
  let count = 0;
  for await (const document of documents) {
    for (const [root, accumulator] of accumulators) {
      if (document[root] !== undefined) {
        accumulator.add(root, document[root], count);
      }
    }
    count += 1;
  }
  return { documents: count, roots: Object.fromEntries([...accumulators].map(([root, accumulator]) => [root, accumulator.result()])) };
}

/** Options of {@link profileSubobjects}. */
export interface SubobjectsOptions {
  readonly appEnv: AppEnv;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /** Cap on distinct paths per root ({@link MAX_SUBOBJECT_PATHS} by default); tests lower it. */
  readonly maxPaths?: number;
}

/**
 * Profiles the full key tree of selected sub-objects of the common `users` and `groups` collections.
 * Read-only: one streamed `find` per collection, with a projection on the roots only. The report holds
 * counts, BSON types and true/false/null counts; it never holds a string or numeric value or an id.
 *
 * @param common The common database.
 * @param options Environment, clock and path cap.
 * @returns The report.
 * @example
 * const report = await profileSubobjects(databases.common(), { appEnv: 'development' });
 */
export async function profileSubobjects(common: Db, options: SubobjectsOptions): Promise<SubobjectsProfile> {
  const maxPaths = options.maxPaths ?? MAX_SUBOBJECT_PATHS;
  const projection = (roots: readonly string[]): Document => ({ _id: 0, ...Object.fromEntries(roots.map((root) => [root, 1])) });
  const users = await profileCollection('users', streamDocuments(common.collection('users'), {}, projection(SUBOBJECT_ROOTS.users)), maxPaths);
  const groups = await profileCollection('groups', streamDocuments(common.collection('groups'), {}, projection(SUBOBJECT_ROOTS.groups)), maxPaths);
  return { generatedAt: (options.now ?? (() => new Date()))().toISOString(), appEnv: options.appEnv, focus: 'subobjects', collections: { users, groups } };
}
