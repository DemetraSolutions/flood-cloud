import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { buildInvoiceDocument, hubOf, invoiceTypeOf, invoiceViewOf, isHubAllowed, queueRecordOf } from '../../src/modules/sales/sales.invoice.ts';
import type { InvoiceInput } from '../../src/modules/sales/sales.invoice.ts';
import { reduceBy } from '../../src/modules/sales/sales.lines.ts';

/** The pure parts of the invoice of a sale (step VS5). */
const NOW = new Date('2026-11-27T12:00:00Z');

function input(overrides: Partial<InvoiceInput> = {}, sale: Document = {}): InvoiceInput {
  return {
    documentId: new ObjectId(),
    sale: {
      _id: new ObjectId(),
      userId: new ObjectId(),
      timestampId: 'T-1',
      date: new Date('2026-11-27T10:00:00Z'),
      companyId: new ObjectId(),
      placeId: new ObjectId(),
      customerType: 2,
      savedCheckoutsNote: 'Note',
      adjustmentType: 'discount',
      discountPercentage: 10,
      discountValue: 2,
      finalTotalTaxableWithoutDiscount: 20,
      finalTotalTaxable: 18,
      finalTotalTax: 3.96,
      finalTotalCheckoutWithoutDiscount: 24.4,
      finalTotalCheckout: 21.96,
      products: [{ qt: 1 }, 'not a line'],
      ...sale,
    },
    reservation: { number: 7, prefixSuffix: 'A', prefixSuffixPosition: 'prefix', year: 2026, anomalies: [] },
    progressive: 3,
    type: 'TD01',
    company: { _id: new ObjectId(), name: 'Acme', invoicesPS: 'prefix' },
    counterpart: { _id: new ObjectId(), name: 'Mario' },
    storageId: new ObjectId(),
    xml: null,
    unpaidIds: [],
    sendStatus: 'notQueued',
    groupId: new ObjectId(),
    now: NOW,
    ...overrides,
  };
}

describe('the list rule of the lines', () => {
  it('reduces a list of objects to its first elements with something in them, and ignores what is not a list', () => {
    const rules = { rows: { type: 'list', max: 2, item: { a: { type: 'text', max: 3 } } } } as const;
    assert.deepEqual(reduceBy(rules, { rows: [{ b: 1 }, { a: 'abcdef' }, { a: 'z' }] }), { rows: [{ a: 'abc' }] });
    assert.deepEqual(reduceBy(rules, { rows: [{ a: 'x' }, { a: 'y' }, { a: 'z' }] }), { rows: [{ a: 'x' }, { a: 'y' }] });
    assert.deepEqual(reduceBy(rules, { rows: 'x' }), {});
    assert.deepEqual(reduceBy(rules, { rows: [] }), {});
  });

  it('keeps a safe text and a real date, and drops the rest', () => {
    const rules = { t: { type: 'safeText', max: 5 }, d: { type: 'date' } } as const;
    assert.deepEqual(reduceBy(rules, { t: 'Ab 1', d: '2026-02-28' }), { t: 'Ab 1', d: '2026-02-28' });
    for (const bad of [{ t: 'a<b' }, { t: 'a&b' }, { t: 'a>b' }, { t: 'a\u0007b' }, { t: 'ab\u0100' }, { t: 'abcdefg' }, { t: '' }, { t: 5 }, { d: '2026-02-30' }, { d: '28/02/2026' }, { d: 5 }, { d: '2026-02-28T00:00:00Z' }]) {
      assert.deepEqual(reduceBy(rules, bad), {}, JSON.stringify(bad));
    }
    assert.deepEqual(reduceBy(rules, { t: "L'\u00e8=x" }), { t: "L'\u00e8=x" });
  });
});

describe('the hub and the type of the invoice', () => {
  it('has a hub only of the form aruba or aruba__<dealer>', () => {
    const dealer = new ObjectId().toHexString();
    for (const hub of ['aruba', `aruba__${dealer}`]) {
      assert.equal(hubOf({ fattura_elettronica: { hub } }), hub, hub);
    }
    for (const hub of ['', 'other', 'aruba__x', 'ARUBA', null, 5, undefined]) {
      assert.equal(hubOf({ fattura_elettronica: { hub } }), null, String(hub));
    }
    assert.equal(hubOf({}), null);
    assert.equal(hubOf({ fattura_elettronica: 'x' }), null);
  });

  it('lets the hub of the platform carry any group and the hub of a dealer only the groups of that dealer', () => {
    const dealer = new ObjectId();
    assert.deepEqual([isHubAllowed('aruba', null), isHubAllowed('aruba', dealer)], [true, true]);
    assert.deepEqual([isHubAllowed(`aruba__${dealer.toHexString()}`, dealer), isHubAllowed(`aruba__${dealer.toHexString()}`, new ObjectId()), isHubAllowed(`aruba__${dealer.toHexString()}`, null)], [true, false, false]);
  });

  it('takes the type the till asked for, else TD24 for a deferred invoice, else TD01', () => {
    assert.deepEqual([invoiceTypeOf('TD06', true), invoiceTypeOf(undefined, true), invoiceTypeOf(undefined, false)], ['TD06', 'TD24', 'TD01']);
  });
});

