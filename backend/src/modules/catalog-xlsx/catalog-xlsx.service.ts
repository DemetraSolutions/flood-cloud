import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ActivityEntry } from '../../shared/activity-log/activity-log.ts';
import { createCatalogLock } from '../../shared/locks/catalog-lock.ts';
import type { CatalogLock } from '../../shared/locks/catalog-lock.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { xlsxChunks } from '../../shared/xlsx/writer.ts';
import type { XlsxSheet } from '../../shared/xlsx/writer.ts';
import { PRODUCTS_CATEGORIES_OWNED_FIELDS } from '../../db/collections.ts';
import { textOf, valueAt } from '../groups/catalogs/kit.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { currencies } from '../groups/catalogs/currencies.ts';
import type { Currency } from '../groups/catalogs/currencies.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { createReferencesRepository } from '../groups/catalogs/references.repository.ts';
import { taxes } from '../groups/catalogs/taxes.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';
import { actorOfCaller } from '../product-catalog/caller.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { createPlaceCounter, withSoleLocation } from '../product-catalog/availability.ts';
import { entityVersion } from '../product-catalog/entity.service.ts';
import { createGroupLanguages } from '../product-catalog/group-languages.ts';
import { createProductReferences } from '../product-catalog/product-references.ts';
import { createCategoryPlaces } from '../product-categories/categories.places.ts';
import { createCategoriesRepository } from '../product-categories/categories.repository.ts';
import { categoriesListFor } from '../product-categories/categories.schemas.ts';
import { createCategoriesService } from '../product-categories/categories.service.ts';
import { createProductLinks } from '../products/products.links.ts';
import { PRODUCT_COST_FIELDS } from '../products/products.mapper.ts';
import { createProductsRepository } from '../products/products.repository.ts';
import { productsListFor } from '../products/products.schemas.ts';
import { createProductsService, productVersion } from '../products/products.service.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { ImportRefusal } from './catalog-xlsx.errors.ts';
import { categoryRow, productRow, sheetHeaders } from './catalog-xlsx.export.ts';
import type { ReferenceMode, Refs } from './catalog-xlsx.export.ts';
import { runImport } from './catalog-xlsx.import.ts';
import type { ImportGraph, ImportRefs, ImportReport, SheetCounts } from './catalog-xlsx.import.ts';
import { parseWorkbook } from './catalog-xlsx.parse.ts';
import { createCatalogXlsxRepository } from './catalog-xlsx.repository.ts';
import type { CatalogXlsxRepository } from './catalog-xlsx.repository.ts';
import type { SheetKind } from './catalog-xlsx.columns.ts';
import { SHEET_NAMES } from './catalog-xlsx.columns.ts';

/** Most products (or variants) one export holds: more is `413` and the filters of the catalog (a place) are the way to narrow it. */
export const MAX_EXPORT_PRODUCTS = 20_000;

/** Longest an import may run, in milliseconds: well below the lifetime MongoDB gives a transaction (60 seconds). */
export const MAX_IMPORT_MS = 15_000;

/** Rows read at a time while the workbook is written. */
const EXPORT_BATCH = 100;

/** The file an export or the model answers with: the bytes, written as they are read. */
export interface WorkbookFile {
  readonly chunks: AsyncGenerator<Buffer>;
  /** The name of the file, made by the server. */
  readonly fileName: string;
}

/** What an import answers with: the counts of the documents really written (or, for a dry run, that would be written) of each sheet. */
export interface ImportOutcome {
  readonly dryRun: boolean;
  readonly sheets: Readonly<Record<SheetKind, SheetCounts>>;
}

/** The workbook of the catalog of a group. */
export interface CatalogXlsxService {
  /**
   * The empty workbook: the three sheets with their headers, and the columns of the points of sale of the caller's perimeter.
   *
   * @throws {AppError} `PAYLOAD_TOO_LARGE` when the perimeter has more points of sale than the workbook has columns for.
   */
  template(principal: CatalogCaller, access: GroupAccess): Promise<WorkbookFile>;
  /**
   * The catalog the caller reaches as a workbook: the enabled products of the types product, service and exempt (sheet `Prodotti`), the enabled variants (`Varianti`) and the enabled categories (`Categorie`), by name,
   * the references written as ids or as names. The size is checked before the first byte.
   *
   * @throws {AppError} `PAYLOAD_TOO_LARGE` when there are more than {@link MAX_EXPORT_PRODUCTS} products or variants, or more points of sale than columns.
   */
  export(principal: CatalogCaller, access: GroupAccess, mode: ReferenceMode, client: ClientContext): Promise<WorkbookFile>;
  /**
   * Imports a workbook, all or nothing: the whole file is applied inside one transaction and committed only when no row has a problem (and the request is not a dry run). The writes are the ones of the services of the catalog.
   *
   * @param file The file, already known to be a ZIP and within the size limit.
   * @param dryRun Verify and count, write nothing.
   * @throws {AppError} `VALIDATION_ERROR` (422) when the file is not a workbook the reader accepts, has no sheet, or has too many rows; `PAYLOAD_TOO_LARGE` when the import takes too long.
   * @throws {ImportRefusal} When a row has a problem: nothing was written.
   */
  import(principal: CatalogCaller, access: GroupAccess, file: Buffer, dryRun: boolean, client: ClientContext): Promise<ImportOutcome>;
}

