import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryLogger } from '../helpers/app.ts';
import { accessFor } from '../helpers/group-access.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { inGroupTransaction, sessionDatabases } from '../../src/db/session-databases.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { createStockIndexGuard, createStockOriginIndex, STOCK_INDEX_RETRY_MS, STOCK_ORIGIN_INDEX } from '../../src/modules/stock/stock.indexes.ts';
import { createStockRepository, stockProductOf } from '../../src/modules/stock/stock.repository.ts';
import type { StockOrigin } from '../../src/modules/stock/stock.repository.ts';
import { cashWarehouseRule, createStockService, MAX_CATALOG_PRODUCTS, MAX_STOCK_LINES } from '../../src/modules/stock/stock.service.ts';
import type { StockTarget } from '../../src/modules/stock/stock.service.ts';
import type { StockLine } from '../../src/modules/stock/stock.resolve.ts';

const DEFAULT_RULES = {
  d1: { id: 'd1', type: 'D', quantity: '-', value: '=', cashD: true, cashL: false, name: 'Sale', default: true },
  l1: { id: 'l1', type: 'L', quantity: '+', value: '=', cashL: true, cashD: false, name: 'Return', default: true },
};
const DATE = new Date('2026-11-27T10:00:00Z');
const NOW = Date.parse('2026-11-27T12:00:00Z');

