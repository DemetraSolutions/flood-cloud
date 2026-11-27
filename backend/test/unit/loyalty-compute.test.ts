import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { computeLegacySaleLoyalty, computeSaleLoyalty, isRefillCode, MAX_LOYALTY_LINES, round2, scaleForState } from '../../src/modules/loyalty/loyalty.compute.ts';
import type { LegacyCardType, LegacyPointsCollection, LoyaltyEffects, SaleCard, SaleFacts } from '../../src/modules/loyalty/loyalty.compute.ts';

const PLACE = new ObjectId();
const CARD_ID = new ObjectId();
const DATE = new Date('2026-06-15T10:00:00Z');

const facts = (extra: Partial<SaleFacts> = {}): SaleFacts => ({ placeId: PLACE, date: DATE, finalTotalCheckout: 50, creditUsed: 0, lines: [], ...extra });
const type = (extra: Partial<LegacyCardType> = {}): LegacyCardType => ({ status: true, prepaid: { status: true, type: 'multi' }, pointsCollect: { status: true, collectionIds: ['c1'] }, placesAvailability: [], ...extra });
const collection = (extra: Partial<LegacyPointsCollection> = {}): LegacyPointsCollection => ({ id: 'c1', status: true, pointConversion: 1, ...extra });
const advanced = (extra: { status?: boolean; cardType?: LegacyCardType | null; collections?: LegacyPointsCollection[] } = {}): SaleCard => ({
  kind: 'advanced',
  card: { id: CARD_ID, code: 'A1', status: extra.status ?? true, cardTypeId: 't1' },
  cardType: extra.cardType === undefined ? type() : extra.cardType,
  collections: extra.collections ?? [collection()],
});
const refill = (code: string, taxedPrice: number, quantity = 1) => ({ code, taxedPrice, quantity });

