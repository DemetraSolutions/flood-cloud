import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { accessFor } from '../helpers/group-access.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { inGroupTransaction, sessionDatabases } from '../../src/db/session-databases.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { createCardsRepository } from '../../src/modules/fidelity-cards/fidelity-cards.repository.ts';
import { createContactsRepository } from '../../src/modules/contacts/contacts.repository.ts';
import { scaleForState } from '../../src/modules/loyalty/loyalty.compute.ts';
import type { LoyaltyEffects, SaleFacts } from '../../src/modules/loyalty/loyalty.compute.ts';
import { createLoyaltyService } from '../../src/modules/loyalty/loyalty.service.ts';
import type { LoyaltyRepositories, LoyaltySale } from '../../src/modules/loyalty/loyalty.service.ts';
import { createLoyaltyRepository, legacyCardTypeOf, legacyCollectionOf } from '../../src/modules/loyalty/loyalty.repository.ts';

const DATE = new Date('2026-06-15T10:00:00Z');

const CARD_TYPE = { id: 't1', status: true, name: 'Gold', prepaid: { status: true, type: 'multi' }, pointsCollect: { status: true, collectionIds: ['c1', 'c2'] }, placesAvailability: [] };
const COLLECTIONS = [
  { id: 'c1', status: true, pointConversion: 1 },
  { id: 'c2', status: true, pointConversion: 10 },
];