describe('the stock service on a real database', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  /** A group with its point of sale, storages, rules and products; every test has its own. */
  async function world(options: { warehouse?: boolean; rules?: unknown; storages?: Document[] } = {}) {
    const groupId = new ObjectId();
    const placeId = new ObjectId();
    const companyId = new ObjectId();
    const cash = new ObjectId();
    const back = new ObjectId();
    await ctx.databases.common().collection('groups').insertOne({ _id: groupId, settings: { warehouse: options.warehouse ?? true }, ...(options.rules === null ? {} : { warehouseRules: options.rules ?? DEFAULT_RULES }) });
    const db = ctx.databases.group(groupId, 'cluster0');
    // The storages of the place are read from its copy in the common database (the one the application reads the places from).
    await ctx.databases.common().collection('places').insertOne({ _id: placeId, groupId, storages: options.storages ?? [{ id: back, name: 'Back', cash: false }, { id: cash, name: 'Shop', cash: true }] });
    const principal = principalOf('SA', { groupId });
    const access = (await accessFor(principal, groupId))! as GroupAccess;
    const logs = memoryLogger();
    const service = createStockService({ databases: ctx.databases, indexes: createStockIndexGuard(ctx.databases, logs.logger), now: () => NOW });
    const product = async (fields: Document = {}, stock = 10): Promise<ObjectId> => {
      const _id = new ObjectId();
      await db.collection('products').insertOne({ _id, type: 'product', code: 'P', name: { it: 'Product' }, availability: { pos: true, warehouse: true }, measureLoad: 'cs', measureDownload: 'pz', measureConversionRatio: 1, bundleProducts: [], barcode: [], quantity: { [`__${placeId.toHexString()}`]: { [`__${cash.toHexString()}`]: { value: stock, min: 1 } } }, lastAveragePrice: { total: { weightedAveragePrice: 2.5 } }, ...fields });
      return _id;
    };
    const stock = async (productId: ObjectId, storage = cash): Promise<unknown> => ((await db.collection('products').findOne({ _id: productId }))!['quantity'] as Document)[`__${placeId.toHexString()}`]?.[`__${storage.toHexString()}`]?.value;
    const movements = (filter: Document = {}) => db.collection('warehouse').find(filter).sort({ 'origin.seq': 1, _id: 1 }).toArray();
    const target = (unload: StockLine[], load: StockLine[] = [], extra: Partial<StockTarget> = {}): StockTarget => ({ companyId, placeId, date: DATE, unload, load, ...extra });
    const sale = (productId: ObjectId, quantity: number, extra: Partial<StockLine> = {}): StockLine => ({ productId: productId.toHexString(), quantity, unit: 'sale', ...extra });
    const origin = (kind: StockOrigin['kind'] = 'sale', id = new ObjectId()): StockOrigin => ({ kind, id });
    const actor = { userId: principal.userId };
    const reconcile = (from: StockOrigin, to: StockTarget | null, who: { userId: ObjectId | null; storeKeyId?: ObjectId } = actor) => service.reconcileOrigin(principal, access, from, to, who);
    return { groupId, placeId, companyId, cash, back, db, principal, access, logs, service, product, stock, movements, target, sale, origin, actor, reconcile };
  }

  it('applies a sale as an unload in the storage of the cash desks, in load units, with the movement of the legacy and the origin', async () => {
    const w = await world();
    const cases = await w.product({ measureConversionRatio: 24 }, 10);
    const from = w.origin();
    const outcome = await w.reconcile(from, w.target([w.sale(cases, 6)]));
    assert.deepEqual(outcome.anomalies, []);
    assert.equal(outcome.movementIds.length, 1);
    assert.equal(await w.stock(cases), 9.75);
    const [movement] = await w.movements();
    assert.deepEqual(movement!['_id'], outcome.movementIds[0]);
    assert.deepEqual(Object.keys(movement!).sort(), ['_id', 'companyId', 'date', 'documentDate', 'documentNumber', 'documentType', 'insertDate', 'note', 'origin', 'placeId', 'records', 'rule', 'saleId', 'storageId', 'supplierId', 'type', 'updateDate', 'userId']);
    assert.deepEqual([movement!['type'], movement!['saleId'], movement!['supplierId'], movement!['documentType'], movement!['documentDate'], movement!['documentNumber'], movement!['note']], ['D', from.id, null, '', null, null, '']);
    assert.deepEqual([movement!['companyId'], movement!['placeId'], movement!['storageId'], movement!['userId']], [w.companyId, w.placeId, w.cash, w.principal.userId]);
    assert.deepEqual([movement!['date'], movement!['insertDate'], movement!['updateDate']], [DATE, new Date(NOW), new Date(NOW)]);
    assert.deepEqual(movement!['rule'], DEFAULT_RULES.d1);
    const origin = movement!['origin'] as Document;
    assert.ok(origin['seq'] === 0 && origin['id'].equals(from.id) && origin['kind'] === 'sale');
    const [record] = movement!['records'] as Document[];
    assert.deepEqual(Object.keys(record!).sort(), ['barcode', 'code', 'discount1', 'discount2', 'discount3', 'discountedPrice', 'listId', 'name', 'price', 'product', 'quantity', 'value']);
    assert.deepEqual([record!['barcode'], record!['listId'], record!['code'], record!['name'], record!['quantity'], record!['price'], record!['discountedPrice'], record!['value'], record!['discount1'], record!['discount2'], record!['discount3']], [null, null, 'P', null, 0.25, 2.5, 2.5, -0.25, 0, 0, 0]);
    assert.deepEqual(Object.keys(record!['product']).sort(), ['_id', 'code', 'measureLoad', 'name', 'type']);
    assert.deepEqual(record!['product'], { _id: cases, code: 'P', name: { it: 'Product' }, type: 'product', measureLoad: 'cs' });
    // Nothing else of the product was touched.
    const stored = (await w.db.collection('products').findOne({ _id: cases }))!;
    assert.deepEqual(stored['lastAveragePrice'], { total: { weightedAveragePrice: 2.5 } });
    assert.equal((stored['quantity'][`__${w.placeId.toHexString()}`][`__${w.cash.toHexString()}`] as Document)['min'], 1);
  });

  it('writes nothing when the same target is reconciled again', async () => {
    const w = await world();
    const item = await w.product();
    const from = w.origin();
    const target = w.target([w.sale(item, 3)]);
    await w.reconcile(from, target);
    const again = await w.reconcile(from, target);
    assert.deepEqual(again, { movementIds: [], anomalies: [] });
    assert.equal(await w.stock(item), 7);
    assert.equal((await w.movements()).length, 1);
  });

  it('applies only the difference of a modification, one movement for each direction, with a growing sequence', async () => {
    const w = await world();
    const [a, b, c] = [await w.product(), await w.product(), await w.product()];
    const from = w.origin();
    await w.reconcile(from, w.target([w.sale(a, 2), w.sale(b, 5)]));
    // a: 2 -> 3 sold (one more unloaded), b: 5 -> 1 (four loaded back), c: new (one unloaded).
    const outcome = await w.reconcile(from, w.target([w.sale(a, 3), w.sale(b, 1), w.sale(c, 1)]));
    assert.equal(outcome.movementIds.length, 2);
    assert.deepEqual([await w.stock(a), await w.stock(b), await w.stock(c)], [7, 9, 9]);
    const all = await w.movements();
    assert.deepEqual(all.map((movement) => [movement['type'], (movement['origin'] as Document)['seq']]), [['D', 0], ['D', 1], ['L', 2]]);
    const unload = all[1]!['records'] as Document[];
    assert.deepEqual(unload.map((record) => [record['product']['_id'].toHexString(), record['value'], record['quantity']]).sort(), [[a.toHexString(), -1, 1], [c.toHexString(), -1, 1]].sort());
    assert.deepEqual((all[2]!['records'] as Document[]).map((record) => [record['value'], record['quantity']]), [[4, 4]]);
    assert.deepEqual(all[2]!['rule'], DEFAULT_RULES.l1);
    // A sale and a return of the same origin: what is returned of a product is taken off what was sold of it.
    const sameOrigin = w.origin();
    await w.reconcile(sameOrigin, w.target([w.sale(a, 4)], [w.sale(b, 2), w.sale(a, 1)]));
    assert.deepEqual([await w.stock(a), await w.stock(b)], [7 - 3, 9 + 2]);
  });

  it('reverses everything an origin moved, and again without effect', async () => {
    const w = await world();
    const [a, b] = [await w.product(), await w.product()];
    const from = w.origin();
    const other = w.origin();
    await w.reconcile(from, w.target([w.sale(a, 2)], [w.sale(b, 1)]));
    await w.reconcile(other, w.target([w.sale(a, 1)]));
    const reversed = await w.reconcile(from, null);
    assert.equal(reversed.movementIds.length, 2);
    assert.deepEqual([await w.stock(a), await w.stock(b)], [9, 10]);
    const written = (await w.movements({ 'origin.id': from.id })).slice(2);
    assert.deepEqual(written.map((movement) => [movement['type'], movement['storageId'], movement['companyId'], movement['placeId'], movement['date']]), [['D', w.cash, w.companyId, w.placeId, new Date(NOW)], ['L', w.cash, w.companyId, w.placeId, new Date(NOW)]]);
    assert.deepEqual(await w.reconcile(from, null), { movementIds: [], anomalies: [] });
    assert.deepEqual([await w.stock(a), await w.stock(b)], [9, 10]);
    // An origin that never moved anything has nothing to reverse.
    assert.deepEqual(await w.reconcile(w.origin('manual'), null), { movementIds: [], anomalies: [] });
  });

  it('moves a product that is not kept in stock through its bill, and the modular choices, in load units', async () => {
    const w = await world();
    const ham = await w.product({ measureConversionRatio: 1000 });
    const roll = await w.product({ availability: { pos: true, warehouse: false }, bundleProducts: [{ _id: ham, quantity: 0.05, waste: 0 }] });
    const cola = await w.product({ measureConversionRatio: 6 });
    const menu = await w.product({ availability: { pos: true, warehouse: false } });
    const outcome = await w.reconcile(w.origin(), w.target([w.sale(roll, 2), w.sale(menu, 5, { modularSelections: [{ productId: cola.toHexString(), quantity: 3 }] })]));
    assert.deepEqual(outcome.anomalies, []);
    assert.deepEqual([await w.stock(ham), await w.stock(cola)], [9.9, 9.5]);
  });

  it('puts the movement in the last storage of the cash desks and says so when there is more than one, and in none when there is none', async () => {
    const first = new ObjectId();
    const last = new ObjectId();
    const many = await world({ storages: [{ id: first, cash: true }, { id: new ObjectId(), cash: false }, { id: last, cash: true }] });
    const item = await many.product({}, 10);
    const outcome = await many.reconcile(many.origin(), many.target([many.sale(item, 1)]));
    assert.deepEqual(outcome.anomalies, [{ code: 'multipleCashStorages' }]);
    assert.equal((await many.movements())[0]!['storageId'].toHexString(), last.toHexString());
    // The stock of the product had no entry for that storage: it is created by the `$inc`.
    assert.equal(await many.stock(item, last), -1);

    const none = await world({ storages: [{ id: new ObjectId(), cash: false }, { id: 'not-an-id', cash: true }, 'junk' as never] });
    const other = await none.product();
    const from = none.origin();
    assert.deepEqual(await none.reconcile(from, none.target([none.sale(other, 1)])), { movementIds: [], anomalies: [{ code: 'noCashStorage' }] });
    assert.equal(await none.stock(other), 10);
    assert.deepEqual(await none.movements(), []);

    // A point of sale that is not in the group (another group's id) has no storage either.
    const outsider = await world();
    const alien = await outsider.product();
    const stranger = outsider.target([outsider.sale(alien, 1)], [], { placeId: new ObjectId() });
    assert.deepEqual((await outsider.reconcile(outsider.origin(), stranger)).anomalies, [{ code: 'noCashStorage' }]);
    // Without storage a modification leaves what was moved as it is.
    const kept = await world();
    const stays = await kept.product();
    const origin = kept.origin();
    await kept.reconcile(origin, kept.target([kept.sale(stays, 2)]));
    const moved = kept.target([kept.sale(stays, 5)], [], { placeId: new ObjectId() });
    assert.deepEqual((await kept.reconcile(origin, moved)).anomalies, [{ code: 'noCashStorage' }]);
    assert.equal(await kept.stock(stays), 8);
  });

  it('does nothing without the feature of the warehouse, and still reverses what an origin moved before it was turned off', async () => {
    const off = await world({ warehouse: false });
    const item = await off.product();
    assert.deepEqual(await off.reconcile(off.origin(), off.target([off.sale(item, 1)])), { movementIds: [], anomalies: [] });
    assert.equal(await off.stock(item), 10);
    const w = await world();
    const stocked = await w.product();
    const from = w.origin();
    await w.reconcile(from, w.target([w.sale(stocked, 4)]));
    await ctx.databases.common().collection('groups').updateOne({ _id: w.groupId }, { $set: { 'settings.warehouse': false } });
    const modified = await w.reconcile(from, w.target([w.sale(stocked, 1)]));
    assert.equal(modified.movementIds.length, 1);
    assert.equal(await w.stock(stocked), 10);
    assert.deepEqual(await w.reconcile(from, null), { movementIds: [], anomalies: [] });
    // A group that is gone has no warehouse either, and an empty target is nothing to do.
    const ghost = await world();
    await ctx.databases.common().collection('groups').deleteOne({ _id: ghost.groupId });
    assert.deepEqual(await ghost.reconcile(ghost.origin(), ghost.target([ghost.sale(await ghost.product(), 1)])), { movementIds: [], anomalies: [] });
    assert.deepEqual(await w.reconcile(w.origin(), w.target([])), { movementIds: [], anomalies: [] });
  });

  it('does not write the movement of a type that has no rule or a rule with the wrong sign, and writes the other', async () => {
    const noLoad = await world({ rules: { d1: DEFAULT_RULES.d1 } });
    const [a, b] = [await noLoad.product(), await noLoad.product()];
    const outcome = await noLoad.reconcile(noLoad.origin(), noLoad.target([noLoad.sale(a, 1)], [noLoad.sale(b, 1)]));
    assert.deepEqual(outcome.anomalies, [{ code: 'ruleMissing', type: 'L' }]);
    assert.deepEqual([await noLoad.stock(a), await noLoad.stock(b)], [9, 10]);
    assert.deepEqual((await noLoad.movements()).map((movement) => movement['type']), ['D']);

    const wrongSign = await world({ rules: { d1: { ...DEFAULT_RULES.d1, quantity: '+' }, l1: { ...DEFAULT_RULES.l1, quantity: '=' } } });
    const c = await wrongSign.product();
    const wrong = await wrongSign.reconcile(wrongSign.origin(), wrongSign.target([wrongSign.sale(c, 1)], [wrongSign.sale(await wrongSign.product(), 1)]));
    assert.deepEqual(wrong.anomalies, [{ code: 'ruleMissing', type: 'D' }, { code: 'ruleMissing', type: 'L' }]);
    assert.equal(await wrongSign.stock(c), 10);
    assert.deepEqual(await wrongSign.movements(), []);

    // Without any rule, and with rules that are not rules; the missing movement is tried again when the rule is there.
    const bare = await world({ rules: null });
    const d = await bare.product();
    const from = bare.origin();
    assert.deepEqual((await bare.reconcile(from, bare.target([bare.sale(d, 1)]))).anomalies, [{ code: 'ruleMissing', type: 'D' }]);
    await ctx.databases.common().collection('groups').updateOne({ _id: bare.groupId }, { $set: { warehouseRules: { junk: 'x', d1: DEFAULT_RULES.d1 } } });
    assert.equal((await bare.reconcile(from, bare.target([bare.sale(d, 1)]))).movementIds.length, 1);
    assert.equal(await bare.stock(d), 9);
    await ctx.databases.common().collection('groups').updateOne({ _id: bare.groupId }, { $set: { warehouseRules: ['not', 'a', 'map'] } });
    assert.deepEqual((await bare.reconcile(from, null)).anomalies, [{ code: 'ruleMissing', type: 'L' }]);
  });

  it('picks the last rule that has the cash flag, copies it whole, and refuses it when its sign is wrong', () => {
    const rules = [
      { id: 'a', type: 'D', quantity: '-', cashD: true },
      { id: 'b', type: 'D', quantity: '-', cashD: false },
      { id: 'c', type: 'D', quantity: '-', cashD: true, extra: 1 },
      { id: 'd', type: 'L', quantity: '+', cashL: true },
    ];
    assert.equal(cashWarehouseRule(rules, 'D')!['id'], 'c');
    assert.equal(cashWarehouseRule(rules, 'L')!['id'], 'd');
    assert.equal(cashWarehouseRule([...rules, { id: 'e', type: 'D', quantity: '+', cashD: true }], 'D'), null);
    assert.equal(cashWarehouseRule([{ id: 'x', type: 'L', quantity: '+', cashL: 'yes' }], 'L'), null);
    assert.equal(cashWarehouseRule([], 'D'), null);
  });

  it('reports a product that is gone and leaves out its record, and the rest is written', async () => {
    const w = await world();
    const [a, gone] = [await w.product(), await w.product()];
    const from = w.origin();
    await w.reconcile(from, w.target([w.sale(a, 1), w.sale(gone, 1)]));
    await w.db.collection('products').deleteOne({ _id: gone });
    // The reversal of a deleted product cannot change a stock: no record, the anomaly says so, and the origin is tried again next time.
    const outcome = await w.reconcile(from, null);
    assert.deepEqual(outcome.anomalies, [{ code: 'productMissing', productId: gone.toHexString() }]);
    assert.equal(await w.stock(a), 10);
    const [last] = (await w.movements()).slice(-1);
    assert.deepEqual((last!['records'] as Document[]).map((record) => record['product']['_id']), [a]);
    // A product that is not in the database at all is reported by the resolution and moves nothing.
    const unknown = new ObjectId();
    const ghost = await w.reconcile(w.origin(), w.target([w.sale(unknown, 1)]));
    assert.deepEqual(ghost, { movementIds: [], anomalies: [{ code: 'productMissing', productId: unknown.toHexString() }] });
    // A movement that only has gone products is not written at all.
    const only = w.origin();
    const lone = await w.product();
    await w.reconcile(only, w.target([w.sale(lone, 1)]));
    await w.db.collection('products').deleteOne({ _id: lone });
    const before = (await w.movements()).length;
    assert.deepEqual((await w.reconcile(only, null)).movementIds, []);
    assert.equal((await w.movements()).length, before);
  });

  it('keeps a snapshot of only the product when it is not in the products the stock read (never in practice)', async () => {
    const w = await world();
    const item = await w.product();
    const repository = createStockRepository(ctx.databases);
    const service = createStockService({ databases: ctx.databases, indexes: createStockIndexGuard(ctx.databases, w.logs.logger), now: () => NOW, repositoryOver: () => ({ ...repository, findProducts: async (principal, access, ids) => (blind ? [] : repository.findProducts(principal, access, ids)) }) });
    let blind = false;
    const from = w.origin();
    await service.reconcileOrigin(w.principal, w.access, from, w.target([w.sale(item, 1)]), w.actor);
    blind = true;
    // The reversal reads no product (the stub gives none): the record has the id of the product alone.
    await service.reconcileOrigin(w.principal, w.access, from, null, w.actor);
    const [, reversal] = await w.movements();
    assert.deepEqual((reversal!['records'] as Document[])[0]!['product'], { _id: item });
    assert.equal((reversal!['records'] as Document[])[0]!['code'], '');
    assert.equal((reversal!['records'] as Document[])[0]!['price'], 0);
  });

  it('records the operator and the store key, and the document or the sale the movement is for', async () => {
    const w = await world();
    const item = await w.product();
    const storeKeyId = new ObjectId();
    await w.reconcile(w.origin('document'), w.target([w.sale(item, 1)]), { userId: null, storeKeyId });
    await w.reconcile(w.origin('manual'), w.target([], [{ productId: item.toHexString(), quantity: 2, unit: 'load' }]), { userId: null });
    const [document, manual] = await w.movements();
    assert.ok(document!['documentId'] instanceof ObjectId && document!['saleId'] === null && document!['userId'] === null && (document!['storeKeyId'] as ObjectId).equals(storeKeyId));
    assert.deepEqual([manual!['saleId'], 'documentId' in manual!, 'storeKeyId' in manual!, manual!['type'], (manual!['origin'] as Document)['kind']], [null, false, false, 'L', 'manual']);
  });

  it('writes the document in the types the legacy reads and the sequence as a 32 bit integer, and a reversal by the legacy puts the stock back', async () => {
    const w = await world();
    const item = await w.product({}, 10);
    const from = w.origin();
    await w.reconcile(from, w.target([w.sale(item, 4)]));
    const raw = await w.db.collection('warehouse').find({}, { promoteValues: false }).toArray();
    const origin = raw[0]!['origin'] as Document;
    assert.ok(origin['seq'] instanceof Int32 && origin['id'] instanceof ObjectId && typeof origin['kind'] === 'string');
    assert.ok(raw[0]!['_id'] instanceof ObjectId && raw[0]!['companyId'] instanceof ObjectId && raw[0]!['placeId'] instanceof ObjectId && raw[0]!['storageId'] instanceof ObjectId && raw[0]!['saleId'] instanceof ObjectId);
    assert.ok(raw[0]!['date'] instanceof Date && raw[0]!['insertDate'] instanceof Date && raw[0]!['updateDate'] instanceof Date);
    // The old backoffice reads the document and reverses it with `ms-warehouse-service` `delete` -> `updateProducts(..., 'delete')`, which for a rule with sign `-`
    // does `value = record.quantity; value *= -1; value *= -1`, and for `+` `value = record.quantity * multiplier (1: barcode is null)` negated. Both bring the stock back
    // because `quantity` is already in load units and `barcode` is `null`: this is that arithmetic, run on what was written.
    const legacyDeleteIncrement = (movement: Document): number => {
      let total = 0;
      for (const record of movement['records'] as Document[]) {
        const quantity = Math.abs(record['quantity'] as number);
        const multiplier = record['barcode'] && record['barcode'].value && record['barcode'].qtLoad ? record['barcode'].qtLoad : 1;
        total += movement['rule']['quantity'] === '+' ? -(quantity * multiplier) : Number(((quantity * -1) * -1).toFixed(6));
      }
      return total;
    };
    const written = (await w.movements())[0]!;
    assert.equal(legacyDeleteIncrement(written), 4);
    await w.db.collection('products').updateOne({ _id: item }, { $inc: { [`quantity.__${w.placeId.toHexString()}.__${w.cash.toHexString()}.value`]: legacyDeleteIncrement(written) } });
    assert.equal(await w.stock(item), 10);
    await w.reconcile(w.origin(), w.target([], [w.sale(item, 3)]));
    const loaded = (await w.movements()).at(-1)!;
    assert.equal(loaded['type'], 'L');
    assert.equal(legacyDeleteIncrement(loaded), -3);
  });

  it('has a unique index on the origin that refuses a duplicate sequence and leaves the movements of the legacy alone', async () => {
    const w = await world();
    const item = await w.product();
    const from = w.origin();
    await w.reconcile(from, w.target([w.sale(item, 1)]));
    const index = (await w.db.collection('warehouse').indexes()).find((entry) => entry.name === STOCK_ORIGIN_INDEX.options.name)!;
    assert.deepEqual([index.key, index.unique, index.partialFilterExpression], [{ 'origin.kind': 1, 'origin.id': 1, 'origin.seq': 1 }, true, { 'origin.kind': { $exists: true } }]);
    const [written] = await w.movements();
    const duplicate = { ...written!, _id: new ObjectId() };
    await assert.rejects(w.db.collection('warehouse').insertOne(duplicate), (error: unknown) => (error as { code?: number }).code === 11000);
    await w.db.collection('warehouse').insertOne({ ...duplicate, origin: { ...(written!['origin'] as Document), seq: 1 } });
    // Legacy movements have no origin: any number of them can be there.
    await w.db.collection('warehouse').insertMany([{ type: 'L' }, { type: 'L' }]);
    // The next sequence is the number of movements the origin has: the one that exists already makes this write seq 2.
    await w.reconcile(from, w.target([w.sale(item, 5)]));
    assert.deepEqual((await w.movements({ 'origin.id': from.id })).map((movement) => (movement['origin'] as Document)['seq']), [0, 1, 2]);
  });

  it('joins the transaction of the caller when nested, and leaves nothing when the caller aborts', async () => {
    const w = await world();
    const item = await w.product();
    const abort = new Error('the sale failed');
    const from = w.origin();
    await w.service.ensureIndex(w.principal, w.access);
    await assert.rejects(
      inGroupTransaction(w.principal, w.access, ctx.databases, async (session) => {
        const nested = createStockService({ databases: sessionDatabases(ctx.databases, session, w.groupId), nested: true, indexes: createStockIndexGuard(ctx.databases, w.logs.logger), now: () => NOW });
        const outcome = await nested.reconcileOrigin(w.principal, w.access, from, w.target([w.sale(item, 3)]), w.actor);
        assert.equal(outcome.movementIds.length, 1);
        throw abort;
      }),
      (error: unknown) => error === abort,
    );
    assert.equal(await w.stock(item), 10);
    assert.deepEqual(await w.movements(), []);
    await inGroupTransaction(w.principal, w.access, ctx.databases, async (session) => {
      const nested = createStockService({ databases: sessionDatabases(ctx.databases, session, w.groupId), nested: true, indexes: createStockIndexGuard(ctx.databases, w.logs.logger), now: () => NOW });
      await nested.reconcileOrigin(w.principal, w.access, from, w.target([w.sale(item, 3)]), w.actor);
      // What the transaction wrote is read back inside it: the same target is then nothing to do.
      assert.deepEqual((await nested.reconcileOrigin(w.principal, w.access, from, w.target([w.sale(item, 3)]), w.actor)).movementIds, []);
    });
    assert.equal(await w.stock(item), 7);
    assert.equal((await w.movements()).length, 1);
  });

  it('never reaches the database of another group', async () => {
    const mine = await world();
    const theirs = await world();
    const item = await mine.product();
    const theirItem = await theirs.product();
    await mine.reconcile(mine.origin(), mine.target([mine.sale(item, 1), mine.sale(theirItem, 1)]));
    assert.equal(await theirs.stock(theirItem), 10);
    assert.deepEqual(await theirs.movements(), []);
    assert.equal((await mine.movements()).length, 1);
    assert.equal(await mine.stock(item), 9);
    // The point of sale of another group is not found in this group, so its storage is never used.
    const stranger = await mine.reconcile(mine.origin(), mine.target([mine.sale(item, 1)], [], { placeId: theirs.placeId }));
    assert.deepEqual(stranger.anomalies, [{ code: 'noCashStorage' }]);
    assert.deepEqual(await theirs.movements(), []);
  });

  it('reads the products level by level in batches and refuses a target that needs too many', async () => {
    const w = await world();
    const parts = Array.from({ length: 1200 }, () => new ObjectId());
    await w.db.collection('products').insertMany(parts.map((_id) => ({ _id, type: 'product', availability: { warehouse: true }, measureConversionRatio: 1, bundleProducts: [], barcode: [] })));
    const kit = await w.product({ availability: { pos: true, warehouse: false }, bundleProducts: parts.map((_id) => ({ _id, quantity: 1, waste: 0 })) });
    const outcome = await w.reconcile(w.origin(), w.target([w.sale(kit, 2)]));
    assert.equal(outcome.movementIds.length, 1);
    assert.equal(((await w.movements())[0]!['records'] as Document[]).length, 1200);
    assert.equal((await w.db.collection('products').findOne({ _id: parts[1199]! }))!['quantity']?.[`__${w.placeId.toHexString()}`]?.[`__${w.cash.toHexString()}`].value, -2);

    const huge = await w.product({ availability: { pos: true, warehouse: false }, bundleProducts: Array.from({ length: MAX_CATALOG_PRODUCTS + 1 }, () => ({ _id: new ObjectId(), quantity: 1, waste: 0 })) });
    const from = w.origin();
    assert.deepEqual(await w.reconcile(from, w.target([w.sale(huge, 1)])), { movementIds: [], anomalies: [{ code: 'tooManyProducts' }] });
    assert.equal((await w.movements({ 'origin.id': from.id })).length, 0);
  });

  it('refuses a call that is a bug of the caller with a RangeError, not an anomaly', async () => {
    const w = await world();
    const item = await w.product();
    const many = Array.from({ length: MAX_STOCK_LINES + 1 }, () => w.sale(item, 1));
    const reject = (target: StockTarget) => assert.rejects(w.reconcile(w.origin(), target), RangeError);
    await reject(w.target(many));
    await reject(w.target(many.slice(0, 250), many.slice(0, 251)));
    await reject(w.target([w.sale(item, 1, { modularSelections: many.slice(0, MAX_STOCK_LINES) })]));
    await reject(w.target([w.sale(item, 0)]));
    await reject(w.target([w.sale(item, Number.NaN)]));
    await reject(w.target([w.sale(item, -1)]));
    await reject(w.target([{ productId: 'nope', quantity: 1, unit: 'sale' }]));
    await reject(w.target([w.sale(item, 1, { modularSelections: [{ productId: item.toHexString(), quantity: 0 }] })]));
    await reject(w.target([w.sale(item, 1, { modularSelections: [{ productId: 'nope', quantity: 1 }] })]));
    // Exactly at the limit it works.
    assert.equal((await w.reconcile(w.origin(), w.target(many.slice(0, MAX_STOCK_LINES)))).movementIds.length, 1);
    assert.equal(await w.stock(item), 10 - MAX_STOCK_LINES);
  });

  it('reads the state of an origin with a bound, and reads the products as the stock needs them', async () => {
    const w = await world();
    const [a, b] = [await w.product(), await w.product()];
    const from = w.origin();
    await w.reconcile(from, w.target([w.sale(a, 1), w.sale(b, 1)]));
    await assert.rejects(createStockRepository(ctx.databases).readCashStorages(w.principal, w.access, 'x' as never), /needs its id/);
    assert.deepEqual(await createStockRepository(ctx.databases).readCashStorages(w.principal, w.access, new ObjectId()), []);
    const narrow = createStockRepository(ctx.databases, { maxStateRows: 1 });
    await assert.rejects(narrow.currentState(w.principal, w.access, from), /more rows/);
    assert.equal((await createStockRepository(ctx.databases, { maxStateRows: 2 }).currentState(w.principal, w.access, from)).length, 2);
    // A hex id as text, a junk component and a junk barcode are read tolerantly.
    const hex = new ObjectId().toHexString();
    const read = stockProductOf({ _id: a, availability: 'x', bundleProducts: [{ _id: hex, quantity: 1 }, { _id: 'zz', quantity: 1 }, 7, { _id: 3 }], barcode: [{ value: 'v', qtLoad: 2 }, 9], lastAveragePrice: { total: { weightedAveragePrice: 4 } } });
    assert.deepEqual([read.availability, read.bundleProducts.map((item) => item._id.toHexString()), read.barcode, read.weightedAveragePrice], [{}, [hex], [{ value: 'v', qtLoad: 2 }], 4]);
    const bare = stockProductOf({ _id: a, bundleProducts: 'x', barcode: null, lastAveragePrice: { total: 'x' } });
    assert.deepEqual([bare.bundleProducts, bare.barcode, bare.weightedAveragePrice], [[], [], null]);
    assert.equal(stockProductOf({ _id: a, lastAveragePrice: 3 }).weightedAveragePrice, null);
  });

  it('never turns a stock into Infinity: a quantity that overflows when converted is left alone and reported', async () => {
    const w = await world();
    const [tiny, fine] = [await w.product({ measureConversionRatio: 5e-324 }), await w.product()];
    const outcome = await w.reconcile(w.origin(), w.target([w.sale(tiny, 1_000_000), w.sale(fine, 2)]));
    assert.deepEqual(outcome.anomalies, [{ code: 'invalidQuantity', productId: tiny.toHexString() }]);
    assert.deepEqual([await w.stock(tiny), await w.stock(fine)], [10, 8]);
    assert.equal(outcome.movementIds.length, 1);
  });

  describe('the sales of the legacy (step VS4a): the baseline', () => {
    it('reads what the legacy moved for a sale, signed by the sign of the rule, and nothing else', async () => {
      const w = await world();
      const [a, b, c] = [await w.product(), await w.product(), await w.product()];
      const saleId = new ObjectId();
      const movement = (rule: Document, records: Document[], extra: Document = {}): Document => ({ _id: new ObjectId(), type: rule['type'], rule, date: DATE, companyId: w.companyId, placeId: w.placeId, storageId: w.cash, saleId, records, ...extra });
      const rec = (productId: unknown, quantity: number): Document => ({ product: { _id: productId }, quantity, value: quantity });
      await w.db.collection('warehouse').insertMany([
        movement(DEFAULT_RULES.d1, [rec(a, 3), rec(b, 1)]),
        movement(DEFAULT_RULES.l1, [rec(a, 1)]),
        movement({ type: 'L', quantity: '?' }, [rec(c, 5)]),
        movement(DEFAULT_RULES.d1, [rec('not an id', 2)]),
        movement(DEFAULT_RULES.d1, [rec(c, 2)], { placeId: 'text' }),
        movement(DEFAULT_RULES.d1, [rec(c, 2)], { storageId: 'text' }),
        movement(DEFAULT_RULES.d1, [rec(await w.product(), 2)], { companyId: 'text' }),
        movement(DEFAULT_RULES.d1, [rec(c, 9)], { origin: { kind: 'sale', id: saleId, seq: 0 } }),
        movement(DEFAULT_RULES.d1, [rec(c, 9)], { saleId: new ObjectId() }),
      ]);
      const rows = await w.service.legacyBaseline(w.principal, w.access, saleId);
      assert.deepEqual(rows.map((row) => [row.productId.toHexString(), row.value]).sort(), [[a.toHexString(), -2], [b.toHexString(), -1]].sort());
      assert.deepEqual(await w.service.legacyBaseline(w.principal, w.access, new ObjectId()), []);
      await assert.rejects(() => createStockRepository(ctx.databases, { maxStateRows: 1 }).legacyState(w.principal, w.access, saleId), /more legacy movements/);
    });

    it('adds the baseline to the state of the origin, so only the difference is written, and reverses it with a reconciliation towards nothing', async () => {
      const w = await world();
      const [a, b] = [await w.product(), await w.product()];
      const from = w.origin();
      const baseline = [
        { placeId: w.placeId, storageId: w.cash, productId: a, companyId: w.companyId, value: -2 },
        { placeId: w.placeId, storageId: w.cash, productId: b, companyId: w.companyId, value: -1 },
      ];
      // The sale of the legacy unloaded 2 of `a` and 1 of `b`: the same target writes nothing.
      assert.deepEqual(await w.service.reconcileOrigin(w.principal, w.access, from, w.target([w.sale(a, 2), w.sale(b, 1)]), w.actor, baseline), { movementIds: [], anomalies: [] });
      // A modification of one line writes the difference and the movements of the origin are added to the baseline from then on.
      const changed = await w.service.reconcileOrigin(w.principal, w.access, from, w.target([w.sale(a, 3), w.sale(b, 1)]), w.actor, baseline);
      assert.equal(changed.movementIds.length, 1);
      assert.equal(await w.stock(a), 9, 'one more of a unloaded');
      assert.deepEqual(await w.service.reconcileOrigin(w.principal, w.access, from, w.target([w.sale(a, 3), w.sale(b, 1)]), w.actor, baseline), { movementIds: [], anomalies: [] });
      const reversed = await w.service.reconcileOrigin(w.principal, w.access, from, null, w.actor, baseline);
      assert.equal(reversed.movementIds.length, 1);
      assert.deepEqual([await w.stock(a), await w.stock(b)], [12, 11], 'everything the legacy and this backend unloaded comes back');
      assert.deepEqual(await w.service.reconcileOrigin(w.principal, w.access, from, null, w.actor, baseline), { movementIds: [], anomalies: [] });
    });
  });

});