/** The collaborators of the workbook: what the catalog services are built from. */
export interface CatalogXlsxDeps {
  readonly databases: Databases;
  readonly catalogs: Pick<CatalogsService, 'list'>;
  readonly images: { imageSource(principal: CatalogCaller, access: GroupAccess, imageId: ObjectId): Promise<MediaLogo | null> };
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  readonly versionKey: Buffer;
  readonly now: () => number;
  /** The lock of the catalog of a group (tests replace it); by default the one in `common.settings`, shared with the tobacco synchronization. */
  readonly lock?: CatalogLock;
  /** Limits (tests lower them). */
  readonly limits?: { readonly maxExportProducts?: number; readonly maxImportMs?: number; readonly rows?: { readonly sheet: number; readonly total: number } };
}

/** Thrown inside the transaction to abort it: the file has problems, or the request is a dry run. It carries the report out. */
class Rollback extends Error {
  readonly report: ImportReport;

  constructor(report: ImportReport) {
    super('rollback');
    this.report = report;
  }
}

/**
 * An activity log that keeps the entries the services of an import make (`product.*`, `productCategory.*`, with their before and after, exactly as the routes write them) instead of writing them: the import
 * writes them after the commit, with the same request id, so a transaction that is aborted (a file with problems, a dry run) leaves no trace of changes that never happened.
 */
function bufferedLog(): { readonly log: ActivityLog; readonly entries: ActivityEntry[] } {
  const entries: ActivityEntry[] = [];
  return { log: { record: async (entry) => void entries.push(entry) }, entries };
}

/** The sum of the counts of the sheets. */
function totalOf(sheets: Readonly<Record<SheetKind, SheetCounts>>): SheetCounts {
  const all = Object.values(sheets);
  return { inserted: all.reduce((sum, c) => sum + c.inserted, 0), updated: all.reduce((sum, c) => sum + c.updated, 0), removed: all.reduce((sum, c) => sum + c.removed, 0), unchanged: all.reduce((sum, c) => sum + c.unchanged, 0) };
}

/**
 * Builds the workbook service. The export and the model read through the services' own repositories; the import builds, for each request, the services of the catalog over the transaction (`sessionDatabases`):
 * the same code that serves the routes of the products and the categories, with their rules, writing in the session.
 *
 * @param deps The collaborators.
 */