describe('the loyalty effects of a sale on a real database', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  /** A group with its card types, collections and rule, one advanced card `A1` (credit 100, 5 points on `c1`) and its point of sale. */
  async function world(options: { fidelity?: Document; rules?: Document } = {}) {
    const groupId = new ObjectId();
    const placeId = new ObjectId();
    await ctx.databases.common().collection('groups').insertOne({
      _id: groupId,
      fidelity: options.fidelity ?? { cardsTypes: [CARD_TYPE], pointsCollections: COLLECTIONS },
      fidelityCardRules: options.rules ?? { EUR: { code: 'EUR', value: 2, discountPercentage: null } },
    });
    const db = ctx.databases.group(groupId, 'cluster0');
    const principal = principalOf('SA', { groupId });
    const access = (await accessFor(principal, groupId))! as GroupAccess;
    const service = createLoyaltyService({ databases: ctx.databases });
    const card = async (code = 'A1', extra: Document = {}): Promise<ObjectId> => {
      const _id = new ObjectId();
      await db.collection('fidelity_cards').insertOne({ _id, code, cardTypeId: 't1', status: true, balance: new Double(100), pointsCollections: { c1: 5 }, insertDate: DATE, updateDate: DATE, ...extra });
      return _id;
    };
    const contact = async (cards: Document[], extra: Document = {}): Promise<ObjectId> => {
      const _id = new ObjectId();
      await db.collection('contacts').insertOne({ _id, name: 'Mario', fidelities: cards, ...extra });
      return _id;
    };
    const cardOf = (id: ObjectId) => db.collection('fidelity_cards').findOne({ _id: id });
    const pointsOf = async (id: ObjectId, code: string): Promise<unknown> => ((await db.collection('contacts').findOne({ _id: id }))!['fidelities'] as Document[]).find((item) => item['code'] === code)?.['points'];
    const movements = (filter: Document = {}) => db.collection('fidelity_cards_movements').find(filter).sort({ _id: 1 }).toArray();
    const facts = (extra: Partial<SaleFacts> = {}): SaleFacts => ({ placeId, date: DATE, finalTotalCheckout: 50, creditUsed: 10, lines: [{ code: '000-r-multi-1', taxedPrice: 20, quantity: 1 }, { code: 'SKU', taxedPrice: 30, quantity: 1 }], ...extra });
    const sale = (extra: Partial<LoyaltySale> = {}): LoyaltySale => ({ saleId: new ObjectId(), customerId: null, date: DATE, ...extra });
    const actor = { userId: principal.userId };
    const reconcile = (from: LoyaltySale, desired: LoyaltyEffects | null, applied: LoyaltyEffects | null, who: { userId: ObjectId | null; storeKeyId?: ObjectId } = actor) => service.reconcileSaleLoyalty(principal, access, from, desired, applied, who);
    const effectsOf = async (code: string, extra: Partial<SaleFacts> = {}) => (await service.loyaltyOfSale(principal, access, facts(extra), code, 'EUR')).effects;
    return { groupId, placeId, db, principal, access, service, card, contact, cardOf, pointsOf, movements, facts, sale, actor, reconcile, effectsOf };
  }

  it('applies a sale to an advanced card: the credit, the points by collection, and a movement for each, in the shape the legacy reads', async () => {
    const w = await world();
    const id = await w.card();
    const from = w.sale();
    const worked = await w.service.loyaltyOfSale(w.principal, w.access, w.facts(), 'A1', 'EUR');
    assert.deepEqual(worked.anomalies, []);
    assert.deepEqual(worked.effects, { advanced: { cardId: id, code: 'A1', balance: 10, points: { c1: 20, c2: 2 } }, simple: null });
    const storeKeyId = new ObjectId();
    const outcome = await w.reconcile(from, worked.effects, null, { userId: w.principal.userId, storeKeyId });
    assert.deepEqual(outcome.anomalies, []);
    assert.deepEqual(outcome.applied, worked.effects);
    const stored = (await w.cardOf(id))!;
    assert.equal(stored['balance'], 110);
    // The credit stays a double in the database, as the legacy writes it.
    assert.equal((await w.db.collection('fidelity_cards').aggregate([{ $match: { _id: id } }, { $project: { kind: { $type: '$balance' } } }]).toArray())[0]!['kind'], 'double');
    assert.deepEqual(stored['pointsCollections'], { c1: 25, c2: 2 });
    assert.deepEqual(stored['updateDate'], DATE);
    const rows = await w.movements();
    assert.deepEqual(rows.map((row) => row['_id']), outcome.movementIds);
    assert.deepEqual(rows.map((row) => [row['balance'], row['pointsCollectionId'], row['points']]), [[10, null, 0], [0, 'c1', 20], [0, 'c2', 2]]);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['_id', 'balance', 'cardCode', 'cardId', 'date', 'points', 'pointsCollectionId', 'saleId', 'storeKeyId', 'type', 'userId']);
      assert.deepEqual([row['type'], row['saleId'], row['cardId'], row['cardCode'], row['date'], row['userId'], row['storeKeyId']], ['sale', from.saleId, id, 'A1', DATE, w.principal.userId, storeKeyId]);
      assert.ok(row['saleId'] instanceof ObjectId && row['cardId'] instanceof ObjectId && row['date'] instanceof Date && typeof row['balance'] === 'number' && typeof row['points'] === 'number');
    }
    // The history of the card shows them as the legacy shows its own.
    assert.equal(await createCardsRepository(ctx.databases).hasMovements(w.principal, w.access, { id, code: 'A1' }), true);
  });

  it('writes nothing when the sale repeats the state it has applied, with and without the operator', async () => {
    const w = await world();
    const id = await w.card();
    const from = w.sale();
    const wanted = await w.effectsOf('A1');
    const first = await w.reconcile(from, wanted, null, { userId: null });
    assert.equal((await w.movements())[0]!['userId'], null);
    const again = await w.reconcile(from, wanted, first.applied);
    assert.deepEqual(again.movementIds, []);
    assert.deepEqual(again.applied, wanted);
    assert.equal((await w.movements()).length, 3);
    assert.equal((await w.cardOf(id))!['balance'], 110);
    // A sale that has nothing to apply (no credit, no points) records its state and writes nothing.
    const empty = await w.reconcile(w.sale(), { advanced: { cardId: id, code: 'A1', balance: 0, points: {} }, simple: null }, null);
    assert.deepEqual(empty.movementIds, []);
    assert.deepEqual(empty.applied!.advanced!.points, {});
  });

  it('removes the points of a refund in proportion, writing only the difference of the points', async () => {
    const w = await world();
    const id = await w.card();
    const from = w.sale();
    const full = await w.effectsOf('A1');
    const first = await w.reconcile(from, full, null);
    const refunded = scaleForState(full, { kind: 'refunded', refundedRatio: 0.3 });
    const outcome = await w.reconcile(from, refunded, first.applied);
    assert.equal(outcome.movementIds.length, 2);
    assert.deepEqual(outcome.applied, refunded);
    const rows = await w.movements({ _id: { $in: outcome.movementIds } });
    assert.deepEqual(rows.map((row) => [row['type'], row['balance'], row['pointsCollectionId'], row['points']]), [['sale', 0, 'c1', -6], ['sale', 0, 'c2', -1]]);
    const stored = (await w.cardOf(id))!;
    assert.deepEqual([stored['balance'], stored['pointsCollections']], [110, { c1: 19, c2: 1 }]);
  });

  it('reverses everything of a canceled sale, the refill included, and leaves the card as it was', async () => {
    const w = await world();
    const id = await w.card();
    const from = w.sale();
    const first = await w.reconcile(from, await w.effectsOf('A1'), null);
    const outcome = await w.reconcile(from, null, first.applied);
    assert.equal(outcome.applied, null);
    const rows = await w.movements({ _id: { $in: outcome.movementIds } });
    assert.deepEqual(rows.map((row) => [row['type'], row['saleId'], row['balance'], row['pointsCollectionId'], row['points']]), [['canceled_sale', from.saleId, -10, null, 0], ['canceled_sale', from.saleId, 0, 'c1', -20], ['canceled_sale', from.saleId, 0, 'c2', -2]]);
    const stored = (await w.cardOf(id))!;
    assert.deepEqual([stored['balance'], stored['pointsCollections']], [100, { c1: 5, c2: 0 }]);
    assert.deepEqual((await w.reconcile(from, null, null)).movementIds, []);
  });

  it('lets a sale take the credit below zero, with the anomaly, while the manual adjustments stay blocked', async () => {
    const w = await world();
    const id = await w.card();
    const effects = await w.effectsOf('A1', { creditUsed: 500, finalTotalCheckout: 500, lines: [] });
    const outcome = await w.reconcile(w.sale(), effects, null);
    assert.deepEqual(outcome.anomalies, [{ code: 'negativeBalance' }]);
    assert.equal((await w.cardOf(id))!['balance'], -400);
    const cards = createCardsRepository(ctx.databases);
    assert.equal(await cards.adjust(w.principal, w.access, id, { balance: -1, points: [] }, 't1'), null);
    const contacts = createContactsRepository(ctx.databases);
    const holder = await w.contact([{ code: 'S1', points: 0 }]);
    assert.equal(await contacts.adjustPoints(w.principal, w.access, holder, 'S1', -1), null);
  });

  it('reports the points that would go below zero when a sale is reversed over a card that spent them', async () => {
    const w = await world();
    const id = await w.card('A1', { pointsCollections: { c1: 3 } });
    const from = w.sale();
    const effects = await w.effectsOf('A1');
    await w.reconcile(from, effects, null);
    await w.db.collection('fidelity_cards').updateOne({ _id: id }, { $set: { 'pointsCollections.c1': 1 } });
    const outcome = await w.reconcile(from, null, effects);
    assert.deepEqual(outcome.anomalies, [{ code: 'negativePoints', collectionId: 'c1' }]);
    assert.equal(((await w.cardOf(id))!['pointsCollections'] as Document)['c1'], -19);
  });

  it('gives the facts of the till and no points to an inactive card, to a card of a missing or disabled type and to a point of sale the type excludes', async () => {
    const w = await world({ fidelity: { cardsTypes: [CARD_TYPE, { ...CARD_TYPE, id: 't2', status: false }, { ...CARD_TYPE, id: 't3', placesAvailability: [new ObjectId()] }], pointsCollections: COLLECTIONS } });
    await w.card('OFF', { status: false });
    await w.card('GONE', { cardTypeId: 'nope' });
    await w.card('NOTYPE', { cardTypeId: undefined });
    await w.card('DIS', { cardTypeId: 't2' });
    await w.card('ELSE', { cardTypeId: 't3' });
    const code = async (value: string) => w.service.loyaltyOfSale(w.principal, w.access, w.facts(), value, 'EUR');
    assert.deepEqual((await code('OFF')).anomalies, [{ code: 'cardInactive' }]);
    assert.deepEqual((await code('GONE')).anomalies, [{ code: 'cardTypeMissing' }]);
    assert.deepEqual((await code('NOTYPE')).anomalies, [{ code: 'cardTypeMissing' }]);
    assert.deepEqual((await code('DIS')).anomalies, [{ code: 'cardTypeDisabled' }]);
    assert.deepEqual((await code('ELSE')).anomalies, [{ code: 'placeNotAllowed' }]);
    for (const value of ['OFF', 'GONE', 'DIS', 'ELSE']) {
      const { effects } = await code(value);
      assert.equal(effects.advanced!.balance, 10, value);
      assert.deepEqual(effects.advanced!.points, {}, value);
    }
  });

  it('keeps the old state when the card is the same but gone, and drops what could not be applied or undone', async () => {
    const w = await world();
    const ghost = new ObjectId();
    const wanted: LoyaltyEffects = { advanced: { cardId: ghost, code: 'GHOST', balance: 5, points: { c1: 2 } }, simple: null };
    const none = await w.reconcile(w.sale(), wanted, null);
    assert.deepEqual([none.applied, none.movementIds, none.anomalies], [null, [], [{ code: 'cardNotFound' }]]);
    // The same card, now gone: the difference is not applied and the old state stays, so a new attempt applies it again.
    const had: LoyaltyEffects = { advanced: { cardId: ghost, code: 'GHOST', balance: 1, points: {} }, simple: null };
    const stuck = await w.reconcile(w.sale(), wanted, had);
    assert.deepEqual(stuck.applied, had);
    assert.deepEqual(stuck.anomalies, [{ code: 'cardNotFound' }]);
    // A cancellation of a card that is gone has nothing left to undo.
    const gone = await w.reconcile(w.sale(), null, had);
    assert.deepEqual([gone.applied, gone.anomalies], [null, [{ code: 'cardNotFound' }]]);
    // A card whose credit is not a number cannot be added to either.
    const broken = await w.card('BROKEN', { balance: 'lots' });
    const bad = await w.reconcile(w.sale(), { advanced: { cardId: broken, code: 'BROKEN', balance: 1, points: {} }, simple: null }, null);
    assert.deepEqual([bad.applied, bad.anomalies], [null, [{ code: 'cardNotFound' }]]);
    const listed = await w.card('LIST', { pointsCollections: [1] });
    assert.equal((await w.reconcile(w.sale(), { advanced: { cardId: listed, code: 'LIST', balance: 0, points: { c1: 1 } }, simple: null }, null)).applied, null);
  });

  it('moves a sale from one card to another: the old one is reversed and the new one applied', async () => {
    const w = await world();
    const one = await w.card('A1');
    const two = await w.card('A2', { pointsCollections: {} });
    const from = w.sale();
    const first = await w.reconcile(from, await w.effectsOf('A1'), null);
    const second = await w.reconcile(from, await w.effectsOf('A2'), first.applied);
    assert.equal(second.applied!.advanced!.cardId.toHexString(), two.toHexString());
    assert.deepEqual([(await w.cardOf(one))!['balance'], (await w.cardOf(one))!['pointsCollections']], [100, { c1: 5, c2: 0 }]);
    assert.deepEqual([(await w.cardOf(two))!['balance'], (await w.cardOf(two))!['pointsCollections']], [110, { c1: 20, c2: 2 }]);
    assert.equal((await w.movements({ cardId: one, type: 'sale', balance: -10 })).length, 1);
    // Moved to a card that is gone: the old one is reversed, nothing is applied.
    const lost = await w.reconcile(from, { advanced: { cardId: new ObjectId(), code: 'X', balance: 1, points: {} }, simple: null }, second.applied);
    assert.equal(lost.applied, null);
    assert.deepEqual(lost.anomalies, [{ code: 'cardNotFound' }]);
    assert.equal((await w.cardOf(two))!['balance'], 100);
  });

  it('works out what the legacy did to a sale with the legacy formulas, and nothing for a card that did not exist yet (step VS4a)', async () => {
    const w = await world();
    const old = await w.card('OLD', { insertDate: new Date('2026-01-01T00:00:00Z') });
    const none = await w.service.legacyLoyaltyOfSale(w.principal, w.access, w.facts(), 'OLD', 'EUR');
    assert.deepEqual([none.effects.advanced!.cardId, none.effects.advanced!.balance, none.effects.advanced!.points['c1']], [old, 10, 50]);
    await w.card('LATE', { insertDate: new Date('2027-01-01T00:00:00Z') });
    assert.deepEqual(await w.service.legacyLoyaltyOfSale(w.principal, w.access, w.facts(), 'LATE', 'EUR'), { effects: { advanced: null, simple: null }, anomalies: [{ code: 'legacyCardAfterSale' }] });
    await w.card('NOTYPE', { cardTypeId: null, insertDate: new Date('2026-01-01T00:00:00Z') });
    assert.equal((await w.service.legacyLoyaltyOfSale(w.principal, w.access, w.facts(), 'NOTYPE', 'EUR')).effects.advanced!.balance, 0);
    await w.card('GHOST', { cardTypeId: 'gone', insertDate: new Date('2026-01-01T00:00:00Z') });
    assert.equal((await w.service.legacyLoyaltyOfSale(w.principal, w.access, w.facts(), 'GHOST', 'EUR')).effects.advanced!.balance, 0);
    assert.deepEqual((await w.service.legacyLoyaltyOfSale(w.principal, w.access, w.facts(), 'SIMPLE', 'EUR')).effects, { advanced: null, simple: { code: 'SIMPLE', points: 25 } });
    await w.card(' AM');
    await w.card('AM ');
    assert.deepEqual(await w.service.legacyLoyaltyOfSale(w.principal, w.access, w.facts(), 'AM', 'EUR'), { effects: { advanced: null, simple: null }, anomalies: [{ code: 'cardAmbiguous' }] });
    for (const blank of [null, '', '   ']) {
      assert.deepEqual(await w.service.legacyLoyaltyOfSale(w.principal, w.access, w.facts(), blank, 'EUR'), { effects: { advanced: null, simple: null }, anomalies: [] });
    }
  });

  it('finds the advanced card by its code, also with the spaces a legacy code may have, and tells an ambiguous code', async () => {
    const w = await world();
    const spaced = await w.card(' SP ');
    assert.equal((await w.effectsOf('SP')).advanced!.cardId.toHexString(), spaced.toHexString());
    assert.equal((await w.effectsOf('SP')).advanced!.code, ' SP ');
    const exact = await w.card('EX');
    await w.card(' EX');
    assert.equal((await w.effectsOf('EX')).advanced!.cardId.toHexString(), exact.toHexString());
    await w.card(' AM');
    await w.card('AM ');
    const ambiguous = await w.service.loyaltyOfSale(w.principal, w.access, w.facts(), 'AM', 'EUR');
    assert.deepEqual(ambiguous, { effects: { advanced: null, simple: null }, anomalies: [{ code: 'cardAmbiguous' }] });
    for (const blank of [null, '', '   ']) {
      assert.deepEqual(await w.service.loyaltyOfSale(w.principal, w.access, w.facts(), blank, 'EUR'), { effects: { advanced: null, simple: null }, anomalies: [] });
    }
  });

  it('treats a code that is not an advanced card as a simple one, with the rule of the currency', async () => {
    const w = await world();
    assert.deepEqual((await w.service.loyaltyOfSale(w.principal, w.access, w.facts(), 'S1', 'EUR')).effects, { advanced: null, simple: { code: 'S1', points: 10 } });
    assert.deepEqual((await w.service.loyaltyOfSale(w.principal, w.access, w.facts(), 'S1', 'USD')).anomalies, [{ code: 'simpleRuleMissing' }]);
    assert.deepEqual((await w.service.loyaltyOfSale(w.principal, w.access, w.facts(), 'S1', '__proto__')).anomalies, [{ code: 'simpleRuleMissing' }]);
    const bare = await world({ fidelity: {}, rules: {} });
    assert.deepEqual((await bare.service.loyaltyOfSale(bare.principal, bare.access, bare.facts(), 'S1', 'EUR')).anomalies, [{ code: 'simpleRuleMissing' }]);
    await bare.card('A1');
    assert.deepEqual((await bare.service.loyaltyOfSale(bare.principal, bare.access, bare.facts(), 'A1', 'EUR')).anomalies, [{ code: 'cardTypeMissing' }]);
  });

  it('reads the types and the collections of the legacy tolerantly', async () => {
    assert.equal(legacyCardTypeOf({ status: true }), null);
    assert.equal(legacyCardTypeOf({ id: 'bare' })!.type.pointsCollect.status, false);
    assert.equal(legacyCollectionOf({ status: true }), null);
    const place = new ObjectId();
    assert.deepEqual(legacyCardTypeOf({ id: 't', status: 'yes', prepaid: 'x', pointsCollect: { status: true, collectionIds: ['a', 1] }, placesAvailability: [place, place.toHexString(), 'junk', 4] }), {
      id: 't',
      type: { status: false, prepaid: { status: false, type: null }, pointsCollect: { status: true, collectionIds: ['a'] }, placesAvailability: [place, place] },
    });
    assert.deepEqual(legacyCardTypeOf({ id: 't', prepaid: { status: true, type: 'mono' }, pointsCollect: { collectionIds: 'x' }, placesAvailability: 'x' })!.type, {
      status: false,
      prepaid: { status: true, type: 'mono' },
      pointsCollect: { status: false, collectionIds: [] },
      placesAvailability: [],
    });
    const when = new Date('2026-01-01T00:00:00Z');
    assert.deepEqual(legacyCollectionOf({ id: 'c', status: true, pointConversion: '2', minAmount: 3, dateFrom: when, dateTo: new Date('x'), pointsExpirationDate: 'soon' }), {
      id: 'c',
      status: true,
      pointConversion: null,
      minAmount: 3,
      dateFrom: when,
      dateTo: null,
      pointsExpirationDate: null,
    });
    // A group with no document has nothing set up.
    const none = await createLoyaltyRepository(ctx.databases).readSetup(principalOf('SA', { groupId: new ObjectId() }), { groupId: new ObjectId() } as GroupAccess, 'EUR');
    assert.deepEqual([none.cardTypes.size, none.collections, none.ruleValue], [0, [], null]);
    const w = await world({ fidelity: { cardsTypes: [CARD_TYPE, 'junk', { status: true }], pointsCollections: [{ id: 'c1', status: true, pointConversion: 4 }, null, { name: 'no id' }] } });
    const setup = await createLoyaltyRepository(ctx.databases).readSetup(w.principal, w.access, 'EUR');
    assert.deepEqual([...setup.cardTypes.keys()], ['t1']);
    assert.deepEqual(setup.collections.map((item) => item.id), ['c1']);
    assert.equal(setup.ruleValue, 2);
  });

  describe('simple cards', () => {
    it('moves the points of the customer when it has the code, even when another contact has it too, and gives them back to the same contact', async () => {
      const w = await world();
      const customer = await w.contact([{ code: 'S1', points: 3 }]);
      const other = await w.contact([{ code: 'S1', points: 7 }]);
      const from = w.sale({ customerId: customer });
      const effects = await w.effectsOf('S1');
      const first = await w.reconcile(from, effects, null);
      assert.deepEqual(first.applied, { advanced: null, simple: { code: 'S1', points: 10, contactId: customer } });
      assert.deepEqual([await w.pointsOf(customer, 'S1'), await w.pointsOf(other, 'S1')], [13, 7]);
      assert.deepEqual(first.movementIds, []);
      assert.equal((await w.movements()).length, 0);
      const refunded = scaleForState(effects, { kind: 'refunded', refundedRatio: 0.5 });
      const second = await w.reconcile(from, refunded, first.applied);
      assert.equal(await w.pointsOf(customer, 'S1'), 8);
      assert.deepEqual((await w.reconcile(from, refunded, second.applied)).applied, second.applied);
      assert.equal(await w.pointsOf(customer, 'S1'), 8);
      // The customer of the sale changed later: the reversal still goes to the contact that got the points.
      const third = await w.reconcile({ ...from, customerId: null }, null, second.applied);
      assert.deepEqual([third.applied, await w.pointsOf(customer, 'S1'), await w.pointsOf(other, 'S1')], [null, 3, 7]);
    });

    it('finds the only contact that has the code when the sale has no customer, and ignores the ones in the trash', async () => {
      const w = await world();
      const holder = await w.contact([{ code: 'S2', points: 1 }, { code: 'other', points: 9 }]);
      await w.contact([{ code: 'S2', points: 50 }], { trash: true });
      const effects = await w.effectsOf('S2');
      const outcome = await w.reconcile(w.sale(), effects, null);
      assert.deepEqual(outcome.anomalies, []);
      assert.equal(await w.pointsOf(holder, 'S2'), 11);
      assert.equal(await w.pointsOf(holder, 'other'), 9);
      // A customer that does not have the code does not stop the lookup.
      const stranger = await w.contact([{ code: 'zzz', points: 0 }]);
      const outcomeStranger = await w.reconcile(w.sale({ customerId: stranger }), effects, null);
      assert.equal(await w.pointsOf(holder, 'S2'), 21);
      assert.deepEqual(outcomeStranger.anomalies, []);
    });

    it('reports a code that no contact has, or that more than one has, and does not mark the part as applied', async () => {
      const w = await world();
      const effects = await w.effectsOf('S3');
      const none = await w.reconcile(w.sale(), effects, null);
      assert.deepEqual([none.applied, none.anomalies], [null, [{ code: 'simpleCardNotFound' }]]);
      const a = await w.contact([{ code: 'S3', points: 0 }]);
      const b = await w.contact([{ code: 'S3', points: 0 }]);
      const many = await w.reconcile(w.sale(), effects, null);
      assert.deepEqual([many.applied, many.anomalies], [null, [{ code: 'simpleCardAmbiguous' }]]);
      assert.deepEqual([await w.pointsOf(a, 'S3'), await w.pointsOf(b, 'S3')], [0, 0]);
      // A card that has no points yet starts at zero, and one whose points are not a number is not a card to move.
      const fresh = await w.contact([{ code: 'S4' }]);
      await w.reconcile(w.sale(), await w.effectsOf('S4'), null);
      assert.equal(await w.pointsOf(fresh, 'S4'), 10);
      await w.contact([{ code: 'S5', points: 'many' }]);
      assert.equal((await w.reconcile(w.sale(), await w.effectsOf('S5'), null)).applied, null);
    });

    it('lets the points go below zero with the anomaly, and keeps the old state when the contact is gone meanwhile', async () => {
      const w = await world();
      const holder = await w.contact([{ code: 'S6', points: 0 }]);
      const effects = await w.effectsOf('S6');
      const first = await w.reconcile(w.sale(), effects, null);
      await w.db.collection('contacts').updateOne({ _id: holder }, { $set: { 'fidelities.0.points': 5 } });
      const second = await w.reconcile(w.sale(), null, first.applied);
      assert.deepEqual(second.anomalies, [{ code: 'negativePoints' }]);
      assert.equal(await w.pointsOf(holder, 'S6'), -5);
      // The same card on the same contact, but the contact went to the trash: the difference is not applied.
      await w.db.collection('contacts').updateOne({ _id: holder }, { $set: { trash: true } });
      const had = { advanced: null, simple: { code: 'S6', points: 4, contactId: holder } };
      const kept = await w.reconcile(w.sale({ customerId: holder }), { advanced: null, simple: { code: 'S6', points: 9 } }, had);
      assert.deepEqual(kept.anomalies, [{ code: 'simpleCardNotFound' }]);
      assert.equal(kept.applied, null);
      // A reversal to a contact that is gone is reported and dropped.
      assert.deepEqual((await w.reconcile(w.sale(), null, had)).anomalies, [{ code: 'simpleCardNotFound' }]);
    });

    it('moves the points to the new card or contact when the sale changes them, and resolves the contact of a state that has none', async () => {
      const w = await world();
      const first = await w.contact([{ code: 'S7', points: 0 }]);
      const second = await w.contact([{ code: 'S8', points: 0 }]);
      const from = w.sale();
      const applied = (await w.reconcile(from, await w.effectsOf('S7'), null)).applied!;
      const changed = await w.reconcile(from, await w.effectsOf('S8'), applied);
      assert.deepEqual([await w.pointsOf(first, 'S7'), await w.pointsOf(second, 'S8'), changed.applied!.simple!.contactId], [0, 10, second]);
      // A state saved without the contact (rebuilt from the legacy): the contact is found again, by the customer or the code.
      const rebuilt = { advanced: null, simple: { code: 'S8', points: 10 } };
      const again = await w.reconcile(from, await w.effectsOf('S8'), rebuilt);
      assert.deepEqual(again.applied, { advanced: null, simple: { code: 'S8', points: 10, contactId: second } });
      assert.equal(await w.pointsOf(second, 'S8'), 10);
      const undone = await w.reconcile(from, null, rebuilt);
      assert.deepEqual([undone.applied, await w.pointsOf(second, 'S8')], [null, 0]);
      // The same code on another contact than the one that got the points: they follow the sale.
      const third = await w.contact([{ code: 'S8', points: 0 }]);
      await w.db.collection('contacts').updateOne({ _id: second }, { $set: { 'fidelities.0.points': 10 } });
      const moved = await w.reconcile(w.sale({ customerId: third }), await w.effectsOf('S8'), { advanced: null, simple: { code: 'S8', points: 10, contactId: second } });
      assert.deepEqual([await w.pointsOf(second, 'S8'), await w.pointsOf(third, 'S8'), moved.applied!.simple!.contactId], [0, 10, third]);
      // Points of zero are recorded without touching any contact.
      const zero = await w.reconcile(w.sale({ customerId: third }), { advanced: null, simple: { code: 'S8', points: 0 } }, { advanced: null, simple: { code: 'S8', points: 0, contactId: third } });
      assert.deepEqual(zero.applied, { advanced: null, simple: { code: 'S8', points: 0, contactId: third } });
      assert.deepEqual((await w.reconcile(from, null, { advanced: null, simple: { code: 'S8', points: 0, contactId: third } })).anomalies, []);
    });

    it('applies both kinds of card of a sale together and drops the part that is not wanted any more', async () => {
      const w = await world();
      const id = await w.card();
      const holder = await w.contact([{ code: 'S9', points: 0 }]);
      const both: LoyaltyEffects = { advanced: (await w.effectsOf('A1')).advanced, simple: (await w.effectsOf('S9')).simple };
      const from = w.sale();
      const first = await w.reconcile(from, both, null);
      assert.equal(await w.pointsOf(holder, 'S9'), 10);
      assert.equal((await w.cardOf(id))!['balance'], 110);
      const onlyAdvanced = await w.reconcile(from, { advanced: both.advanced, simple: null }, first.applied);
      assert.deepEqual([onlyAdvanced.applied!.simple, await w.pointsOf(holder, 'S9')], [null, 0]);
      assert.equal(onlyAdvanced.movementIds.length, 0);
    });
  });

  it('keeps the old state of a simple card when the points cannot be added to the contact that was found', async () => {
    const w = await world();
    const holder = await w.contact([{ code: 'S1', points: 4 }]);
    const stubborn = createLoyaltyService({
      databases: ctx.databases,
      repositoriesOver: (databases): LoyaltyRepositories => ({ setup: createLoyaltyRepository(databases), cards: createCardsRepository(databases), contacts: { ...createContactsRepository(databases), addSalePoints: async () => null } }),
    });
    const had = { advanced: null, simple: { code: 'S1', points: 4, contactId: holder } };
    const outcome = await stubborn.reconcileSaleLoyalty(w.principal, w.access, w.sale(), { advanced: null, simple: { code: 'S1', points: 9 } }, had, w.actor);
    assert.deepEqual([outcome.applied, outcome.anomalies], [had, [{ code: 'simpleCardNotFound' }]]);
  });

  it('joins the transaction of the caller when nested and leaves nothing when the caller aborts', async () => {
    const w = await world();
    const id = await w.card();
    const holder = await w.contact([{ code: 'S1', points: 0 }]);
    const abort = new Error('the sale failed');
    const both: LoyaltyEffects = { advanced: (await w.effectsOf('A1')).advanced, simple: (await w.effectsOf('S1')).simple };
    const from = w.sale();
    await assert.rejects(
      inGroupTransaction(w.principal, w.access, ctx.databases, async (session) => {
        const nested = createLoyaltyService({ databases: sessionDatabases(ctx.databases, session, w.groupId), nested: true });
        const outcome = await nested.reconcileSaleLoyalty(w.principal, w.access, from, both, null, w.actor);
        assert.equal(outcome.movementIds.length, 3);
        // What the transaction wrote is read back inside it: the card is found with its new credit.
        assert.deepEqual((await nested.reconcileSaleLoyalty(w.principal, w.access, from, both, outcome.applied, w.actor)).movementIds, []);
        throw abort;
      }),
      (error: unknown) => error === abort,
    );
    assert.deepEqual([(await w.cardOf(id))!['balance'], await w.pointsOf(holder, 'S1')], [100, 0]);
    assert.deepEqual(await w.movements(), []);
    await inGroupTransaction(w.principal, w.access, ctx.databases, async (session) => {
      const nested = createLoyaltyService({ databases: sessionDatabases(ctx.databases, session, w.groupId), nested: true });
      await nested.reconcileSaleLoyalty(w.principal, w.access, from, both, null, w.actor);
    });
    assert.deepEqual([(await w.cardOf(id))!['balance'], await w.pointsOf(holder, 'S1')], [110, 10]);
    assert.equal((await w.movements()).length, 3);
  });

  it('writes nothing of the card when the movements cannot be written (all or nothing)', async () => {
    const w = await world();
    const id = await w.card();
    const effects = await w.effectsOf('A1');
    const broken = createLoyaltyService({
      databases: ctx.databases,
      repositoriesOver: (databases): LoyaltyRepositories => {
        const cards = createCardsRepository(databases);
        return { setup: createLoyaltyRepository(databases), contacts: createContactsRepository(databases), cards: { findByCodes: cards.findByCodes, applySale: cards.applySale, insertMovements: () => Promise.reject(new Error('disk full')) } };
      },
    });
    await assert.rejects(broken.reconcileSaleLoyalty(w.principal, w.access, w.sale(), effects, null, w.actor), /disk full/);
    assert.equal((await w.cardOf(id))!['balance'], 100);
  });

  it('never reaches the cards or the contacts of another group', async () => {
    const mine = await world();
    const theirs = await world();
    const theirCard = await theirs.card('A1');
    const theirHolder = await theirs.contact([{ code: 'S1', points: 0 }]);
    // The code of a card of another group is a simple card here, and the card of the other group is not found by its id.
    assert.ok((await mine.effectsOf('A1')).simple !== null);
    const stranger: LoyaltyEffects = { advanced: { cardId: theirCard, code: 'A1', balance: 5, points: {} }, simple: { code: 'S1', points: 3 } };
    const outcome = await mine.reconcile(mine.sale(), stranger, null);
    assert.deepEqual(outcome.anomalies.map((anomaly) => anomaly.code).sort(), ['cardNotFound', 'simpleCardNotFound']);
    assert.equal((await theirs.cardOf(theirCard))!['balance'], 100);
    assert.equal(await theirs.pointsOf(theirHolder, 'S1'), 0);
    assert.deepEqual(await theirs.movements(), []);
  });

  it('refuses effects that are not numbers as a bug of the caller', async () => {
    const w = await world();
    const id = await w.card();
    for (const advanced of [{ cardId: id, code: 'A1', balance: Number.NaN, points: {} }, { cardId: id, code: 'A1', balance: 1, points: { c1: 1.5 } }]) {
      await assert.rejects(w.reconcile(w.sale(), { advanced, simple: null }, null), RangeError);
    }
    await assert.rejects(w.reconcile(w.sale(), { advanced: null, simple: { code: 'S1', points: 0.5 } }, null), RangeError);
    await assert.rejects(w.reconcile(w.sale(), { advanced: { cardId: id, code: 'A1', balance: 1, points: { 'bad.id': 1 } }, simple: null }, null), /safe id/);
  });
});