describe('the index of the origins of the warehouse movements', () => {
  it('is created once per group, tried again only after the delay when it failed, and reported without the text of the server', async () => {
    const logs = memoryLogger();
    const groupId = new ObjectId();
    const created: string[] = [];
    let fail: unknown = null;
    const databases = {
      group: () => ({
        collection: () => ({
          createIndex: (...args: unknown[]) => {
            created.push(JSON.stringify(args));
            return fail === null ? Promise.resolve('name') : Promise.reject(fail);
          },
        }),
      }),
    } as never;
    const principal = principalOf('SA', { groupId });
    const access = (await accessFor(principal, groupId))!;
    let clock = 1_000;
    const guard = createStockIndexGuard(databases, logs.logger, () => clock);
    await Promise.all([guard.ensure(principal, access), guard.ensure(principal, access)]);
    await guard.ensure(principal, access);
    assert.equal(created.length, 1);
    assert.ok(created[0]!.includes('"unique":true') && created[0]!.includes('partialFilterExpression'));

    const other = new ObjectId();
    const otherPrincipal = principalOf('SA', { groupId: other });
    const otherAccess = (await accessFor(otherPrincipal, other))!;
    fail = Object.assign(new Error('secret server text'), { code: 11000, codeName: 'DuplicateKey' });
    await guard.ensure(otherPrincipal, otherAccess);
    clock += STOCK_INDEX_RETRY_MS - 1;
    await guard.ensure(otherPrincipal, otherAccess);
    assert.equal(created.length, 2);
    clock += 1;
    fail = Object.assign(new Error('secret'), { codeName: 'IndexOptionsConflict', code: 85 });
    await guard.ensure(otherPrincipal, otherAccess);
    await guard.ensure(otherPrincipal, otherAccess);
    assert.equal(created.length, 3);
    const errors = logs.events.filter((event) => event['level'] === 'error');
    assert.equal(errors.length, 1);
    assert.deepEqual([errors[0]!['groupId'], errors[0]!['errorCode']], [other.toHexString(), 11000]);
    assert.equal(logs.events.filter((event) => event['level'] === 'info').length, 1);
    assert.ok(!logs.lines.join('\n').includes('secret'));
    fail = 'plain text';
    const odd = memoryLogger();
    assert.equal(await createStockOriginIndex({ collection: () => ({ createIndex: () => Promise.reject(fail) }) } as never, groupId, odd.logger), false);
    assert.equal(odd.events.filter((event) => event['level'] === 'error')[0]!['errorCode'], null);
  });
});
