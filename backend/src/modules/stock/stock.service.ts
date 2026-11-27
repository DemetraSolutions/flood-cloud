import { Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { Databases } from '../../db/databases.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { createStockRepository } from './stock.repository.ts';
import type { StockOrigin, StockRepository, StockRow, StockSetup } from './stock.repository.ts';
import type { StockIndexGuard } from './stock.indexes.ts';
import { collectCatalogIds, resolveStockLines, roundStock } from './stock.resolve.ts';
import type { StockAnomaly, StockLine, StockProduct, StockResolution } from './stock.resolve.ts';

/** Most lines (and modular selections) one call takes: more is a programming error, never an anomaly. */
export const MAX_STOCK_LINES = 500;

/** Most products one call reads from the database to resolve its lines. Above it nothing is moved and `tooManyProducts` is reported. */
export const MAX_CATALOG_PRODUCTS = 2000;

/** How many ids one read of products takes. */
const READ_BATCH = 500;

/** The state a caller wants the stock of an origin to be in: the lines that unload the stock (a sale) and the ones that load it (a return), all in the point of sale of the company. */
export interface StockTarget {
  readonly companyId: ObjectId;
  /** The point of sale that moves its stock. */
  readonly placeId: ObjectId;
  /** The date of the movements this reconciliation writes. */
  readonly date: Date;
  /** The lines that take stock out (sold, consumed, discharged). */
  readonly unload: readonly StockLine[];
  /** The lines that put stock in (returned, loaded). */
  readonly load: readonly StockLine[];
}

/** Who asks for the movements, written in them as the legacy does not know it. */
export interface StockActor {
  /** The operator or user; `null` when none is known. */
  readonly userId: ObjectId | null;
  /** The store key of the server of the point of sale that asked, when it did. */
  readonly storeKeyId?: ObjectId;
}

/** What a reconciliation did. */
export interface StockOutcome {
  /** The movements that were written (none when the origin was already in the wanted state). */
  readonly movementIds: ObjectId[];
  /** What was found wrong and gone around; never an error, the caller decides what to show. */
  readonly anomalies: StockAnomaly[];
}

/** The single entry point of everything that moves the warehouse. */
export interface StockService {
  /** Makes sure the group has the unique index of the origins. It runs outside a transaction: a caller that holds one open (`nested`) calls it before opening it. */
  ensureIndex(principal: ScopeHolder, access: GroupAccess): Promise<void>;
  /**
   * Brings the warehouse of an origin to the state of `target` by writing only the difference between what the origin has moved and what it should have moved: the first application is a reconciliation from nothing, a modification applies the
   * difference, a reversal is a reconciliation towards nothing (`null`), and repeating a reconciliation writes nothing. The movements and the changes of the stock are written in one transaction on the cluster of the group (the one of the caller
   * when `nested`). Nothing comes from a client: the products, the storage, the rules and the feature are read from the database.
   *
   * @param principal The authenticated caller.
   * @param access The verified group access.
   * @param origin What asks for the movements.
   * @param target The wanted state, or `null` to reverse everything the origin moved.
   * @param actor Who asks.
   * @param baseline What the origin has already moved without a movement of its own (a sale the legacy wrote: step VS4a); it is added to the state read from the movements, so only the difference to `target` is written. Absent for nothing.
   * @returns The movements written and the anomalies.
   * @throws {RangeError} When `target` has more than {@link MAX_STOCK_LINES} lines, a quantity that is not a positive number or an id that is not an id (a bug of the caller).
   */
  reconcileOrigin(principal: ScopeHolder, access: GroupAccess, origin: StockOrigin, target: StockTarget | null, actor: StockActor, baseline?: readonly StockRow[]): Promise<StockOutcome>;
  /**
   * What the legacy moved for a sale, to adopt it (the movements with its `saleId` and no `origin`): the baseline to save with the sale and to pass to {@link StockService.reconcileOrigin}. Read only, in the transaction of the caller when `nested`.
   *
   * @param principal The authenticated caller.
   * @param access The verified group access.
   * @param saleId The sale.
   * @returns The signed quantities by storage and product, in load units; none for a sale that moved nothing.
   */
  legacyBaseline(principal: ScopeHolder, access: GroupAccess, saleId: ObjectId): Promise<StockRow[]>;
}

/** Collaborators of {@link createStockService}. */
export interface StockServiceDeps {
  /** The database accessor: the real one, or (with `nested`) the one bound to the transaction of the caller. */
  readonly databases: Databases;
  /** Whether `databases` is already the accessor of an open transaction (`sessionDatabases`): the work then joins it instead of opening another one (a sale reconciles its warehouse inside its own transaction). */
  readonly nested?: boolean;
  /** Makes sure the group has the unique index of the origins before its first movement is written. */
  readonly indexes: StockIndexGuard;
  /** Builds the repository over a database accessor (the default builds the real one; a test wraps it). */
  readonly repositoryOver?: (databases: Databases) => StockRepository;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Generator of the ids of the movements. */
  readonly newId?: () => ObjectId;
}

/** How a movement of the cash desks is found in the rules of the group: its type, and the flag and the sign it must have. */
const RULE_SHAPES = Object.freeze({
  D: { flag: 'cashD', sign: '-' },
  L: { flag: 'cashL', sign: '+' },
} as const);

/**
 * The warehouse rule the cash desks use for a type of movement: the last rule of the type that has the cash flag (as the legacy does), only if its sign is the one that moves the stock the right way.
 *
 * @param rules The rules of the group.
 * @param type `D` for an unload, `L` for a load.
 * @returns The rule, or `null` when there is none or its sign is wrong.
 */
export function cashWarehouseRule(rules: readonly Readonly<Record<string, unknown>>[], type: 'L' | 'D'): Readonly<Record<string, unknown>> | null {
  const shape = RULE_SHAPES[type];
  const found = rules.filter((rule) => rule['type'] === type && rule[shape.flag] === true).at(-1);
  return found !== undefined && found['quantity'] === shape.sign ? found : null;
}

/** Checks the lines of a target: the bounds and the shape that a caller must have already guaranteed. */
function assertTarget(target: StockTarget): void {
  const all = [...target.unload, ...target.load];
  if (all.length + all.reduce((sum, line) => sum + (line.modularSelections?.length ?? 0), 0) > MAX_STOCK_LINES) {
    throw new RangeError(`A reconciliation takes at most ${String(MAX_STOCK_LINES)} lines`);
  }
  const valid = (id: string, quantity: number): boolean => /^[0-9a-f]{24}$/.test(id) && Number.isFinite(quantity) && quantity > 0;
  for (const line of all) {
    if (!valid(line.productId, line.quantity) || !(line.modularSelections ?? []).every((selection) => valid(selection.productId, selection.quantity))) {
      throw new RangeError('A line of the stock needs a product id and a positive quantity');
    }
  }
}

/** The key of a quantity of an origin: the point of sale, the storage and the product. */
const keyOf = (placeId: ObjectId, storageId: ObjectId, productId: ObjectId): string => `${placeId.toHexString()}|${storageId.toHexString()}|${productId.toHexString()}`;

/**
 * Builds the service of the warehouse movements: the one place that turns what happened (a sale, a return, a document, a manual correction) into movements of the `warehouse` collection and changes of the stock of the products, in the shape
 * the legacy reads (and can reverse), with the origin and a sequence number that make the writes idempotent.
 *
 * @param deps The collaborators.
 */
export function createStockService(deps: StockServiceDeps): StockService {
  const newId = deps.newId ?? (() => new ObjectId());
  const repositoryOver = deps.repositoryOver ?? ((databases: Databases) => createStockRepository(databases));
  /** Runs `work` in a transaction on the cluster of the group, over a repository that makes every read and write part of it (the driver may repeat `work`, so it keeps nothing between attempts but its result). */
  const inTransaction = <T>(principal: ScopeHolder, access: GroupAccess, work: (repository: StockRepository) => Promise<T>): Promise<T> =>
    deps.nested === true ? work(repositoryOver(deps.databases)) : inGroupTransaction(principal, access, deps.databases, (session) => work(repositoryOver(sessionDatabases(deps.databases, session, access.groupId))));

  /** Reads the products the lines need, level by level, and resolves them: every pass resolves again and reads what the previous one found missing, until nothing new is missing. */
  const resolveFromDatabase = async (repository: StockRepository, principal: ScopeHolder, access: GroupAccess, target: StockTarget): Promise<{ readonly unload: StockResolution; readonly load: StockResolution; readonly catalog: Map<string, StockProduct> } | 'tooMany'> => {
    const catalog = new Map<string, StockProduct>();
    const asked = new Set<string>();
    for (;;) {
      const unload = resolveStockLines(target.unload, 'unload', catalog);
      const load = resolveStockLines(target.load, 'load', catalog);
      const wanted = collectCatalogIds([...unload.anomalies, ...load.anomalies]).filter((id) => !asked.has(id));
      if (wanted.length === 0) {
        return { unload, load, catalog };
      }
      if (asked.size + wanted.length > MAX_CATALOG_PRODUCTS) {
        return 'tooMany';
      }
      for (let start = 0; start < wanted.length; start += READ_BATCH) {
        const batch = wanted.slice(start, start + READ_BATCH);
        for (const product of await repository.findProducts(principal, access, batch.map((id) => ObjectId.createFromHexString(id)))) {
          catalog.set(product._id.toHexString(), product);
        }
        batch.forEach((id) => asked.add(id));
      }
    }
  };

  /**
   * The state `target` wants, by storage and product, with the products it was resolved on. `null` when the target cannot be placed (the point of sale has no storage of the cash desks, or the lines need too many products): nothing is
   * moved then and the anomaly says why. A group without the warehouse wants nothing, which reverses what the origin moved before.
   */
  const desiredState = async (repository: StockRepository, principal: ScopeHolder, access: GroupAccess, target: StockTarget, setup: StockSetup, anomalies: StockAnomaly[]): Promise<{ readonly desired: Map<string, StockRow>; readonly catalog: Map<string, StockProduct> } | null> => {
    const desired = new Map<string, StockRow>();
    const catalog = new Map<string, StockProduct>();
    if (!setup.enabled || target.unload.length + target.load.length === 0) {
      return { desired, catalog };
    }
    const cash = await repository.readCashStorages(principal, access, target.placeId);
    const storageId = cash.at(-1);
    if (storageId === undefined) {
      anomalies.push({ code: 'noCashStorage' });
      return null;
    }
    if (cash.length > 1) {
      anomalies.push({ code: 'multipleCashStorages' });
    }
    const resolved = await resolveFromDatabase(repository, principal, access, target);
    if (resolved === 'tooMany') {
      anomalies.push({ code: 'tooManyProducts' });
      return null;
    }
    anomalies.push(...resolved.unload.anomalies, ...resolved.load.anomalies);
    const net = new Map<string, number>();
    for (const [productId, delta] of [...resolved.unload.deltas, ...resolved.load.deltas]) {
      net.set(productId, (net.get(productId) ?? 0) + delta);
    }
    for (const [productId, delta] of net) {
      const value = roundStock(delta);
      if (!Number.isFinite(value)) {
        // A stock is never turned into `Infinity` or `NaN` for ever: the product is left alone and the anomaly says so.
        anomalies.push({ code: 'invalidQuantity', productId });
      } else if (value !== 0) {
        const id = ObjectId.createFromHexString(productId);
        desired.set(keyOf(target.placeId, storageId, id), { placeId: target.placeId, storageId, productId: id, companyId: target.companyId, value });
      }
    }
    return { desired, catalog: resolved.catalog };
  };

  /**
   * The snapshot of a product a record of a movement keeps, and its cost. The snapshot is only what the legacy reads from a saved movement: `_id` and `type` for its reversal, `code`, `name` and `measureLoad` for the detail of the movement
   * (never the whole product the legacy copied, to keep the movements small).
   */
  const recordOf = (product: StockProduct | undefined, productId: ObjectId, value: number): Document => {
    const price = product !== undefined && typeof product.weightedAveragePrice === 'number' && Number.isFinite(product.weightedAveragePrice) ? product.weightedAveragePrice : 0;
    return {
      product:
        product === undefined
          ? { _id: productId }
          : { _id: productId, code: product.code, name: product.name, type: product.type, measureLoad: product.measureLoad },
      barcode: null,
      listId: null,
      code: typeof product?.code === 'string' ? product.code : '',
      name: null,
      quantity: Math.abs(value),
      price,
      discount1: 0,
      discount2: 0,
      discount3: 0,
      discountedPrice: price,
      value,
    };
  };

  /** The differences between the wanted state and the current one, by storage and product, rounded; a zero is nothing to do. */
  const differencesOf = (desired: ReadonlyMap<string, StockRow>, current: ReadonlyMap<string, StockRow>): StockRow[] => {
    const differences: StockRow[] = [];
    for (const key of new Set([...desired.keys(), ...current.keys()])) {
      const wanted = desired.get(key);
      const value = roundStock((wanted?.value ?? 0) - (current.get(key)?.value ?? 0));
      if (value !== 0) {
        differences.push({ ...(wanted ?? current.get(key)!), value });
      }
    }
    return differences;
  };

  /** Writes the movements that make the differences real: one unload and one load for each storage, the stock changed in the same transaction. */
  const writeMovements = async (repository: StockRepository, principal: ScopeHolder, access: GroupAccess, input: { readonly origin: StockOrigin; readonly actor: StockActor; readonly date: Date; readonly rules: StockSetup['rules']; readonly products: Map<string, StockProduct>; readonly differences: readonly StockRow[] }, anomalies: StockAnomaly[]): Promise<ObjectId[]> => {
    const { origin, actor, products, differences } = input;
    const unknown = differences.map((row) => row.productId).filter((id) => !products.has(id.toHexString()));
    for (let start = 0; start < unknown.length; start += READ_BATCH) {
      for (const product of await repository.findProducts(principal, access, unknown.slice(start, start + READ_BATCH))) {
        products.set(product._id.toHexString(), product);
      }
    }
    let seq = await repository.countMovements(principal, access, origin);
    const storages = new Map<string, StockRow[]>();
    for (const row of differences) {
      const key = `${row.placeId.toHexString()}|${row.storageId.toHexString()}`;
      storages.set(key, [...(storages.get(key) ?? []), row]);
    }
    const movementIds: ObjectId[] = [];
    for (const all of storages.values()) {
      for (const type of ['D', 'L'] as const) {
        const rows = all.filter((row) => (type === 'D') === (row.value < 0));
        const rule = rows.length === 0 ? null : cashWarehouseRule(input.rules, type);
        if (rows.length > 0 && rule === null) {
          anomalies.push({ code: 'ruleMissing', type });
        }
        const records: Document[] = [];
        for (const row of rule === null ? [] : rows) {
          if (await repository.addToStock(principal, access, row.productId, row.placeId, row.storageId, row.value)) {
            records.push(recordOf(products.get(row.productId.toHexString()), row.productId, row.value));
          } else {
            anomalies.push({ code: 'productMissing', productId: row.productId.toHexString() });
          }
        }
        if (rule !== null && records.length > 0) {
          const id = newId();
          const now = new Date(deps.now());
          const { placeId, storageId, companyId } = rows[0]!;
          await repository.insertMovement(principal, access, {
            _id: id,
            type,
            rule: { ...rule },
            date: input.date,
            companyId,
            placeId,
            storageId,
            saleId: origin.kind === 'sale' ? origin.id : null,
            ...(origin.kind === 'document' ? { documentId: origin.id } : {}),
            supplierId: null,
            documentType: '',
            documentDate: null,
            documentNumber: null,
            note: '',
            records,
            insertDate: now,
            updateDate: now,
            origin: { kind: origin.kind, id: origin.id, seq: new Int32(seq) },
            userId: actor.userId,
            ...(actor.storeKeyId === undefined ? {} : { storeKeyId: actor.storeKeyId }),
          });
          seq += 1;
          movementIds.push(id);
        }
      }
    }
    return movementIds;
  };

  const reconcile = async (repository: StockRepository, principal: ScopeHolder, access: GroupAccess, origin: StockOrigin, target: StockTarget | null, actor: StockActor, baseline: readonly StockRow[]): Promise<StockOutcome> => {
    const anomalies: StockAnomaly[] = [];
    let setup: StockSetup | undefined;
    let wanted: { readonly desired: Map<string, StockRow>; readonly catalog: Map<string, StockProduct> } | null = { desired: new Map(), catalog: new Map() };
    if (target !== null) {
      setup = await repository.readSetup(principal, access);
      wanted = await desiredState(repository, principal, access, target, setup, anomalies);
    }
    let movementIds: ObjectId[] = [];
    if (wanted !== null) {
      const current = new Map<string, StockRow>();
      for (const row of [...(await repository.currentState(principal, access, origin)), ...baseline]) {
        const key = keyOf(row.placeId, row.storageId, row.productId);
        const known = current.get(key);
        current.set(key, known === undefined ? row : { ...known, value: roundStock(known.value + row.value) });
      }
      const differences = differencesOf(wanted.desired, current);
      if (differences.length > 0) {
        setup ??= await repository.readSetup(principal, access);
        movementIds = await writeMovements(repository, principal, access, { origin, actor, date: target?.date ?? new Date(deps.now()), rules: setup.rules, products: wanted.catalog, differences }, anomalies);
      }
    }
    const seen = new Set<string>();
    return {
      movementIds,
      anomalies: anomalies.filter((anomaly) => {
        const key = 'productId' in anomaly ? `${anomaly.code}:${anomaly.productId}` : anomaly.code === 'ruleMissing' ? `ruleMissing:${anomaly.type}` : anomaly.code;
        return !seen.has(key) && seen.add(key);
      }),
    };
  };

  return {
    ensureIndex: (principal, access) => deps.indexes.ensure(principal, access),

    legacyBaseline: (principal, access, saleId) => inTransaction(principal, access, (repository) => repository.legacyState(principal, access, saleId)),

    reconcileOrigin: async (principal, access, origin, target, actor, baseline = []) => {
      if (target !== null) {
        assertTarget(target);
      }
      if (deps.nested !== true) {
        await deps.indexes.ensure(principal, access);
      }
      return inTransaction(principal, access, (repository) => reconcile(repository, principal, access, origin, target, actor, baseline));
    },
  };
}
