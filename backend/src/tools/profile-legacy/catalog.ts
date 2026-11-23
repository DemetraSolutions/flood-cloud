import { BSON } from 'mongodb';
import type { Db, Document, ObjectId } from 'mongodb';
import type { AppEnv } from '../../config.ts';
import type { Databases } from '../../db/databases.ts';
import { CATALOG_COLLECTIONS, OPEN } from './catalog-open.ts';
import type { CatalogCollection } from './catalog-open.ts';
import { CATALOG_MAX_PATHS, PathTally } from './catalog-paths.ts';
import type { CatalogPaths } from './catalog-paths.ts';
import { BandTally, BrandsAnalyzer, CategoriesAnalyzer, DepartmentsAnalyzer, ProductsAnalyzer } from './catalog-checks.ts';
import type { GroupContext } from './catalog-checks.ts';
import { indexUnion, listIndexInfo } from './indexes.ts';
import type { IndexUsage } from './indexes.ts';
import { hasCollection, streamDocuments } from './read.ts';
import { PROGRESS_INTERVAL } from './tenants.ts';
import type { GroupDatabaseRef } from './tenants.ts';
import { isPlainObject } from './walk.ts';

/** Upper bounds of the bands of the documents per group. */
const DOCUMENT_BANDS = [0, 1, 10, 100, 1000, 10_000, 100_000] as const;
/** Upper bounds, in bytes, of the bands of the BSON size of a document. */
const SIZE_BANDS = [1024, 4096, 16_384, 65_536, 262_144, 1_048_576] as const;

/** What is known of one catalog collection over all the groups. */
export interface CatalogCollectionProfile extends CatalogPaths {
  /** Group databases in which the collection exists. */
  groupsWithCollection: number;
  /** Documents over all the groups. */
  documents: number;
  /** Documents per group (groups with the collection only). */
  documentsPerGroup: { max: number; bands: Record<string, number> };
  /** BSON size of a document in bytes. */
  bsonSize: { max: number; bands: Record<string, number> };
  /** Indexes, merged by name, keys and flags, with the number of group databases that have each. */
  indexes: IndexUsage[];
}

/** The report of `--focus catalog`: counts, types and shapes only. */
export interface CatalogProfile {
  generatedAt: string;
  appEnv: AppEnv;
  focus: 'catalog';
  groups: {
    /** Group databases read. */
    databases: number;
    /** Group databases found; larger than `databases` when only a sample was read. */
    available: number;
    /** Group databases whose group has a document in the common database. */
    withCommonDocument: number;
    /** Group databases whose group has no document in the common database (price lists and taxes cannot be checked). */
    withoutCommonDocument: number;
  };
  collections: Record<CatalogCollection, CatalogCollectionProfile>;
  checks: {
    products: ReturnType<ProductsAnalyzer['result']>;
    products_categories: ReturnType<CategoriesAnalyzer['result']>;
    products_departments: ReturnType<DepartmentsAnalyzer['result']>;
    products_brands: ReturnType<BrandsAnalyzer['result']>;
  };
}

/** Options of {@link profileCatalog}. */
export interface CatalogOptions {
  /** Environment of the databases being profiled. */
  readonly appEnv: AppEnv;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /** Called with `(done, total)` after every `progressEvery` group databases. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Progress interval in group databases ({@link PROGRESS_INTERVAL} by default). */
  readonly progressEvery?: number;
  /** Cap on distinct paths per collection ({@link CATALOG_MAX_PATHS} by default); tests lower it. */
  readonly maxPaths?: number;
  /** Number of group databases to read, evenly spaced over the list of all of them; every database when absent or not smaller than the total. */
  readonly sample?: number;
}

/**
 * Picks `size` items evenly spaced over a list, keeping their order: the same list always gives the same choice.
 *
 * @param items The whole list.
 * @param size How many to keep (a positive integer).
 * @returns The chosen items, or the whole list when `size` is not smaller than its length.
 * @example
 * sampleEvenly([1, 2, 3, 4, 5, 6], 3); // [1, 3, 5]
 */
export function sampleEvenly<T>(items: readonly T[], size: number): T[] {
  if (size >= items.length) {
    return [...items];
  }
  return Array.from({ length: size }, (_, position) => items[Math.floor((position * items.length) / size)] as T);
}

/** Accumulates the numbers of one collection over all the groups. */
class CollectionAccumulator {
  groupsWithCollection = 0;
  documents = 0;
  readonly #paths: PathTally;
  readonly #perGroup = new BandTally(DOCUMENT_BANDS);
  readonly #sizes = new BandTally(SIZE_BANDS);
  readonly #indexes = indexUnion();
  #maxPerGroup = 0;
  #maxSize = 0;

  constructor(maxPaths: number) {
    this.#paths = new PathTally(maxPaths);
  }

  addDocument(document: Document): void {
    const size = BSON.calculateObjectSize(document);
    this.#maxSize = Math.max(this.#maxSize, size);
    this.#sizes.add(size);
    this.#paths.add(document, this.documents);
    this.documents += 1;
  }

  async endGroup(count: number, db: Db, collection: CatalogCollection): Promise<void> {
    this.groupsWithCollection += 1;
    this.#maxPerGroup = Math.max(this.#maxPerGroup, count);
    this.#perGroup.add(count);
    this.#indexes.add(await listIndexInfo(db, OPEN[collection](db)));
  }