describe('the calculation of the loyalty effects of a sale', () => {
  it('works out the base net of the credit used and of the refills (50 - 10 - 20 = 20 points at one per unit)', () => {
    const { effects, anomalies } = computeSaleLoyalty(facts({ creditUsed: 10, lines: [refill('000-r-multi-1', 20), refill('SKU', 30)] }), advanced());
    assert.deepEqual(effects, { advanced: { cardId: CARD_ID, code: 'A1', balance: 10, points: { c1: 20 } }, simple: null });
    assert.deepEqual(anomalies, []);
  });

  it('rounds the refills and the credit to two decimals and never gives points for a negative base', () => {
    const odd = computeSaleLoyalty(facts({ finalTotalCheckout: 10, lines: [refill('000-r-mono-x', 3.335, 3)] }), advanced({ cardType: type({ prepaid: { status: true, type: 'mono' } }) }));
    assert.equal(odd.effects.advanced!.balance, 10.01);
    assert.deepEqual(odd.effects.advanced!.points, {});
    const negative = computeSaleLoyalty(facts({ finalTotalCheckout: 5, creditUsed: 10 }), advanced());
    assert.deepEqual(negative.effects.advanced, { cardId: CARD_ID, code: 'A1', balance: -10, points: {} });
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(-1.005), -1.01);
    assert.equal(round2(0), 0);
    assert.ok(Object.is(round2(-0.001), 0));
  });

  it('applies the facts of the till to an inactive card, with the anomaly, and gives it no points', () => {
    const { effects, anomalies } = computeSaleLoyalty(facts({ creditUsed: 4 }), advanced({ status: false }));
    assert.deepEqual(effects.advanced, { cardId: CARD_ID, code: 'A1', balance: -4, points: {} });
    assert.deepEqual(anomalies, [{ code: 'cardInactive' }]);
  });

  it('reports a missing or disabled type and gives no points', () => {
    assert.deepEqual(computeSaleLoyalty(facts({ creditUsed: 4 }), advanced({ cardType: null })).anomalies, [{ code: 'cardTypeMissing' }]);
    const missing = computeSaleLoyalty(facts(), advanced({ cardType: null }));
    assert.deepEqual(missing.effects.advanced!.points, {});
    const disabled = computeSaleLoyalty(facts(), advanced({ cardType: type({ status: false }) }));
    assert.deepEqual(disabled.anomalies, [{ code: 'cardTypeDisabled' }]);
    assert.deepEqual(disabled.effects.advanced!.points, {});
  });

  it('reports credit used or loaded on a type that is not prepaid, only when some moved', () => {
    const plain = type({ prepaid: { status: false, type: null } });
    assert.deepEqual(computeSaleLoyalty(facts({ creditUsed: 1 }), advanced({ cardType: plain })).anomalies, [{ code: 'notPrepaid' }]);
    assert.deepEqual(computeSaleLoyalty(facts({ lines: [refill('000-r-multi', 5)] }), advanced({ cardType: plain })).anomalies, [{ code: 'notPrepaid' }]);
    assert.deepEqual(computeSaleLoyalty(facts(), advanced({ cardType: plain })).anomalies, []);
  });

  it('reports a point of sale the type is not available in, and gives no points there, while a list that has it is fine', () => {
    const elsewhere = computeSaleLoyalty(facts(), advanced({ cardType: type({ placesAvailability: [new ObjectId()] }) }));
    assert.deepEqual(elsewhere.anomalies, [{ code: 'placeNotAllowed' }]);
    assert.deepEqual(elsewhere.effects.advanced!.points, {});
    const here = computeSaleLoyalty(facts(), advanced({ cardType: type({ placesAvailability: [new ObjectId(), PLACE] }) }));
    assert.deepEqual(here.anomalies, []);
    assert.deepEqual(here.effects.advanced!.points, { c1: 50 });
  });

  it('reports refills of both kinds, or of a kind other than the one of the type', () => {
    assert.deepEqual(computeSaleLoyalty(facts({ lines: [refill('000-r-multi', 5), refill('000-r-mono', 5)] }), advanced()).anomalies, [{ code: 'refillMismatch' }]);
    assert.deepEqual(computeSaleLoyalty(facts({ lines: [refill('000-r-mono', 5)] }), advanced()).anomalies, [{ code: 'refillMismatch' }]);
    assert.deepEqual(computeSaleLoyalty(facts({ lines: [refill('000-r-multi', 5)] }), advanced()).anomalies, []);
    // A type with no kind of prepaid, or no type at all, has nothing to compare a single kind with.
    assert.deepEqual(computeSaleLoyalty(facts({ lines: [refill('000-r-mono', 5)] }), advanced({ cardType: type({ prepaid: { status: true, type: null } }) })).anomalies, []);
    assert.deepEqual(computeSaleLoyalty(facts({ lines: [refill('000-r-mono', 5)] }), advanced({ cardType: null })).anomalies, [{ code: 'cardTypeMissing' }, { code: 'notPrepaid' }].slice(0, 1));
  });

  it('gives points only for the collections of the type that are enabled, convert, reach the minimum and are open on the date of the sale', () => {
    const collections = [
      collection({ id: 'c1', pointConversion: 2 }),
      collection({ id: 'c2', status: false }),
      collection({ id: 'c3', pointConversion: 0 }),
      collection({ id: 'c4', pointConversion: null }),
      collection({ id: 'c5', minAmount: 60 }),
      collection({ id: 'c6', minAmount: 50, pointConversion: 10 }),
      collection({ id: 'c7', dateFrom: new Date('2026-07-01T00:00:00Z') }),
      collection({ id: 'c8', dateTo: new Date('2026-06-01T00:00:00Z') }),
      collection({ id: 'c9', dateFrom: DATE, dateTo: DATE, pointConversion: 25 }),
      collection({ id: 'c10', pointsExpirationDate: DATE }),
      collection({ id: 'c11', pointsExpirationDate: new Date('2026-06-16T00:00:00Z'), pointConversion: 7 }),
      collection({ id: 'c12', pointConversion: 100 }),
      collection({ id: 'other' }),
    ];
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'gone'];
    const { effects } = computeSaleLoyalty(facts(), advanced({ cardType: type({ pointsCollect: { status: true, collectionIds: ids } }), collections }));
    assert.deepEqual(effects.advanced!.points, { c1: 25, c6: 5, c9: 2, c11: 7 });
  });

  it('judges the window of a collection by the date of the sale, not by now', () => {
    const closed = [collection({ dateFrom: new Date('2020-01-01T00:00:00Z'), dateTo: new Date('2020-12-31T00:00:00Z') })];
    assert.deepEqual(computeSaleLoyalty(facts({ date: new Date('2020-06-01T00:00:00Z') }), advanced({ collections: closed })).effects.advanced!.points, { c1: 50 });
    assert.deepEqual(computeSaleLoyalty(facts(), advanced({ collections: closed })).effects.advanced!.points, {});
  });

  it('gives no points when the type does not collect them', () => {
    const { effects } = computeSaleLoyalty(facts(), advanced({ cardType: type({ pointsCollect: { status: false, collectionIds: ['c1'] } }) }));
    assert.deepEqual(effects.advanced!.points, {});
  });

  it('takes the whole part of the division without the noise of the floating point', () => {
    const { effects } = computeSaleLoyalty(facts({ finalTotalCheckout: 0.3 }), advanced({ collections: [collection({ pointConversion: 0.1 })] }));
    assert.deepEqual(effects.advanced!.points, { c1: 3 });
  });

  it('works out a simple card with the rule of the currency, and reports a missing or zero rule', () => {
    assert.deepEqual(computeSaleLoyalty(facts({ finalTotalCheckout: 47.9 }), { kind: 'simple', code: 'S1', ruleValue: 5 }), { effects: { advanced: null, simple: { code: 'S1', points: 9 } }, anomalies: [] });
    assert.deepEqual(computeSaleLoyalty(facts({ finalTotalCheckout: 0.3 }), { kind: 'simple', code: 'S1', ruleValue: 0.1 }).effects.simple, { code: 'S1', points: 3 });
    for (const ruleValue of [null, 0]) {
      assert.deepEqual(computeSaleLoyalty(facts(), { kind: 'simple', code: 'S1', ruleValue }), { effects: { advanced: null, simple: { code: 'S1', points: 0 } }, anomalies: [{ code: 'simpleRuleMissing' }] });
    }
    assert.equal(computeSaleLoyalty(facts({ finalTotalCheckout: 5, creditUsed: 10 }), { kind: 'simple', code: 'S1', ruleValue: 1 }).effects.simple!.points, 0);
  });

  it('refuses amounts that are not finite numbers and too many lines, as bugs of the caller', () => {
    for (const bad of [facts({ finalTotalCheckout: Number.NaN }), facts({ creditUsed: Number.POSITIVE_INFINITY }), facts({ lines: [refill('X', Number.NaN)] }), facts({ lines: [refill('X', 1, Number.POSITIVE_INFINITY)] })]) {
      assert.throws(() => computeSaleLoyalty(bad, advanced()), RangeError);
    }
    const many = Array.from({ length: MAX_LOYALTY_LINES + 1 }, () => refill('X', 1));
    assert.throws(() => computeSaleLoyalty(facts({ lines: many }), advanced()), RangeError);
    assert.doesNotThrow(() => computeSaleLoyalty(facts({ lines: many.slice(1) }), advanced()));
  });
});