export function createCatalogXlsxService(deps: CatalogXlsxDeps): CatalogXlsxService {
  const { databases, activityLog, now } = deps;
  const maxExportProducts = deps.limits?.maxExportProducts ?? MAX_EXPORT_PRODUCTS;
  const maxImportMs = deps.limits?.maxImportMs ?? MAX_IMPORT_MS;
  const reads = createCatalogXlsxRepository(databases);
  /** The lock of the catalog of a group, shared with the tobacco synchronization and by every instance of the server: it is in the database. */
  const lock = deps.lock ?? createCatalogLock({ databases, logger: deps.logger });

  /** The services of the catalog over a database accessor (the plain one, or the one of a transaction). */
  const graphOver = (over: Databases, silent: ActivityLog): ImportGraph => {
    let next = new ObjectId();
    const references = createReferencesRepository(over);
    const languages = createGroupLanguages(over);
    const placeCounter = createPlaceCounter(over);
    const categoriesRepository = createCategoriesRepository(over);
    const productsRepository = createProductsRepository(over);
    const common = { references, images: deps.images, languages, users: deps.users, activityLog: silent, logger: deps.logger, versionKey: deps.versionKey, now };
    const categories = withSoleLocation(
      createCategoriesService({ repository: categoriesRepository, places: createCategoryPlaces(over), catalogs: deps.catalogs, products: createProductReferences(over), newId: () => next, ...common }),
      placeCounter,
      deps.logger,
    );
    const products = withSoleLocation(createProductsService({ repository: productsRepository, links: createProductLinks(over), places: createCategoryPlaces(over), catalogs: deps.catalogs, ...common }), placeCounter, deps.logger);
    return {
      products,
      categories,
      findProduct: (principal, access, id) => productsRepository.findById(principal, access, id),
      findCategory: (principal, access, id) => categoriesRepository.findById(principal, access, id),
      productVersion: (document) => productVersion(document, deps.versionKey),
      categoryVersion: (document) => entityVersion(document, PRODUCTS_CATEGORIES_OWNED_FIELDS, deps.versionKey),
      useCategoryId: (id) => {
        next = id;
      },
      loadRefs: async (principal, access) => ({ ...(await refsOf(over, principal, access)), currency: await currencyOf(access) }),
    };
  };

  /** The code of the currency of the new prices: the euro when the group has it, else its first currency (`EUR` when it has none). */
  const currencyOf = async (access: GroupAccess): Promise<string> => {
    const list = (await deps.catalogs.list(currencies, access)) as Currency[];
    return list.find((currency) => currency.code === 'EUR')?.code ?? list[0]?.code ?? 'EUR';
  };

  /** The references of the group a caller sees. */
  const refsOf = async (over: Databases, principal: CatalogCaller, access: GroupAccess): Promise<Refs> => {
    // One read after the other: a transaction runs one operation at a time.
    const places = await createCatalogXlsxRepository(over).places(principal, access);
    const lists = (await deps.catalogs.list(priceLists, access)) as PriceList[];
    const rates = (await deps.catalogs.list(taxes, access)) as Tax[];
    const tree = await createCategoriesRepository(over).treeDocuments(principal, access);
    return {
      places,
      priceLists: lists.map((list) => ({ id: list.id, name: list.name.trim() })),
      taxes: rates.map((rate) => ({ id: rate.id, rate: rate.rate })),
      categories: tree.map((category) => ({ id: (category['_id'] as ObjectId).toHexString(), name: (textOf(valueAt(category, 'name.it')) ?? '').trim() })),
    };
  };

  const productFilters: Readonly<Record<'products' | 'variants', Filter<Document>>> = Object.freeze({
    products: { 'variant.status': { $ne: true }, type: { $in: ['product', 'exempt', 'service', null] }, trash: { $ne: true }, status: true },
    variants: { 'variant.status': true, trash: { $ne: true }, status: true },
  });

  const log = (entry: Omit<ActivityEntry, 'category' | 'actor'>, principal: CatalogCaller): Promise<void> => activityLog.record({ category: 'data', actor: actorOfCaller(principal), ...entry });

  const fileName = (prefix: string): string => `${prefix}_${new Date(now()).toISOString().slice(0, 10)}.xlsx`;

  return {
    template: async (principal, access) => {
      const places = await reads.places(principal, access);
      const sheets: XlsxSheet[] = (['products', 'variants', 'categories'] as const).map((kind) => ({ name: SHEET_NAMES[kind], columns: sheetHeaders(kind, places), rows: [] }));
      return { chunks: xlsxChunks(sheets), fileName: 'products-variants-categories-model.xlsx' };
    },

    export: async (principal, access, mode, client) => {
      const [refs, productCount, variantCount] = await Promise.all([
        refsOf(databases, principal, access),
        reads.countProducts(principal, access, productFilters.products, maxExportProducts),
        reads.countProducts(principal, access, productFilters.variants, maxExportProducts),
      ]);
      if (productCount > maxExportProducts || variantCount > maxExportProducts) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: `The export has more than ${String(maxExportProducts)} products or variants: narrow the perimeter` });
      }
      const productsRepository = createProductsRepository(databases);
      const categoriesRepository = createCategoriesRepository(databases);
      const written = { products: 0, variants: 0, categories: 0 };
      const productRows = (kind: 'products' | 'variants'): AsyncGenerator<string[]> =>
        (async function* () {
          const config = productsListFor('it');
          let cursor: string | undefined;
          do {
            const params = listParamsOf({ limit: EXPORT_BATCH, sort: 'name', ...(cursor === undefined ? {} : { cursor }) }, config);
            const { items, page } = await productsRepository.listFull(principal, access, productFilters[kind], params, config, PRODUCT_COST_FIELDS);
            for (const document of items) {
              written[kind] += 1;
              yield productRow(kind, document, refs, mode);
            }
            cursor = page.next ?? undefined;
          } while (cursor !== undefined);
        })();
      const categoryRows = (): AsyncGenerator<string[]> =>
        (async function* () {
          const config = categoriesListFor('it');
          let cursor: string | undefined;
          do {
            const params = listParamsOf({ limit: EXPORT_BATCH, sort: 'name', ...(cursor === undefined ? {} : { cursor }) }, config);
            const { items, page } = await categoriesRepository.list(principal, access, { status: true }, params, config);
            for (const document of items) {
              written.categories += 1;
              yield categoryRow(document, refs, mode);
            }
            cursor = page.next ?? undefined;
          } while (cursor !== undefined);
        })();
      const sheets: XlsxSheet[] = [
        { name: SHEET_NAMES.products, columns: sheetHeaders('products', refs.places), rows: productRows('products') },
        { name: SHEET_NAMES.variants, columns: sheetHeaders('variants', refs.places), rows: productRows('variants') },
        { name: SHEET_NAMES.categories, columns: sheetHeaders('categories', refs.places), rows: categoryRows() },
      ];
      const chunks = (async function* () {
        let complete = false;
        try {
          yield* xlsxChunks(sheets);
          complete = true;
        } finally {
          // The entry says what was written, whether or not the client read it all.
          await log(
            {
              action: 'catalog.exported',
              outcome: complete ? 'success' : 'failure',
              groupId: access.groupId,
              resource: { type: 'catalog' },
              requestId: client.requestId,
              ...(client.ip === null ? {} : { ip: client.ip }),
              metadata: { references: mode, ...written },
            },
            principal,
          );
        }
      })();
      return { chunks, fileName: fileName('products-variants-categories') };
    },

    import: async (principal, access, file, dryRun, client) => {
      const record = (outcome: 'success' | 'failure', metadata: Record<string, string | number | boolean>): Promise<void> =>
        log({ action: 'catalog.imported', outcome, groupId: access.groupId, resource: { type: 'catalog' }, requestId: client.requestId, ...(client.ip === null ? {} : { ip: client.ip }), metadata: { dryRun, ...metadata } }, principal);
      const group = access.groupId.toHexString();
      // Taken before anything is read or written, by a dry run too; given back whatever happens.
      const held = await lock.acquire(access.groupId).catch(async (error: unknown) => {
        await record('failure', { reason: 'error' });
        throw error;
      });
      if (held === null) {
        await record('failure', { reason: 'busy' });
        throw new AppError('CONFLICT', { message: 'An import or a synchronization of this group is already running', details: [{ field: 'group', issue: 'busy' }] });
      }
      try {
        let workbook;
        try {
          workbook = parseWorkbook(file, {}, deps.limits?.rows);
        } catch (error) {
          await record('failure', { reason: 'file' });
          throw error;
        }
        const deadline = now() + maxImportMs;
        let committed: { readonly report: ImportReport; readonly entries: readonly ActivityEntry[] } | null = null;
        let report: ImportReport;
        try {
          committed = await inGroupTransaction(principal, access, databases, async (session) => {
            // A new buffer for every attempt: the driver runs the work again on a transient error.
            const buffer = bufferedLog();
            const result = await runImport({ graph: graphOver(sessionDatabases(databases, session, access.groupId), buffer.log), principal, access, client, workbook, now, deadline });
            if (result.errorCount > 0 || dryRun) {
              throw new Rollback(result);
            }
            return { report: result, entries: buffer.entries };
          });
          report = committed.report;
        } catch (error) {
          if (!(error instanceof Rollback)) {
            await record('failure', { reason: error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE' ? 'tooSlow' : 'error' });
            throw error;
          }
          report = error.report;
        }
        if (report.errorCount > 0) {
          await record('failure', { reason: 'rows', errors: report.errorCount });
          throw new ImportRefusal(report.errors, report.errorCount);
        }
        // After the commit: the changes of the services, then the summary. The import is valid whatever happens to the log, which never rejects (a failed write goes to the logger).
        try {
          for (const entry of committed?.entries ?? []) {
            await activityLog.record(entry);
          }
          await record('success', totalOf(report.sheets) as unknown as Record<string, number>);
        } catch (error) {
          deps.logger.error('the activity entries of a committed catalog import could not be written', { groupId: group, requestId: client.requestId, error });
        }
        return { dryRun, sheets: report.sheets };
      } finally {
        await held.release();
      }
    },
  };
}
