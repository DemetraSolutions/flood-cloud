import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { PRODUCTS_INSERT_ONLY_FIELDS, PRODUCTS_OWNED_FIELDS } from '../../db/collections.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { escapeRegExp, listParamsOf } from '../../shared/http/list.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { actorOfCaller, languageOfCaller, operatorMetadata } from '../product-catalog/caller.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { settleItem } from '../../shared/trash/trash.ts';
import type { TrashItemOutcome, VersionCheck } from '../../shared/trash/trash.ts';
import { newElementId, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { entityVersion } from '../product-catalog/entity.service.ts';
import { localizedName } from '../../db/localized-name.ts';
import { applyChange } from '../product-categories/categories.document.ts';
import { blankProduct, duplicateProduct, productLoggable } from './products.document.ts';
import { cyclicComponents, planProduct } from './products.plan.ts';
import type { PlanDeps } from './products.plan.ts';
import { isEditableProduct, isVisibleProduct } from './products.availability.ts';
import { PRODUCT_COST_FIELDS, componentsOf, idOf, productRow, productView, withoutCosts } from './products.mapper.ts';
import type { ProductFamily, ProductRow, ProductView, ProductWithoutCosts } from './products.mapper.ts';
import { guardProductRemoval } from './products.removal.ts';
import type { ProductsRepository } from './products.repository.ts';
import { PRODUCT_CHANGES_LIST, productsListFor } from './products.schemas.ts';
import type { CreateProductBody, PatchProductBody, ProductChangesQuery, ProductsQuery } from './products.schemas.ts';

/** How many products a warning names at most (the others are counted). */
export const MAX_WARNING_PRODUCTS = 5;

/** A value that other products use too (the save went through: it is a warning, never an error). */
export interface DuplicateWarning {
  /** `code`, `plu` or `barcodes.<index>`. */
  readonly field: string;
  readonly issue: 'duplicate';
  /** The products, not in the trash, that use the value and that the caller reaches: at most {@link MAX_WARNING_PRODUCTS}. */
  readonly productIds: readonly string[];
  /** How many other products use it that are not named (the ones the caller does not reach, and the ones beyond the first five). */
  readonly others: number;
}

/** A product; the answers of a creation, a modification and a detail have the warnings of its code, PLU and barcodes, the others (trash, restore, duplication) do not. */
export type ProductDetail = ProductView & { readonly warnings?: readonly DuplicateWarning[] };

/** A product with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface ProductResult {
  readonly entity: ProductDetail;
  readonly version: string;
}

/** A page of the rows of the list. */
export interface ProductPage {
  readonly items: readonly ProductRow[];
  readonly page: PageInfo;
}

/** What became of one product of a bulk trash. */
export type TrashManyItem = { readonly id: string; readonly outcome: 'trashed' } | { readonly id: string; readonly outcome: 'skipped'; readonly issue: 'notFound' | 'forbidden' | 'alreadyTrashed' | 'conflict' };

/** The operations on the products of a group. */
export interface ProductsService {
  /**
   * A page of the products the caller reaches, of one family (`products` by default; every family for the page of the trash, `trashed=true`), filtered and sorted.
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort; `FORBIDDEN` when a company or place administrator asks for a place outside his perimeter; `NOT_FOUND` if the caller disappeared since the authentication.
   */
  list(principal: CatalogCaller, access: GroupAccess, query: ProductsQuery): Promise<ProductPage>;
  /**
   * A page of the whole products the caller reaches, oldest change first, for a client that keeps a copy of the catalog: with `updatedSince` every product changed from that instant (the ones in the trash and the
   * disabled ones included, so the client can remove them), without it the products that are not in the trash. Every family unless one is asked. The costs, the suppliers and the simple cost are not read.
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit.
   */
  listChanges(principal: CatalogCaller, access: GroupAccess, query: ProductChangesQuery): Promise<{ readonly items: readonly ProductWithoutCosts[]; readonly page: PageInfo }>;
  /**
   * One product, with the warnings of its code, PLU and barcodes.
   *
   * @throws {AppError} `NOT_FOUND` (also for a product a company or place administrator does not reach).
   */
  get(principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<ProductResult>;
  /**
   * Creates a product in the shape the legacy writes and records it. A code, a PLU or a barcode another product uses is a warning in the answer, never an error.
   *
   * @throws {AppError} `FORBIDDEN` for a company or place administrator who names a place outside his perimeter or none; `VALIDATION_ERROR` for a field the group lacks the function of, a language the group does not have, a missing name, and any reference that does not exist or that the caller does not reach.
   */
  create(principal: CatalogCaller, access: GroupAccess, body: CreateProductBody, client: ClientContext): Promise<ProductResult>;
  /**
   * Modifies a product (JSON Merge Patch on the texts, the lists and the maps by place as the schema says, every other field replaced), touching only the fields it owns, and records it. A request that changes nothing
   * writes and records nothing.
   *
   * @param expected The version the client read (`If-Match`).
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN` for a company or place administrator who changes what is not his; `PRECONDITION_FAILED` when the product is not at the version the client read; `CONFLICT` when it is in the trash, or changed while this request ran, or the write would make a cycle of bills of materials; the errors of {@link ProductsService.create}.
   */
  update(principal: CatalogCaller, access: GroupAccess, id: ObjectId, expected: string, body: PatchProductBody, client: ClientContext): Promise<ProductResult>;
  /**
   * Duplicates a product (`<name> (Copy)` in every language, no code, PLU and barcode, no stock and no cost) and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN` for a company or place administrator when the product is not wholly his; `CONFLICT` when it is in the trash.
   */
  duplicate(principal: CatalogCaller, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<ProductResult>;
  /**
   * Moves a product to the trash (it is never blocked by its references) and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN`; `PRECONDITION_FAILED`; `CONFLICT` when it is already in the trash or changed meanwhile.
   */
  trash(principal: CatalogCaller, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<ProductResult>;
  /**
   * Takes a product out of the trash and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN`; `PRECONDITION_FAILED`; `CONFLICT` when it is not in the trash or changed meanwhile.
   */
  restore(principal: CatalogCaller, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<ProductResult>;
  /**
   * Deletes a product that is in the trash for good and records it.
   *
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN`; `PRECONDITION_FAILED`; `CONFLICT` when it is not in the trash, with the references when something still uses it (`referenced`), or when it changed meanwhile.
   */
  remove(principal: CatalogCaller, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<void>;
  /**
   * Moves several products to the trash, one after the other, each as the single-item route does; a product that cannot be moved is skipped with its reason and never stops the others.
   *
   * @param ids 1 to 100 products, without repetitions.
   */
  trashMany(principal: CatalogCaller, access: GroupAccess, ids: readonly ObjectId[], client: ClientContext): Promise<{ readonly results: readonly TrashManyItem[] }>;
  /** Takes a product out of the trash for the trash page: exactly {@link ProductsService.restore}, with the version read just now, and a refusal as the issue. */
  restoreFromTrash(principal: CatalogCaller, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /** Deletes a product from the trash for the trash page: exactly {@link ProductsService.remove}, with the version read just now, and a refusal as the issue. */
  deleteFromTrash(principal: CatalogCaller, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /** The ids of the products in the trash that the caller reaches, in `_id` order, at most `limit`, after a cursor. */
  trashedIds(principal: CatalogCaller, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  /** How many products in the trash the caller reaches. */
  countTrashed(principal: CatalogCaller, access: GroupAccess): Promise<number>;
}

/** Collaborators of {@link createProductsService}. */
export interface ProductsServiceDeps extends Omit<PlanDeps, 'repository' | 'newElementId'> {
  readonly repository: ProductsRepository;
  readonly activityLog: ActivityLog;
  /** Where a write that could not be undone is reported (`error`, ids only). */
  readonly logger: Logger;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of new products. */
  readonly newId?: () => ObjectId;
  /** Generator of the ids of the rules of a price. */
  readonly newElementId?: () => string;
}

/** The fields the version of a product covers: every one the backend writes (the quantities and the cost, which the warehouse moves, are not among them). */
const VERSION_FIELDS: readonly string[] = PRODUCTS_OWNED_FIELDS.filter((field) => !PRODUCTS_INSERT_ONLY_FIELDS.includes(field) && field !== 'quantity');

/**
 * The stock of a stored `quantity` reduced to what the catalog writes: the minimum, the maximum and the location of each storage of each place. The quantity moves with every sale and every movement of the warehouse
 * and must not change the version of the product.
 */
function stockSettings(raw: unknown): Document {
  const places: Document = {};
  for (const [placeKey, storages] of Object.entries(typeof raw === 'object' && raw !== null ? raw : {})) {
    if (typeof storages === 'object' && storages !== null && !Array.isArray(storages)) {
      places[placeKey] = Object.fromEntries(Object.entries(storages).flatMap(([storageKey, entry]) => (typeof entry === 'object' && entry !== null ? [[storageKey, { min: (entry as Document)['min'], max: (entry as Document)['max'], location: (entry as Document)['location'] }]] : [])));
    }
  }
  return places;
}

/**
 * The version of a stored product, the `ETag` of the reads and the `If-Match` of the writes: HMAC-SHA256 with the secret key of the server of the id and of every field the backend writes, with the stock reduced
 * to its settings (so a sale or a movement of the warehouse does not change it, and a change of anything the catalog owns does).
 *
 * @param document The stored document, read with every owned field.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 */
export function productVersion(document: Document, key: Buffer): string {
  return entityVersion({ ...document, quantity: stockSettings(document['quantity']) }, [...VERSION_FIELDS, 'quantity'], key);
}

/** `409` for a product that changed (or went) between its read and its write; it is told apart from the one of a product in the wrong state only by the bulk trash. */
class ChangedMeanwhile extends AppError {
  constructor() {
    super('CONFLICT');
  }
}

/** `409` for a product in the trash, which only the trash operations touch. */
const trashedConflict = (): AppError => new AppError('CONFLICT', { details: [{ field: 'trashed', issue: 'incorrect' }] });

/**
 * Builds the service of the products of a group: the whole of the catalog form of the legacy backoffice (texts by language, barcodes, prices with the tax copy, categories, availability by place, modifiers,
 * print stations, stock settings, attributes, bill of materials and menus, images, margins, suppliers and shipping), with the rules of the perimeter of a company or place administrator, the trash, the duplication,
 * the versions and the activity log.
 *
 * @param deps The repository and the collaborators.
 */
export function createProductsService(deps: ProductsServiceDeps): ProductsService {
  const { repository, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const planDeps: PlanDeps = { ...deps, newElementId: deps.newElementId ?? newElementId };
  const versionOf = (document: Document): string => productVersion(document, versionKey);

  const languageOf = (principal: CatalogCaller, access: GroupAccess): Promise<string> => languageOfCaller(deps, principal, access.groupId);
  const found = async (principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<Document> => {
    const document = await repository.findById(principal, access, id);
    if (document === null) {
      throw new AppError('NOT_FOUND');
    }
    return document;
  };
  const refuse = (issues: readonly ErrorDetail[]): void => {
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: issues.slice(0, 20) });
    }
  };
  /** The other products, not in the trash, that use the code, the PLU or a barcode of a product, as warnings. */
  const warningsOf = async (principal: CatalogCaller, access: GroupAccess, document: Document): Promise<DuplicateWarning[]> => {
    const code = textOf(document['code']);
    const plu = textOf(document['plu']);
    const barcodes = [...new Set((Array.isArray(document['barcode']) ? (document['barcode'] as unknown[]) : []).flatMap((item) => (typeof (item as Document | null)?.['value'] === 'string' ? [(item as Document)['value'] as string] : [])))];
    const others = await repository.usingValues(principal, access, document['_id'] as ObjectId, { code: code === null || code === '' ? null : code, plu: plu === null || plu === '' ? null : plu, barcodes: barcodes.filter((value) => value !== '') });
    const warn = (field: string, uses: (other: Document) => boolean): DuplicateWarning[] => {
      const matches = others.filter(uses);
      if (matches.length === 0) {
        return [];
      }
      const named = matches.filter((other) => isVisibleProduct(principal, other['placesAvailability'])).slice(0, MAX_WARNING_PRODUCTS);
      return [{ field, issue: 'duplicate', productIds: named.map((other) => (other['_id'] as ObjectId).toHexString()), others: matches.length - named.length }];
    };
    const barcodeValues = (other: Document): string[] => (Array.isArray(other['barcode']) ? (other['barcode'] as unknown[]) : []).flatMap((item) => ((item as Document | null)?.['value'] as unknown) ?? []).filter((value): value is string => typeof value === 'string');
    return [
      ...(code === null || code === '' ? [] : warn('code', (other) => other['code'] === code)),
      ...(plu === null || plu === '' ? [] : warn('plu', (other) => other['plu'] === plu)),
      ...(Array.isArray(document['barcode']) ? (document['barcode'] as unknown[]) : []).flatMap((item, index) => {
        const value = (item as Document | null)?.['value'] as unknown;
        return typeof value === 'string' && value !== '' ? warn(`barcodes.${String(index)}`, (other) => barcodeValues(other).includes(value)) : [];
      }),
    ];
  };
  const resultOf = async (principal: CatalogCaller, access: GroupAccess, document: Document, withWarnings = true): Promise<ProductResult> => ({
    entity: { ...productView(document, principal, access.features), ...(withWarnings ? { warnings: await warningsOf(principal, access, document) } : {}) },
    version: versionOf(document),
  });
  const record = (principal: CatalogCaller, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, metadata?: Record<string, string>) =>
    recordDataChange(activityLog, {
      actor: actorOfCaller(principal),
      groupId: access.groupId,
      resource: { type: 'product', id: id.toHexString() },
      action,
      before,
      after,
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      metadata: { ...metadata, ...operatorMetadata(principal) },
    });
  /** The date of a change: strictly after the date read, so that two changes within the same millisecond still have different versions. */
  const dateAfter = (read: unknown): Date => {
    const clock = new Date(deps.now());
    return read instanceof Date && read.getTime() >= clock.getTime() ? new Date(read.getTime() + 1) : clock;
  };
  const checkVersion = (stored: Document, check: VersionCheck): void => {
    if (check.kind === 'ifMatch' && versionOf(stored) !== check.version) {
      throw new AppError('PRECONDITION_FAILED');
    }
  };
  const assertEditable = (principal: CatalogCaller, stored: Document): void => {
    if (!isEditableProduct(principal, stored['placesAvailability'])) {
      throw new AppError('FORBIDDEN');
    }
  };
  /** Moves a product to the trash or out of it: the product must be in the opposite state and wholly the caller's; `check` is the `If-Match` of the request, or `bulk` (an item of a bulk call, which has no version). */
  const changeState = async (principal: CatalogCaller, access: GroupAccess, id: ObjectId, check: VersionCheck, client: ClientContext, to: 'trashed' | 'restored'): Promise<Document> => {
    const stored = await found(principal, access, id);
    assertEditable(principal, stored);
    if ((stored['trash'] === true) === (to === 'trashed')) {
      throw new AppError('CONFLICT');
    }
    checkVersion(stored, check);
    const now = dateAfter(stored['updateDate']);
    if (!(await repository.setTrash(principal, access, id, to, now, { updateDate: stored['updateDate'], trash: stored['trash'], placesAvailability: stored['placesAvailability'] }))) {
      throw new ChangedMeanwhile();
    }
    const next: Document = { ...stored, trash: to === 'trashed', updateDate: now };
    if (to === 'trashed') {
      next['trashDate'] = now;
    } else {
      delete next['trashDate'];
    }
    await record(principal, access, client, id, to === 'trashed' ? 'product.trashed' : 'product.restored', { trashed: to === 'restored' }, { trashed: to === 'trashed' });
    return next;
  };
  /** Deletes a product that is in the trash; `check` as in {@link changeState}. */
  const deleteTrashed = async (principal: CatalogCaller, access: GroupAccess, id: ObjectId, check: VersionCheck, client: ClientContext): Promise<void> => {
    const stored = await found(principal, access, id);
    assertEditable(principal, stored);
    if (stored['trash'] !== true) {
      throw new AppError('CONFLICT');
    }
    checkVersion(stored, check);
    await guardProductRemoval({ repository, catalogs: deps.catalogs }, principal, access, id);
    if (!(await repository.removeTrashed(principal, access, id, { updateDate: stored['updateDate'], placesAvailability: stored['placesAvailability'] }))) {
      throw new AppError('CONFLICT');
    }
    await record(principal, access, client, id, 'product.deleted', productLoggable(principal, stored), undefined);
  };
  /** The filter of the family a list shows. */
  const familyFilter = (family: ProductFamily): Filter<Document> => {
    switch (family) {
      case 'products':
        return { 'variant.status': { $ne: true }, type: { $in: ['product', 'exempt', null] } };
      case 'services':
        return { 'variant.status': { $ne: true }, type: 'service' };
      case 'tgm':
        return { 'variant.status': { $ne: true }, type: { $in: ['tobaccos', 'games', 'monopoly'] } };
      case 'modifiers':
        return { 'variant.status': true };
    }
  };

  return {
    list: async (principal, access, query) => {
      const language = await languageOf(principal, access);
      const config = productsListFor(language);
      const params = listParamsOf(query, config);
      const allowed = perimeterOf(principal);
      if (query.placeId !== undefined && allowed !== null && !allowed.has(query.placeId)) {
        throw new AppError('FORBIDDEN', { details: [{ field: 'placeId', issue: 'notAllowed' }] });
      }
      // The family is `products` unless asked otherwise; the page of the trash lists every family.
      const family = query.family ?? (query.trashed === true ? null : 'products');
      const conditions: Filter<Document>[] = [...(family === null ? [] : [familyFilter(family)]), query.trashed === true ? { trash: true } : { trash: { $ne: true } }];
      if (params.q !== null) {
        conditions.push({
          $or: [{ $expr: { $regexMatch: { input: { $ifNull: [localizedName(language), ''] }, regex: { $literal: escapeRegExp(params.q) }, options: 'i' } } }, { code: params.q }, { 'barcode.value': params.q }],
        });
      }
      if (query.categoryId !== undefined) {
        conditions.push({ categories: { $in: [ObjectId.createFromHexString(query.categoryId), query.categoryId] } });
      }
      if (query.supplierId !== undefined) {
        conditions.push({ 'suppliers.id': { $in: [ObjectId.createFromHexString(query.supplierId), query.supplierId] } });
      }
      if (query.placeId !== undefined) {
        const place = ObjectId.createFromHexString(query.placeId);
        conditions.push({ $or: [{ placesAvailability: { $exists: false } }, { placesAvailability: null }, { placesAvailability: { $size: 0 } }, { 'placesAvailability.id': place }, { placesAvailability: place }] });
      }
      if (query.favorite !== undefined) {
        conditions.push({ favorite: query.favorite ? true : { $ne: true } });
      }
      if (query.enabled !== undefined) {
        conditions.push({ status: query.enabled ? true : { $ne: true } });
      }
      const [{ items, page }, lists] = await Promise.all([repository.list(principal, access, { $and: conditions }, params, config), deps.catalogs.list(priceLists, access) as Promise<PriceList[]>]);
      const defaultList = lists.find((list) => list.isDefault)?.id ?? null;
      // One read for the names of the last suppliers of the page.
      const supplierIds = [...new Set(items.flatMap((document) => idOf(valueAt(document, 'lastAveragePrice.lastSupplierId')) ?? []))];
      const supplierNames = supplierIds.length === 0 ? new Map<string, string | null>() : await repository.supplierNames(principal, access, supplierIds);
      return { items: items.map((document) => productRow(document, principal, access.features, language, defaultList, supplierNames)), page };
    },

    listChanges: async (principal, access, query) => {
      const params = listParamsOf(query, PRODUCT_CHANGES_LIST);
      const conditions: Filter<Document>[] = [
        ...(query.family === undefined ? [] : [familyFilter(query.family)]),
        query.updatedSince === undefined ? { trash: { $ne: true } } : { updateDate: { $gte: new Date(query.updatedSince) } },
      ];
      const { items, page } = await repository.listFull(principal, access, { $and: conditions }, params, PRODUCT_CHANGES_LIST, PRODUCT_COST_FIELDS);
      return { items: items.map((document) => withoutCosts(productView(document, principal, access.features))), page };
    },

    get: async (principal, access, id) => resultOf(principal, access, await found(principal, access, id)),

    create: async (principal, access, body, client) => {
      const id = newId();
      const now = new Date(deps.now());
      const blank = blankProduct({ id, type: body.type ?? 'product', isModifier: body.isModifier ?? false, now });
      const plan = await planProduct(planDeps, { principal, access, id, stored: blank, body, creating: true });
      refuse(plan.issues);
      const document = applyChange(blank, plan.set, plan.unset);
      await repository.insert(principal, access, document);
      await record(principal, access, client, id, 'product.created', undefined, productLoggable(principal, document));
      return resultOf(principal, access, document);
    },

    update: async (principal, access, id, expected, body, client) => {
      const stored = await found(principal, access, id);
      if (stored['trash'] === true) {
        throw trashedConflict();
      }
      checkVersion(stored, { kind: 'ifMatch', version: expected });
      const plan = await planProduct(planDeps, { principal, access, id, stored, body, creating: false });
      refuse(plan.issues);
      if (Object.keys(plan.set).length === 0 && Object.keys(plan.unset).length === 0) {
        return resultOf(principal, access, stored);
      }
      const readDate: unknown = stored['updateDate'];
      const updateDate = dateAfter(readDate);
      const change = { set: plan.set, unset: plan.unset, updateDate, readPlaces: stored['placesAvailability'], intact: plan.intact, readValues: plan.readValues };
      if ((await repository.update(principal, access, id, change, readDate)) === 'conflict') {
        throw new AppError('CONFLICT');
      }
      const next: Document = { ...applyChange(stored, plan.set, plan.unset), updateDate };
      // Without a transaction two requests can each add the other product to its bill of materials. The write that finds the cycle undoes itself, so the cycle never stays.
      if (plan.componentsAdded) {
        const cyclic = await cyclicComponents(planDeps, { principal, access, id }, componentsOf(next['bundleProducts']).map((component) => component.productId));
        if (cyclic === null || cyclic.length > 0) {
          const touched = [...Object.keys(plan.set), ...Object.keys(plan.unset)];
          const restore = {
            set: Object.fromEntries(touched.filter((path) => valueAt(stored, path) !== undefined).map((path) => [path, valueAt(stored, path)])),
            unset: Object.fromEntries(touched.filter((path) => valueAt(stored, path) === undefined).map((path) => [path, ''])),
          };
          // The undo holds only for the fields that are still what this request wrote: a write of the POS on a price that came meanwhile is never overwritten.
          const written = Object.fromEntries(touched.map((path) => [path, valueAt(next, path)]));
          const undone = await repository.update(principal, access, id, { ...restore, updateDate: new Date(updateDate.getTime() + 1), readPlaces: next['placesAvailability'], readValues: written }, updateDate);
          if (undone === 'conflict') {
            deps.logger.error('product write could not be undone', { id: id.toHexString(), groupId: access.groupId.toHexString() });
          }
          throw new AppError('CONFLICT', { details: [{ field: 'components', issue: 'incorrect' }] });
        }
      }
      await record(principal, access, client, id, 'product.updated', productLoggable(principal, stored), productLoggable(principal, next));
      return resultOf(principal, access, next);
    },

    duplicate: async (principal, access, id, client) => {
      const stored = await found(principal, access, id);
      assertEditable(principal, stored);
      if (stored['trash'] === true) {
        throw trashedConflict();
      }
      const copyId = newId();
      const document = duplicateProduct(stored, copyId, new Date(deps.now()));
      await repository.insert(principal, access, document);
      await record(principal, access, client, copyId, 'product.duplicated', undefined, productLoggable(principal, document), { sourceId: id.toHexString() });
      return resultOf(principal, access, document, false);
    },

    trash: async (principal, access, id, expected, client) => resultOf(principal, access, await changeState(principal, access, id, { kind: 'ifMatch', version: expected }, client, 'trashed'), false),

    restore: async (principal, access, id, expected, client) => resultOf(principal, access, await changeState(principal, access, id, { kind: 'ifMatch', version: expected }, client, 'restored'), false),

    remove: (principal, access, id, expected, client) => deleteTrashed(principal, access, id, { kind: 'ifMatch', version: expected }, client),

    trashMany: async (principal, access, ids, client) => {
      const results: TrashManyItem[] = [];
      for (const id of [...new Map(ids.map((candidate) => [candidate.toHexString(), candidate])).values()]) {
        let raced = false;
        const outcome = await settleItem(async () => {
          try {
            await changeState(principal, access, id, { kind: 'bulk' }, client, 'trashed');
          } catch (error) {
            raced = error instanceof ChangedMeanwhile;
            throw error;
          }
        });
        results.push(outcome.done ? { id: id.toHexString(), outcome: 'trashed' } : { id: id.toHexString(), outcome: 'skipped', issue: raced ? 'conflict' : outcome.issue === 'notFound' ? 'notFound' : outcome.issue === 'forbidden' ? 'forbidden' : 'alreadyTrashed' });
      }
      return { results };
    },

    restoreFromTrash: (principal, access, id, client) => settleItem(() => changeState(principal, access, id, { kind: 'bulk' }, client, 'restored')),

    deleteFromTrash: (principal, access, id, client) => settleItem(() => deleteTrashed(principal, access, id, { kind: 'bulk' }, client)),

    trashedIds: (principal, access, limit, after) => repository.trashedIds(principal, access, limit, after),

    countTrashed: (principal, access) => repository.countTrashed(principal, access),
  };
}