describe('the effects of a sale scaled to its state', () => {
  const full: LoyaltyEffects = { advanced: { cardId: CARD_ID, code: 'A1', balance: 12.5, points: { c1: 7, c2: 100 } }, simple: { code: 'S1', points: 7 } };

  it('keeps all of an active sale and removes all of a canceled one', () => {
    assert.equal(scaleForState(full, { kind: 'active' }), full);
    assert.equal(scaleForState(full, { kind: 'canceled' }), null);
  });

  it('removes the points of a refund in proportion, keeping the credit and the refill whole (30% of 7 points leaves 4)', () => {
    const scaled = scaleForState(full, { kind: 'refunded', refundedRatio: 0.3 })!;
    assert.deepEqual(scaled.advanced, { cardId: CARD_ID, code: 'A1', balance: 12.5, points: { c1: 4, c2: 70 } });
    assert.deepEqual(scaled.simple, { code: 'S1', points: 4 });
    assert.deepEqual(scaleForState(full, { kind: 'refunded', refundedRatio: 0 }), full);
    assert.deepEqual(scaleForState(full, { kind: 'refunded', refundedRatio: 1 })!.advanced!.points, { c1: 0, c2: 0 });
    // 100 x (1 - 0.07) is 92.99999999999999 in binary: the whole part is still 93.
    assert.deepEqual(scaleForState({ advanced: null, simple: { code: 'S', points: 100 } }, { kind: 'refunded', refundedRatio: 0.07 })!.simple, { code: 'S', points: 93 });
  });

  it('scales a sale that has only one kind of card, and keeps the contact of a simple one', () => {
    const contactId = new ObjectId();
    assert.deepEqual(scaleForState({ advanced: null, simple: null }, { kind: 'refunded', refundedRatio: 0.5 }), { advanced: null, simple: null });
    assert.deepEqual(scaleForState({ advanced: null, simple: { code: 'S', points: 4, contactId } }, { kind: 'refunded', refundedRatio: 0.5 }), { advanced: null, simple: { code: 'S', points: 2, contactId } });
  });

  it('refuses a ratio outside 0..1', () => {
    for (const refundedRatio of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => scaleForState(full, { kind: 'refunded', refundedRatio }), RangeError);
    }
  });
});

