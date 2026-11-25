import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import { decodeSalesCursor, encodeSalesCursor } from '../../src/modules/sales/sales.cursor.ts';
import { salesConditions, salesFilter, salesPerimeter } from '../../src/modules/sales/sales.filters.ts';
import { DETAIL_PROJECTION, ROW_PROJECTION, SALE_MAX_LINES, operatorIdsOf, saleDetail, saleRow } from '../../src/modules/sales/sales.mapper.ts';
import { saleParams, saleQuery, salesQuery, salesSummaryQuery } from '../../src/modules/sales/sales.schemas.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

/** A deterministic id: a kind byte and a number. */
const made = (kind: string, n: number): ObjectId => ObjectId.createFromHexString(`${kind}${n.toString(16).padStart(22, '0')}`);
const id = (n: number): ObjectId => made('0a', n);
const contact = made('0c', 1);
const product = made('0b', 1);
const query = (value: unknown) => validate(salesQuery, value, '(query)');
const summary = (value: unknown) => validate(salesSummaryQuery, value, '(query)');
const refusal = (run: () => unknown): Array<{ field: string; issue: string }> => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    return error.details as Array<{ field: string; issue: string }>;
  }
  throw new assert.AssertionError({ message: 'it did not refuse' });
};

describe('the cursor of the sales table', () => {
  it('carries the date and the id of the last sale and nothing else', () => {
    const cursor = encodeSalesCursor({ date: new Date('2026-05-01T10:00:00.000Z'), id: id(1) });
    assert.deepEqual(JSON.parse(Buffer.from(cursor, 'base64url').toString()), { ver: 1, d: Date.parse('2026-05-01T10:00:00.000Z'), i: id(1).toHexString() });
    const back = decodeSalesCursor(cursor);
    assert.deepEqual([back.date.toISOString(), back.id.toHexString()], ['2026-05-01T10:00:00.000Z', id(1).toHexString()]);
  });

  it('refuses everything this server did not issue', () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const good = { ver: 1, d: 1000, i: id(1).toHexString() };
    for (const raw of ['', 'a b', '!!', 'bm90IGpzb24', encode([]), encode(null), encode(5), encode({ ...good, ver: 2 }), encode({ ...good, x: 1 }), encode({ ver: 1, d: 1000 }), encode({ ...good, d: '1000' }), encode({ ...good, d: 1.5 }), encode({ ...good, d: 9e15 }), encode({ ...good, d: 9007199254740991 }), encode({ ...good, i: 'zz' }), encode({ ...good, i: id(1).toHexString().toUpperCase() }), encode({ ...good, i: 5 })]) {
      assert.throws(() => decodeSalesCursor(raw), (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR' && JSON.stringify(error.details) === '[{"field":"cursor","issue":"format"}]', raw);
    }
  });
});

describe('the query of the sales', () => {
  it('accepts a customer alone, a bounded period alone, and both, with the types converted', () => {
    assert.deepEqual(query({ contactId: contact.toHexString() }), { contactId: contact });
    const period = query({ from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00Z', limit: '100', receiptType: 'invoice', fiscalState: 'none', unpaid: 'true', invoiced: 'true', nonFiscal: 'include', companyId: id(2).toHexString(), placeId: id(3).toHexString(), cursor: 'abc' });
    assert.deepEqual([period.limit, period.receiptType, period.fiscalState, period.unpaid, period.invoiced, period.nonFiscal, period.from instanceof Date, period.cursor], [100, 'invoice', 'none', 'true', 'true', 'include', true, 'abc']);
    assert.deepEqual(Object.keys(summary({ contactId: contact.toHexString(), from: '2020-01-01' })), ['contactId', 'from']);
  });

  it('requires a customer or a whole period: the collection is never read without a bound', () => {
    assert.deepEqual(refusal(() => query({})), [{ field: 'from', issue: 'required' }, { field: 'to', issue: 'required' }]);
    assert.deepEqual(refusal(() => query({ limit: '5' })), [{ field: 'from', issue: 'required' }, { field: 'to', issue: 'required' }]);
    assert.deepEqual(refusal(() => query({ from: '2026-01-01' })), [{ field: 'to', issue: 'required' }]);
    assert.deepEqual(refusal(() => query({ to: '2026-01-01' })), [{ field: 'from', issue: 'required' }]);
    assert.deepEqual(refusal(() => summary({ placeId: id(3).toHexString() })), [{ field: 'from', issue: 'required' }, { field: 'to', issue: 'required' }]);
  });

  it('keeps the period ordered, and at most one year without a customer (a customer may have a longer one)', () => {
    assert.deepEqual(refusal(() => query({ from: '2026-05-01', to: '2026-05-01' })), [{ field: 'to', issue: 'incorrect' }]);
    assert.deepEqual(refusal(() => query({ contactId: contact.toHexString(), from: '2026-05-02', to: '2026-05-01' })), [{ field: 'to', issue: 'incorrect' }]);
    assert.deepEqual(refusal(() => query({ from: '2025-05-01', to: '2026-05-01T00:00:01Z' })), [{ field: 'to', issue: 'maximum' }]);
    assert.deepEqual(refusal(() => summary({ from: '2020-01-01', to: '2026-01-01' })), [{ field: 'to', issue: 'maximum' }]);
    assert.equal(query({ from: '2025-05-01', to: '2026-05-01' }).to!.toISOString(), '2026-05-01T00:00:00.000Z');
    assert.equal(query({ contactId: contact.toHexString(), from: '2010-01-01', to: '2026-05-01' }).from!.getFullYear(), 2010);
    // A leap day: a year from 29 February is 1 March of the next year at most.
    assert.equal(query({ from: '2024-02-29', to: '2025-03-01' }).limit, undefined);
  });

  it('refuses unknown parameters, operators, repeated values, bad values and bad limits', () => {
    const base = { contactId: contact.toHexString() };
    assert.deepEqual(refusal(() => query({ ...base, other: '1' })), [{ field: 'other', issue: 'unknown' }]);
    assert.deepEqual(refusal(() => query({ ...base, 'contactId[$ne]': 'x' })), [{ field: '(key)', issue: 'unknown' }]);
    assert.deepEqual(refusal(() => query({ contactId: { $ne: 'x' } })).map((entry) => entry.field), ['contactId']);
    for (const bad of [{ contactId: 'nope' }, { contactId: [contact.toHexString()] }, { ...base, receiptType: 'partitioned' }, { ...base, fiscalState: 'x' }, { ...base, unpaid: 'false' }, { ...base, invoiced: '1' }, { ...base, nonFiscal: 'yes' }, { ...base, limit: '0' }, { ...base, limit: '101' }, { ...base, limit: '-1' }, { ...base, from: 'yesterday' }, { ...base, to: '2026-13-01' }]) {
      assert.ok(refusal(() => query(bad)).length > 0, JSON.stringify(bad));
    }
    assert.deepEqual(refusal(() => summary({ ...base, limit: '5' })), [{ field: 'limit', issue: 'unknown' }]);
    assert.deepEqual(refusal(() => summary({ ...base, cursor: 'x' })), [{ field: 'cursor', issue: 'unknown' }]);
    assert.deepEqual(validate(saleQuery, { nonFiscal: 'include' }, '(query)'), { nonFiscal: 'include' });
    assert.ok(refusal(() => validate(saleQuery, { nonFiscal: 'x' }, '(query)')).length > 0);
    assert.ok(refusal(() => validate(saleQuery, { other: '1' }, '(query)')).length > 0);
    assert.deepEqual(validate(saleParams, { groupId: 'g', saleId: id(1).toHexString() }, '(params)'), { saleId: id(1) });
    assert.ok(refusal(() => validate(saleParams, { saleId: 'x' }, '(params)')).length > 0);
  });
});

describe('the filter of the sales', () => {
  const group = fixtureId('group', 1);
  const either = (value: ObjectId) => ({ $in: [value, value.toHexString()] });

  it('gives the whole group to the platform, a dealer and a group administrator, the own companies to a CA and the own places to a PA, and nothing to anybody else', () => {
    for (const scope of [{ kind: 'platform' }, { kind: 'dealer', groupIds: new Set([group.toHexString()]) }, { kind: 'group', groupId: group }] as const) {
      assert.deepEqual(salesPerimeter(scope), {});
    }
    const company = fixtureId('company', 1);
    const place = fixtureId('place', 1);
    assert.deepEqual(salesPerimeter({ kind: 'companies', groupId: group, companyIds: [company], placeIds: [place] }), { companyId: { $in: [company, company.toHexString()] } });
    assert.deepEqual(salesPerimeter({ kind: 'places', groupId: group, placeIds: [place, fixtureId('place', 2)] }), { placeId: { $in: [place, place.toHexString(), fixtureId('place', 2), fixtureId('place', 2).toHexString()] } });
    for (const scope of [{ kind: 'none' }, { kind: 'store', groupId: group, companyId: company, placeId: place }] as const) {
      assert.deepEqual(salesPerimeter(scope), { _id: { $in: [] } });
    }
  });

  it('leaves out the non fiscal sales and the split tables unless a filter says otherwise, and always requires a date', () => {
    assert.deepEqual(salesConditions({ contactId: undefined } as never), [{ date: { $type: 'date' } }, { receiptType: { $ne: 'partitioned' } }, { sType: { $in: [false, null] } }]);
    const all = salesConditions({ contactId: contact, companyId: id(2), placeId: id(3), from: new Date(0), to: new Date(10), receiptType: 'charge', fiscalState: 'none', unpaid: 'true', invoiced: 'true', nonFiscal: 'include' });
    assert.deepEqual(all, [
      { date: { $type: 'date', $gte: new Date(0), $lt: new Date(10) } },
      { receiptType: 'charge' },
      { 'customer._id': either(contact) },
      { companyId: either(id(2)) },
      { placeId: either(id(3)) },
      { fiscalState: { $nin: ['canceled', 'refunded'] } },
      { unpaid: { $gt: 0 } },
      { status: 'invoiced' },
    ]);
    assert.deepEqual(salesConditions({ fiscalState: 'canceled', nonFiscal: 'exclude' } as never).slice(2), [{ fiscalState: 'canceled' }, { sType: { $in: [false, null] } }]);
  });

  it('puts the perimeter first and the position after the cursor last', () => {
    const scope = { kind: 'group', groupId: group } as const;
    assert.deepEqual(salesFilter(scope, { contactId: contact } as never), { $and: [{}, { date: { $type: 'date' } }, { receiptType: { $ne: 'partitioned' } }, { 'customer._id': either(contact) }, { sType: { $in: [false, null] } }] });
    const after = { date: new Date(5), id: id(9) };
    const filter = salesFilter(scope, { contactId: contact } as never, after);
    assert.deepEqual((filter['$and'] as Document[]).at(-1), { $or: [{ date: { $lt: new Date(5) } }, { date: new Date(5), _id: { $lt: id(9) } }] });
  });
});

describe('the representation of a sale', () => {
  const names = new Map([[id(50).toHexString(), 'Mario Rossi']]);

  it('shows every field of a complete sale and nothing else', () => {
    const document: Document = {
      _id: id(1),
      date: new Date('2026-05-01T10:00:00.000Z'),
      receiptType: 'invoice',
      sType: true,
      fiscalReceiptInfo: { reportNumber: 12, number: '34', date: new Date('2026-05-01T10:01:00.000Z'), amount: 12.5 },
      fiscalState: 'refunded',
      refund: [{ fiscalReceiptInfo: { reportNumber: 13, number: 2, date: new Date('2026-05-02T10:00:00.000Z') }, returnedGoodsValue: { priceTaxed: 2.5 } }, { returnedGoodsValue: {} }, 'junk', null],
      unpaid: 3,
      status: 'invoiced',
      finalTotalCheckout: 12.5,
      companyId: fixtureId('company', 1),
      placeId: fixtureId('place', 1).toHexString().toUpperCase(),
      device: { settings: { name: ' Cassa 1 ' } },
      userId: id(50),
      table: { originalTable: { name: 'T5' } },
      customer: { _id: contact, companyName: 'Acme Srl', name: 'Mario', surname: 'Rossi', email: ['secret@example.test'], address: 'Via Segreta' },
      lotteryId: 'LOTTERY-SECRET',
      delivery: { address: 'Via Segreta' },
      posTerminalId: 'TERMINAL-SECRET',
      paymentType: 'legacy',
    };
    const row = saleRow(document, names);
    assert.deepEqual(row, {
      id: id(1).toHexString(),
      date: '2026-05-01T10:00:00.000Z',
      receiptType: 'invoice',
      nonFiscal: true,
      number: { report: 12, number: 34 },
      fiscalState: 'refunded',
      refunds: [{ report: 13, number: 2 }, { report: null, number: null }],
      unpaid: 3,
      invoiced: true,
      total: 12.5,
      companyId: fixtureId('company', 1).toHexString(),
      placeId: fixtureId('place', 1).toHexString(),
      cashDesk: 'Cassa 1',
      operator: { id: id(50).toHexString(), name: 'Mario Rossi' },
      table: 'T5',
      customer: { id: contact.toHexString(), displayName: 'Acme Srl' },
    });
    assert.ok(!JSON.stringify(row).includes('SECRET') && !JSON.stringify(row).includes('secret'));
  });

  it('reads a broken sale as nulls, zeros and empty lists, never as a failure', () => {
    const empty = { id: id(2).toHexString(), date: null, receiptType: null, nonFiscal: false, number: null, fiscalState: null, refunds: [], unpaid: 0, invoiced: false, total: 0, companyId: null, placeId: null, cashDesk: null, operator: null, table: null, customer: null };
    assert.deepEqual(saleRow({ _id: id(2) }, names), empty);
    assert.deepEqual(
      saleRow({ _id: id(2), date: 'yesterday', receiptType: 'partitioned', sType: false, fiscalReceiptInfo: 'x', fiscalState: 'weird', refund: 'x', unpaid: NaN, status: 5, finalTotalCheckout: '12', companyId: 5, placeId: 'abc', device: 'x', userId: 'x', table: { originalTable: 5 }, customer: 'x' }, names),
      empty,
    );
    // Numbers of a receipt: a report alone, a number alone, text of digits, nothing usable.
    assert.deepEqual(saleRow({ _id: id(2), fiscalReceiptInfo: { reportNumber: 7 } }, names).number, { report: 7, number: null });
    assert.deepEqual(saleRow({ _id: id(2), fiscalReceiptInfo: { number: '8' } }, names).number, { report: null, number: 8 });
    assert.equal(saleRow({ _id: id(2), fiscalReceiptInfo: { reportNumber: 'x', number: 1.5 } }, names).number, null);
    assert.equal(saleRow({ _id: id(2), fiscalReceiptInfo: { reportNumber: Infinity } }, names).number, null);
    // An operator that is not among the names, a customer without an id, an invalid date.
    assert.equal(saleRow({ _id: id(2), userId: id(51) }, names).operator, null);
    assert.equal(saleRow({ _id: id(2), customer: { name: 'No Id' } }, names).customer, null);
    assert.equal(saleRow({ _id: id(2), date: new Date(NaN) }, names).date, null);
  });

  it('takes a sale for non fiscal unless its flag is explicitly false, null or missing', () => {
    for (const [sType, expected] of [[true, true], ['true', true], [1, true], ['S', true], [0, true], ['', true], [false, false], [null, false], [undefined, false]] as const) {
      assert.equal(saleRow({ _id: id(2), sType }, names).nonFiscal, expected, String(sType));
    }
  });

  it('shows the code of the loyalty card only to who may read the fidelity, and always whether a card was used', () => {
    const document = { _id: id(1), fidelityCard: { code: ' CARD-1 ' } };
    assert.deepEqual([saleDetail(document, names, null, true).fidelityCardCode, saleDetail(document, names, null, true).fidelityCardUsed], ['CARD-1', true]);
    assert.deepEqual([saleDetail(document, names, null, false).fidelityCardCode, saleDetail(document, names, null, false).fidelityCardUsed], [null, true]);
    assert.deepEqual([saleDetail({ _id: id(1), fidelityCard: {} }, names, null, true).fidelityCardUsed, saleDetail({ _id: id(1) }, names, null, false).fidelityCardCode], [false, null]);
  });

  it('names the customer by the company, else the person, in clear only', () => {
    const named = (customer: Document) => saleRow({ _id: id(2), customer: { _id: contact.toHexString(), ...customer } }, names).customer;
    assert.deepEqual(named({ name: 'Anna', surname: 'Bianchi' }), { id: contact.toHexString(), displayName: 'Anna Bianchi' });
    assert.deepEqual(named({ name: 'Anna' }), { id: contact.toHexString(), displayName: 'Anna' });
    const encrypted = `${'ab'.repeat(16)}$${'cd'.repeat(16)}`;
    assert.deepEqual(named({ companyName: encrypted, name: encrypted, surname: 5 }), { id: contact.toHexString(), displayName: null });
    assert.deepEqual(named({}), { id: contact.toHexString(), displayName: null });
  });

  it('lists the operators of a page once each', () => {
    const user = fixtureId('user', 1);
    assert.deepEqual(operatorIdsOf([{ userId: user }, { userId: user }, { userId: 'x' }, {}, { userId: fixtureId('user', 2) }]).map((value) => value.toHexString()), [user.toHexString(), fixtureId('user', 2).toHexString()]);
    assert.deepEqual(operatorIdsOf([]), []);
  });

  it('shows the detail with the lines, the totals, the payments and the refunds, and only the lines and totals it reads', () => {
    const document: Document = {
      _id: id(1),
      date: new Date('2026-05-01T10:00:00.000Z'),
      receiptType: 'receipt',
      finalTotalCheckout: 20,
      finalTotalTaxable: 16.39,
      finalTotalTax: 3.61,
      adjustmentType: 'surcharge',
      discountPercentage: 5,
      discountValue: NaN,
      cashAmount: 5,
      electronicAmount: 10,
      chequeAmount: 1,
      ticketsAmount: 2,
      paymentDiscountAmount: 2.5,
      unpaid: 0.5,
      fiscalReceiptInfo: { date: new Date('2026-05-01T10:01:00.000Z'), reportNumber: 1, number: 2, amount: 20 },
      refund: [{ fiscalReceiptInfo: { reportNumber: 3, number: 4, date: new Date('2026-05-03T00:00:00.000Z') }, returnedGoodsValue: { priceTaxed: 4 } }, { returnedGoodsValue: { priceTaxed: 'x' } }],
      fidelityCard: { code: ' CARD-1 ' },
      savedCheckoutsNote: ' una nota ',
      products: [
        {
          _id: product,
          code: 'P1',
          name: { en: 'Pizza', it: 'Pizza it' },
          qt: 2,
          price: { taxed: 8, discount: 10 },
          selectedVariants: { plus: [{ name: { it: 'Extra' }, qt: 2 }], minus: [{ name: { it: 'Cipolla' } }, { name: 5 }], info: [{ name: { fr: 'Bien cuit' }, qt: 1 }], other: 1 },
        },
        { name: 'broken', qt: 'x', price: 5, selectedVariants: 'x' },
        'junk',
      ],
    };
    const detail = saleDetail(document, names, 'it', true);
    assert.deepEqual(detail.products, [
      { productId: product.toHexString(), code: 'P1', name: 'Pizza it', quantity: 2, unitPrice: 8, discount: 10, variants: '+ Extra x2, - Cipolla, Bien cuit' },
      { productId: null, code: null, name: null, quantity: 0, unitPrice: 0, discount: 0, variants: null },
      { productId: null, code: null, name: null, quantity: 0, unitPrice: 0, discount: 0, variants: null },
    ]);
    assert.equal(detail.productsCount, 3);
    assert.deepEqual(detail.totals, { total: 20, taxable: 16.39, tax: 3.61, discount: { adjustment: 'surcharge', percentage: 5, value: 0 } });
    assert.deepEqual(detail.payments, { cash: 5, electronic: 10, cheque: 1, tickets: 2, fidelityCredit: 2.5, unpaid: 0.5 });
    assert.deepEqual(detail.fiscalReceiptInfo, { date: '2026-05-01T10:01:00.000Z', report: 1, number: 2, amount: 20 });
    assert.deepEqual(detail.refunds, [{ report: 3, number: 4, date: '2026-05-03T00:00:00.000Z', amount: 4 }, { report: null, number: null, date: null, amount: 0 }]);
    assert.deepEqual([detail.fidelityCardCode, detail.note, detail.receiptType, detail.total], ['CARD-1', 'una nota', 'receipt', 20]);
    // The name of a product: the language asked, else the first one, a language that is not a key of the name is not read.
    assert.equal(saleDetail(document, names, 'en', true).products[0]!.name, 'Pizza');
    assert.equal(saleDetail(document, names, 'de', true).products[0]!.name, 'Pizza');
    assert.equal(saleDetail(document, names, null, true).products[0]!.name, 'Pizza');
    assert.equal(saleDetail({ _id: id(1), products: [{ name: { toString: 'x', it: 5 } }] }, names, 'toString', true).products[0]!.name, 'x');
    assert.equal(saleDetail({ _id: id(1), products: [{ name: { it: 5, en: '  ' } }] }, names, 'it', true).products[0]!.name, null);
  });

  it('shows an empty detail for a broken sale and cuts the lines', () => {
    const detail = saleDetail({ _id: id(3), fiscalReceiptInfo: 5, refund: {}, fidelityCard: 'x', adjustmentType: 'other' }, names, 'it', true);
    assert.deepEqual([detail.products, detail.productsCount, detail.refunds, detail.fiscalReceiptInfo, detail.fidelityCardCode, detail.note, detail.totals.discount], [[], 0, [], null, null, null, { adjustment: null, percentage: 0, value: 0 }]);
    const many = saleDetail({ _id: id(3), products: Array.from({ length: SALE_MAX_LINES + 20 }, () => ({ name: { it: 'x' }, qt: 1 })) }, names, 'it', true);
    assert.deepEqual([many.products.length, many.productsCount], [SALE_MAX_LINES, SALE_MAX_LINES + 20]);
    // A fiscal receipt of the sale with only a date.
    assert.deepEqual(saleDetail({ _id: id(3), fiscalReceiptInfo: { date: new Date('2026-01-01T00:00:00Z') } }, names, null, true).fiscalReceiptInfo, { date: '2026-01-01T00:00:00.000Z', report: null, number: null, amount: null });
  });

  it('reads fixed lists of fields: no customer data beyond the name, no lottery, delivery, terminal or removed shapes', () => {
    const fields = [...Object.keys(ROW_PROJECTION), ...Object.keys(DETAIL_PROJECTION)];
    for (const forbidden of ['lotteryId', 'delivery', 'posTerminalId', 'reservation', 'hotel', 'XML', 'paymentType', 'cashAmountValue', 'returnedGoods', 'customer.email', 'customer.address', 'customer.account', 'customer.fidelities', 'tickets']) {
      assert.ok(!fields.some((field) => field === forbidden || field.startsWith(`${forbidden}.`)), forbidden);
    }
    assert.ok(Object.keys(DETAIL_PROJECTION).length > Object.keys(ROW_PROJECTION).length);
    assert.ok(Object.values({ ...ROW_PROJECTION, ...DETAIL_PROJECTION }).every((value) => value === 1));
  });
});