describe('the document of the invoice', () => {
  it('has the shape of the legacy, numeric totals, the copies given and the lines of the sale', () => {
    const base = input();
    const document = buildInvoiceDocument(base);
    assert.deepEqual(Object.keys(document), [
      '_id', 'userId', 'date', 'number', 'prefixSuffix', 'type', 'companyId', 'placeId', 'storageId', 'company', 'counterpart', 'customerType', 'note', 'adjustmentType', 'discountPercentage', 'discountValue', 'totalTaxableWithoutDiscount', 'totalTaxable',
      'totalTax', 'totalWithoutDiscount', 'total', 'totalLastPrices', 'records', 'saleId', 'saleTimestampId', 'fattura_elettronica', 'XML', 'sendStatus', 'groupId', 'insertDate', 'updateDate',
    ]);
    assert.deepEqual([document['_id'], document['number'], document['prefixSuffix'], document['type'], document['saleId'], document['saleTimestampId'], document['customerType'], document['note'], document['adjustmentType']], [base.documentId, 7, 'A', 'invoice', base.sale['_id'], 'T-1', 2, 'Note', 'discount']);
    assert.deepEqual([document['total'], document['totalTaxable'], document['totalTax'], document['totalWithoutDiscount'], document['totalTaxableWithoutDiscount'], document['totalLastPrices'], document['discountPercentage'], document['discountValue']], [21.96, 18, 3.96, 24.4, 20, 0, 10, 2]);
    assert.deepEqual(document['records'], [{ qt: 1 }]);
    assert.deepEqual([document['fattura_elettronica'], document['XML'], document['sendStatus'], document['groupId'], document['insertDate'], document['updateDate'], 'metadata' in document], [{ tipo: 'TD01', progressivo_invio: 3 }, null, 'notQueued', base.groupId, NOW, NOW, false]);
    assert.deepEqual(buildInvoiceDocument(input({ unpaidIds: ['a', 'b'], type: 'TD24' }))['metadata'], { unpaidIds: ['a', 'b'] });
    assert.equal(document['company'], base.company);
    assert.equal(document['counterpart'], base.counterpart);
  });

  it('makes totals numeric whatever the sale stored, and has no group and no progressive without a hub', () => {
    const document = buildInvoiceDocument(input({ progressive: null, groupId: null, counterpart: null, sendStatus: null, storageId: null }, { finalTotalCheckout: Number.NaN, discountPercentage: 'x', userId: undefined, customerType: undefined, savedCheckoutsNote: undefined, adjustmentType: undefined, products: undefined }));
    assert.deepEqual([document['total'], document['discountPercentage'], document['userId'], document['customerType'], document['note'], document['adjustmentType'], document['records']], [0, 0, null, null, null, null, []]);
    assert.deepEqual([document['fattura_elettronica'], 'groupId' in document, document['counterpart'], document['sendStatus'], document['storageId']], [{ tipo: 'TD01', progressivo_invio: null }, false, null, null, null]);
  });

  it('builds the record of the queue: the dealer, the document, the fields of the sale the consumer reads, and a null send state', () => {
    const base = input();
    const document: Document = { ...buildInvoiceDocument(base), sendStatus: 'notQueued' };
    const dealer = new ObjectId();
    const record = queueRecordOf(document, { ...base.sale, fullMeal: { status: 'on', quantity: 2 }, customer: { password: 'secret' } }, dealer);
    assert.deepEqual(Object.keys(record).slice(0, 2), ['_id', 'dealerId']);
    assert.deepEqual([record['_id'], record['dealerId'], record['sendStatus'], record['sale'], record['total'], record['groupId']], [document['_id'], dealer, null, { _id: base.sale['_id'], fullMeal: { status: 'on', quantity: 2 } }, 21.96, base.groupId]);
    assert.deepEqual(queueRecordOf(document, { _id: base.sale['_id'] }, null)['sale'], { _id: base.sale['_id'], fullMeal: null });
    assert.equal(queueRecordOf(document, {}, null)['dealerId'], null);
  });

  it('shows the number, the sectional and its place, the year and the send state', () => {
    const document = { _id: new ObjectId(), number: 5, prefixSuffix: 'W', company: { invoicesPS: 'suffix' }, date: new Date('2025-03-01T00:00:00Z'), sendStatus: 'queued' };
    assert.deepEqual(invoiceViewOf(document, 2026), { documentId: document._id.toHexString(), number: 5, prefixSuffix: 'W', prefixSuffixPosition: 'suffix', year: 2026, sendStatus: 'queued' });
    // A document of the legacy: no year kept (the year of its date), no sectional, no position, junk numbers.
    const legacy = invoiceViewOf({ _id: new ObjectId(), number: 'x', prefixSuffix: null, company: { invoicesPS: 'middle' }, date: new Date('2025-03-01T00:00:00Z'), sendStatus: '' }, null);
    assert.deepEqual([legacy.number, legacy.prefixSuffix, legacy.prefixSuffixPosition, legacy.year, legacy.sendStatus], [0, '', null, 2025, null]);
    assert.equal(invoiceViewOf({ _id: new ObjectId(), company: { invoicesPS: 'prefix' }, date: 'x' }, null).year, 0);
    assert.equal(invoiceViewOf({ _id: new ObjectId(), company: null }, 2024).prefixSuffixPosition, null);
  });
});