  result(): CatalogCollectionProfile {
    return {
      groupsWithCollection: this.groupsWithCollection,
      documents: this.documents,
      documentsPerGroup: { max: this.#maxPerGroup, bands: this.#perGroup.result() },
      bsonSize: { max: this.#maxSize, bands: this.#sizes.result() },
      ...this.#paths.result(),
      indexes: this.#indexes.result(),
    };
  }
}

/** Reads the `_id` of every document of a collection that exists, as text (`ObjectId` as lowercase hex). */
async function readIds(db: Db, collection: CatalogCollection | 'places', present: ReadonlySet<string>): Promise<Set<string>> {
  const ids = new Set<string>();
  if (present.has(collection)) {
    for await (const document of streamDocuments(OPEN[collection](db), {}, { _id: 1 })) {
      ids.add(String(document['_id']));
    }
  }
  return ids;
}

/** What the group document of the common database says about price lists and taxes. */
interface GroupCommonData {
  priceLists: Set<string>;
  taxes: Map<string, Document>;
}

/** Reads the keys of `priceLists` and the taxes (by `id`) of a group; `undefined` when the group has no document. */
async function readGroupCommonData(common: Db, groupId: ObjectId): Promise<GroupCommonData | undefined> {
  for await (const group of streamDocuments(common.collection('groups'), { _id: groupId }, { _id: 0, priceLists: 1, taxes: 1 })) {
    const taxes = new Map<string, Document>();
    for (const tax of Array.isArray(group['taxes']) ? group['taxes'] : []) {
      if (isPlainObject(tax) && typeof tax['id'] === 'string') {
        taxes.set(tax['id'], tax);
      }
    }
    return { priceLists: new Set(isPlainObject(group['priceLists']) ? Object.keys(group['priceLists']) : []), taxes };
  }
  return undefined;
}

/**
 * Profiles the five catalog collections of every group database, one database at a time, in read-only
 * mode: the tree of paths with BSON types, sizes, indexes, enumerated values, duplicates, references
 * (checked inside the group database, and against `priceLists` and `taxes` of the group document in the
 * common database) and shapes. The report holds counts only: never a value of a document, an id, a database
 * or group name.
 *
 * @param databases Database accessor (every cluster is read).
 * @param options Environment, clock, progress, path cap and optional sample size.
 * @returns The report.
 * @example
 * const report = await profileCatalog(databases, { appEnv: 'development' });
 */
export async function profileCatalog(databases: Databases, options: CatalogOptions): Promise<CatalogProfile> {
  const common = databases.common();
  const found: GroupDatabaseRef[] = [];
  for (const clusterId of databases.clusterIds) {
    found.push(...(await databases.listGroupIds(clusterId)).map((groupId) => ({ groupId, clusterId })));
  }
  const refs = options.sample === undefined ? found : sampleEvenly(found, options.sample);
  const maxPaths = options.maxPaths ?? CATALOG_MAX_PATHS;
  const progressEvery = options.progressEvery ?? PROGRESS_INTERVAL;
  const accumulators = Object.fromEntries(CATALOG_COLLECTIONS.map((name) => [name, new CollectionAccumulator(maxPaths)])) as Record<CatalogCollection, CollectionAccumulator>;
  const products = new ProductsAnalyzer();
  const categories = new CategoriesAnalyzer();
  const departments = new DepartmentsAnalyzer();
  const brands = new BrandsAnalyzer();
  const handlers: Record<CatalogCollection, ((document: Document, context: GroupContext) => void) | undefined> = {
    products: (document, context) => products.add(document, context),
    products_categories: (document, context) => categories.add(document, context),
    products_departments: (document, context) => departments.add(document, context),
    products_brands: (document, context) => brands.add(document, context),
    products_attributes: undefined,
  };
  const groups = { databases: refs.length, available: found.length, withCommonDocument: 0, withoutCommonDocument: 0 };

  for (const [position, { groupId, clusterId }] of refs.entries()) {
    const db = databases.group(groupId, clusterId);
    const present = new Set<string>();
    for (const name of [...CATALOG_COLLECTIONS, 'places'] as const) {
      if (await hasCollection(db, name)) {
        present.add(name);
      }
    }
    const commonData = await readGroupCommonData(common, groupId);
    groups[commonData === undefined ? 'withoutCommonDocument' : 'withCommonDocument'] += 1;
    const context: GroupContext = {
      products: await readIds(db, 'products', present),
      categories: await readIds(db, 'products_categories', present),
      brands: await readIds(db, 'products_brands', present),
      places: await readIds(db, 'places', present),
      priceLists: commonData?.priceLists,
      taxes: commonData?.taxes,
      taxIds: commonData === undefined ? undefined : new Set(commonData.taxes.keys()),
    };
    for (const name of CATALOG_COLLECTIONS) {
      if (!present.has(name)) {
        continue;
      }
      const accumulator = accumulators[name];
      const handler = handlers[name];
      let count = 0;
      for await (const document of streamDocuments(OPEN[name](db), {}, {})) {
        accumulator.addDocument(document);
        handler?.(document, context);
        count += 1;
      }
      await accumulator.endGroup(count, db, name);
    }
    products.endGroup();
    categories.endGroup();
    departments.endGroup();
    if ((position + 1) % progressEvery === 0) {
      options.onProgress?.(position + 1, refs.length);
    }
  }

  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    appEnv: options.appEnv,
    focus: 'catalog',
    groups,
    collections: Object.fromEntries(CATALOG_COLLECTIONS.map((name) => [name, accumulators[name].result()])) as Record<CatalogCollection, CatalogCollectionProfile>,
    checks: {
      products: products.result(),
      products_categories: categories.result(),
      products_departments: departments.result(),
      products_brands: brands.result(),
    },
  };
}