describe('the effects of a sale of the legacy, with the legacy formulas (step VS4a)', () => {
  const old = new Date('2026-01-01T00:00:00Z');
  const legacyCard = (extra: { cardType?: LegacyCardType | null; collections?: LegacyPointsCollection[]; insertDate?: Date | null } = {}): SaleCard => ({
    kind: 'advanced',
    card: { id: CARD_ID, code: 'A1', status: false, cardTypeId: 't1', insertDate: extra.insertDate === undefined ? old : extra.insertDate },
    cardType: extra.cardType === undefined ? type() : extra.cardType,
    collections: extra.collections ?? [collection({ pointConversion: 2 })],
  });

  it('recognizes the codes of the refills', () => {
    assert.deepEqual(['000-r-multi-1', '000-r-mono', 'SKU', ''].map(isRefillCode), [true, true, false, false]);
  });

  it('works out a simple card on the gross total, with the noise removed', () => {
    assert.deepEqual(computeLegacySaleLoyalty(facts({ finalTotalCheckout: 50, creditUsed: 20 }), { kind: 'simple', code: 'S', ruleValue: 5 }), { effects: { advanced: null, simple: { code: 'S', points: 10 } }, anomalies: [] });
    assert.deepEqual(computeLegacySaleLoyalty(facts(), { kind: 'simple', code: 'S', ruleValue: null }), { effects: { advanced: null, simple: { code: 'S', points: 0 } }, anomalies: [{ code: 'simpleRuleMissing' }] });
    assert.equal(computeLegacySaleLoyalty(facts({ finalTotalCheckout: 0.3 }), { kind: 'simple', code: 'S', ruleValue: 0.1 }).effects.simple!.points, 3);
  });

  it('charges the credit and gives the points of a card that existed, whatever its status, and nothing otherwise', () => {
    const lines = [refill('000-r-mono-1', 20), refill('SKU', 30)];
    assert.deepEqual(computeLegacySaleLoyalty(facts({ creditUsed: 10, lines }), legacyCard()).effects.advanced, { cardId: CARD_ID, code: 'A1', balance: 10, points: { c1: 25 } });
    // A type that is not prepaid or not in this point of sale moves no credit; one that does not collect gives no points.
    assert.equal(computeLegacySaleLoyalty(facts({ creditUsed: 10, lines }), legacyCard({ cardType: type({ prepaid: { status: false, type: null } }) })).effects.advanced!.balance, 0);
    assert.deepEqual(computeLegacySaleLoyalty(facts({ creditUsed: 10, lines }), legacyCard({ cardType: type({ placesAvailability: [new ObjectId()] }) })).effects.advanced, { cardId: CARD_ID, code: 'A1', balance: 0, points: {} });
    assert.deepEqual(computeLegacySaleLoyalty(facts({ creditUsed: 10, lines }), legacyCard({ cardType: type({ pointsCollect: { status: false, collectionIds: ['c1'] } }) })).effects.advanced!.points, {});
    assert.equal(computeLegacySaleLoyalty(facts({ creditUsed: 10, lines }), legacyCard({ cardType: type({ placesAvailability: [PLACE] }) })).effects.advanced!.balance, 10);
    assert.deepEqual(computeLegacySaleLoyalty(facts({ creditUsed: 10, lines }), legacyCard({ cardType: null })).effects.advanced, { cardId: CARD_ID, code: 'A1', balance: 0, points: {} });
    // Collections that are off, do not convert, are missing, are not reached or are closed give nothing.
    for (const collections of [[collection({ status: false })], [collection({ pointConversion: null })], [collection({ pointConversion: 1000 })], [collection({ minAmount: 100 })], [collection({ dateTo: old })], []]) {
      assert.deepEqual(computeLegacySaleLoyalty(facts({ lines }), legacyCard({ collections })).effects.advanced!.points, {}, JSON.stringify(collections));
    }
    // A card that was made after the sale, or has no creation date, gets nothing.
    const late = new Date('2027-01-01T00:00:00Z');
    for (const insertDate of [late, null]) {
      assert.deepEqual(computeLegacySaleLoyalty(facts({ lines }), legacyCard({ insertDate })), { effects: { advanced: null, simple: null }, anomalies: [{ code: 'legacyCardAfterSale' }] });
    }
    assert.throws(() => computeLegacySaleLoyalty(facts({ finalTotalCheckout: Number.NaN }), legacyCard()), RangeError);
  });

  it('takes back the credit of the refills returned when a sale is refunded, and not the credit used', () => {
    const full: LoyaltyEffects = { advanced: { cardId: CARD_ID, code: 'A1', balance: 80, points: {} }, simple: null };
    assert.equal(scaleForState(full, { kind: 'refunded', refundedRatio: 0.5, refillReturned: 50 })!.advanced!.balance, 30);
    assert.equal(scaleForState(full, { kind: 'refunded', refundedRatio: 0.5 })!.advanced!.balance, 80);
  });
});
