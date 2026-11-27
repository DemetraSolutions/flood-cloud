import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { validate } from '../../src/shared/validation/schema.ts';
import { CHECK_MAX_LINES, serverCheckOf } from '../../src/modules/sales/sales.check.ts';
import {
  amountOf,
  bodyHashOf,
  buildSale,
  cancellationEntryOf,
  cardCodeOf,
  currencyOf,
  customerOf,
  fiscalInfoOf,
  lineIssuesOf,
  listOf,
  loyaltyFactsOf,
  numberOrNull,
  objectIdOrNull,
  paymentFields,
  recordOf,
  refillReturnedOf,
  refundEntryOf,
  refundLineProblems,
  refundedRatioOf,
  returnedByLine,
  versionOf,
} from '../../src/modules/sales/sales.document.ts';
import { idOfText, productIdsOf, reduceBy, reduceLine, stockEntriesOf } from '../../src/modules/sales/sales.lines.ts';
import type { CatalogProduct } from '../../src/modules/sales/sales.lines.ts';
import { storeSaleView } from '../../src/modules/sales/sales.store-view.ts';
import { createSalesWriteRepository } from '../../src/modules/sales/sales.write.repository.ts';
import { cancelSaleBody, createSaleBody, looseProduct, patchSaleBody, refundSaleBody, storeSalesQuery } from '../../src/modules/sales/sales.write.schemas.ts';

const id = (): ObjectId => new ObjectId();
const NOW = new Date('2026-11-27T12:00:00Z');

/** A product of the catalog for the lines. */
function catalogProduct(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return { _id: id(), code: 'P', name: { it: 'P' }, type: 'product', categories: ['c'], departmentId: undefined, trash: false, warehouse: true, bundleProducts: [], simpleCost: undefined, averagePrice: undefined, percentageFee: undefined, ...overrides };
}

describe('the allowlist of the lines', () => {
  it('keeps of a value only the fields of the table, by type', () => {
    assert.deepEqual(reduceBy({}, 'text'), {});
    assert.deepEqual(reduceBy({ a: { type: 'text', max: 3 }, b: { type: 'number', max: 10 }, c: { type: 'boolean' }, d: { type: 'scalar' }, e: { type: 'localized' }, f: { type: 'object', fields: { g: { type: 'number', max: 10 } } } }, { a: 'abcdef', b: 1, c: true, d: 'x', e: { it: 'Pizza' }, f: { g: 2, h: 3 }, z: 1 }), { a: 'abc', b: 1, c: true, d: 'x', e: { it: 'Pizza' }, f: { g: 2 } });
    const wrong = { a: 1, b: '1', c: 'x', d: {}, e: { 'not a language!': 'x', it: 5 }, f: { g: 'x' } };
    assert.deepEqual(reduceBy({ a: { type: 'text', max: 3 }, b: { type: 'number', max: 10 }, c: { type: 'boolean' }, d: { type: 'scalar' }, e: { type: 'localized' }, f: { type: 'object', fields: { g: { type: 'number', max: 10 } } } }, wrong), {});
    assert.deepEqual(reduceBy({ d: { type: 'scalar' } }, { d: 7 }), { d: 7 });
    assert.deepEqual(reduceBy({ d: { type: 'scalar' } }, { d: 'x'.repeat(101) }), {});
    assert.deepEqual(reduceBy({ e: { type: 'localized' } }, { e: ['x'] }), {});
    assert.equal(idOfText('x'), null);
    assert.equal(idOfText(5), null);
    assert.ok(idOfText('6'.repeat(24)) instanceof ObjectId);
  });

  it('lists the ids of the catalog a body names, of lines, modifiers and menus, whatever the shape', () => {
    const a = id();
    const b = id();
    const c = id();
    const found = productIdsOf([
      { _id: a.toHexString(), selectedVariants: { plus: [{ _id: b.toHexString() }, 'x', { name: 1 }], minus: 'no', info: [{ _id: b.toHexString() }] }, modularBundleSelected: { products: [{ _id: c.toHexString() }, 7] } },
      { selectedVariants: 'no', modularBundleSelected: { products: 'no' } },
      { modularBundleSelected: 'no' },
      { _id: 'bad' },
    ]);
    assert.deepEqual(found.map((item) => item.toHexString()).sort(), [a, b, c].map((item) => item.toHexString()).sort());
  });

  it('reduces a line to the catalog and the allowlist, and tells what was found wrong', () => {
    const product = catalogProduct({ departmentId: 'd', categories: undefined, simpleCost: 2, averagePrice: 3, percentageFee: 4, bundleProducts: [{ _id: id(), quantity: 2, waste: 'x' }, { _id: id(), quantity: 1, waste: 5 }] });
    const catalog = new Map([[product._id.toHexString(), product]]);
    const full = reduceLine({ _id: product._id.toHexString(), qt: 1, price: { price: 1, taxed: 1.22 }, availability: { scales: false }, selectedVariants: { plus: [{ _id: product._id.toHexString(), qt: 2 }], minus: [{ qt: 1, code: 'MINUS', name: { it: 'Senza' } }, 5, { _id: id().toHexString(), qt: 2, code: 'G' }], info: 'no' }, modularBundleSelected: { products: [{ _id: product._id.toHexString(), qt: 3 }, { qt: 1 }] } }, catalog);
    assert.deepEqual(full.issues, []);
    assert.deepEqual([full.line['categories'], full.line['departmentId'], full.line['simpleCost'], full.line['lastAveragePrice'], full.line['roomsSettings'], full.line['availability'], full.line['bundleProducts'].map((component: Document) => component['waste'])], [[], 'd', 2, { total: { averagePrice: 3 } }, { percentageFee: 4 }, { warehouse: true }, [0, 5]]);
    assert.deepEqual(full.line['selectedVariants'].minus.map((entry: Document) => [entry['code'], entry['_id'] instanceof ObjectId]), [['MINUS', false], ['G', true]]);
    assert.deepEqual(full.line['selectedVariants'].info, []);
    assert.equal(full.line['modularBundleSelected'].products.length, 1);
    // A product the catalog has not, a trashed one, a free product (no id, or marked) and a line without quantity.
    const ghost = id().toHexString();
    assert.deepEqual(reduceLine({ _id: ghost, qt: 1, price: { price: 1, taxed: 1.22 }, code: 'X'.repeat(80), name: { it: 'Ghost' } }, catalog), { line: { _id: new ObjectId(ghost), freeProduct: false, name: { it: 'Ghost' }, code: 'X'.repeat(64), qt: 1, price: { price: 1, taxed: 1.22 } }, issues: ['productMissing'] });
    const trashed = catalogProduct({ trash: true });
    assert.deepEqual(reduceLine({ _id: trashed._id.toHexString(), qt: 1, price: { price: 1, taxed: 1.22 }, }, new Map([[trashed._id.toHexString(), trashed]])).issues, ['productTrashed']);
    assert.deepEqual(reduceLine({ name: { it: 'Varie' }, qt: 1, price: { price: 1, taxed: 1.22 }, departmentId: 'd' }, catalog), { line: { _id: null, freeProduct: true, name: { it: 'Varie' }, departmentId: 'd', qt: 1, price: { price: 1, taxed: 1.22 } }, issues: [] });
    const marked = reduceLine({ _id: product._id.toHexString(), freeProduct: true, qt: 1, price: { price: 1, taxed: 1.22 }, }, catalog);
    assert.deepEqual([marked.line['freeProduct'], marked.line['_id']], [true, product._id]);
    assert.deepEqual(reduceLine({ _id: product._id.toHexString() }, catalog).issues, ['quantityMissing', 'priceMissing']);
    assert.equal(reduceLine({ _id: product._id.toHexString(), qt: 'x' }, catalog).line['qt'], 0);
  });

  it('works out the lines to unload and to load, net of what was returned', () => {
    const a = id();
    const b = id();
    const c = id();
    const lines: Document[] = [
      { _id: a, qt: 4, barcodeRead: 'BOX', modularBundleSelected: { products: [{ _id: b, qt: 2 }, { _id: 'x', qt: 1 }, { _id: b, qt: 0 }] }, selectedVariants: { plus: [{ _id: c, qt: 2 }, { qt: 1 }, { _id: c, qt: 0 }] } },
      { _id: null, qt: 1, freeProduct: true },
      { _id: b, qt: 0 },
      { _id: b, qt: -2, barcodeRead: '', selectedVariants: { plus: [{ _id: c, qt: 1 }] } },
      { _id: c, qt: 1 },
      { _id: 'nope', qt: 1 },
      { qt: 'x' },
    ];
    const { unload, load } = stockEntriesOf(lines, [1, 0, 0, 0, 5]);
    assert.deepEqual(unload, [
      { productId: a.toHexString(), quantity: 3, unit: 'sale', barcode: 'BOX', modularSelections: [{ productId: b.toHexString(), quantity: 1.5 }] },
      { productId: c.toHexString(), quantity: 6, unit: 'sale' },
    ]);
    assert.deepEqual(load, [{ productId: b.toHexString(), quantity: 2, unit: 'sale' }, { productId: c.toHexString(), quantity: 2, unit: 'sale' }]);
    assert.deepEqual(stockEntriesOf([{ _id: a, qt: 1 }]), { unload: [{ productId: a.toHexString(), quantity: 1, unit: 'sale' }], load: [] });
  });
});

describe('the recomputation of the arithmetic', () => {
  const line = (overrides: Document = {}): Document => ({ qt: 2, price: { price: 10, taxed: 12.2, discount: 0, tax: 22, taxData: { value: 22 } }, ...overrides });
  const sale = (overrides: Document = {}): Document => ({ products: [line()], finalTotalCheckout: 24.4, finalTotalTaxable: 20, finalTotalTax: 4.4, cashAmount: 24.4, ...overrides });

  it('finds nothing wrong in a sale that adds up and lists every difference of one that does not', () => {
    assert.deepEqual(serverCheckOf(sale(), [[]], NOW), { checkedAt: NOW, status: 'ok', totals: [], lines: [], linesTruncated: false });
    const wrong = serverCheckOf(
      sale({ products: [line({ price: { price: 10, taxed: 13, discount: 10, tax: 22, taxData: { value: 10 } } }), line({ qt: 'x', price: {} }), { price: 'x' }], finalTotalCheckoutWithoutDiscount: 99, discountValue: 3, adjustmentType: 'surcharge', cashAmount: 1, finalTotalCheckout: 40 }),
      [['productMissing'], [], []],
      NOW,
    );
    assert.equal(wrong.status, 'differences');
    assert.deepEqual(wrong.lines.map((entry) => `${String(entry.index)}:${entry.code}`), ['0:productMissing', '0:taxRateDiffers', '0:lineTotalMismatch', '1:taxMissing', '2:taxMissing']);
    assert.deepEqual(wrong.totals.map((total) => total.field), ['totalBeforeDiscount', 'total', 'taxable', 'tax', 'payments']);
    const discounted = serverCheckOf(sale({ discountValue: 4.4, adjustmentType: 'discount', finalTotalCheckout: 20, finalTotalTaxable: 16.39, finalTotalTax: 3.61, cashAmount: 20 }), [[]], NOW);
    assert.equal(discounted.status, 'ok');
    assert.equal(serverCheckOf({}, [], NOW).status, 'ok');
    assert.equal(serverCheckOf(sale({ products: [], finalTotalCheckout: 0, finalTotalTaxable: 0, finalTotalTax: 0, cashAmount: 0 }), [], NOW).status, 'ok');
    const many = serverCheckOf(sale({ products: Array.from({ length: 120 }, () => line({ price: { price: 1, taxed: 5, tax: 22 } })) }), [], NOW);
    assert.deepEqual([many.lines.length, many.linesTruncated, CHECK_MAX_LINES], [100, true, 100]);
  });
});

describe('the document of a sale', () => {
  it('reads a stored value tolerantly', () => {
    assert.deepEqual([listOf([{ a: 1 }, 5, null, [1]]), listOf('x'), recordOf({ a: 1 }), recordOf([1]), recordOf(null), recordOf(id()), recordOf(NOW), recordOf('x')], [[{ a: 1 }], [], { a: 1 }, {}, {}, {}, {}, {}]);
    assert.deepEqual([amountOf(1.5), amountOf(Number.NaN), amountOf('1'), numberOrNull(2), numberOrNull(Number.POSITIVE_INFINITY), objectIdOrNull('x'), objectIdOrNull(id()) instanceof ObjectId], [1.5, 0, 0, 2, null, null, true]);
    assert.deepEqual([lineIssuesOf(undefined, 2), lineIssuesOf({ lines: [{ index: 0, code: 'productMissing' }, { index: 1, code: 'taxMissing' }, { index: 9, code: 'productTrashed' }, { index: 1, code: 'quantityMissing' }] }, 2)], [[[], []], [['productMissing'], ['quantityMissing']]]);
  });

  it('keeps the same hash for the same body whatever the order of its keys, and a version that changes with every write', () => {
    const same = id().toHexString();
    assert.equal(bodyHashOf({ a: 1, b: same }), bodyHashOf({ b: same, a: 1 }));
    assert.notEqual(bodyHashOf({ a: 1 }), bodyHashOf({ a: 2 }));
    const _id = id();
    const base = { _id, updateDate: null, refund: [], fiscalState: '' };
    const versions = [base, { ...base, updateDate: NOW }, { ...base, refund: [{}] }, { ...base, fiscalState: 'canceled' }, { ...base, floodCloud: { operations: [{}] } }, { _id }].map(versionOf);
    assert.equal(new Set(versions.slice(0, 5)).size, 5);
    assert.equal(versions[5], versions[0]);
    assert.match(versions[0]!, /^[A-Za-z0-9_-]{43}$/);
  });

  it('builds the fiscal receipt, the customer and the payments', () => {
    assert.deepEqual([fiscalInfoOf(null), fiscalInfoOf(undefined), fiscalInfoOf({ date: NOW, report: 3, number: 4, amount: 5 }), fiscalInfoOf({})], [{ date: null, number: null, amount: null, reportNumber: null }, { date: null, number: null, amount: null, reportNumber: null }, { date: NOW, number: 4, amount: 5, reportNumber: 3 }, { date: null, number: null, amount: null, reportNumber: null }]);
    assert.deepEqual([customerOf(null), customerOf({ copy: { companyName: ' Rossi ' } }).customerType, customerOf({ copy: { companyName: '  ' } }).customerType, customerOf({ copy: {} }).customerType, customerOf({ copy: { name: 'M' } }).customer], [{ customer: null, customerType: null }, 2, 1, 1, { name: 'M' }]);
    assert.deepEqual(paymentFields({}), {});
    assert.deepEqual(paymentFields({ tickets: 0 }), { ticketsAmount: 0, tickets: [] });
    assert.deepEqual(paymentFields({ tickets: 5, ticketDetails: [{ name: 'Buono', amount: 5, quantity: 1 }, {}] }), { ticketsAmount: 5, tickets: [{ name: 'Buono', amount: 5, quantity: 1 }, { name: null, amount: 0, quantity: 1 }] });
    assert.deepEqual(paymentFields({ cash: 1, electronic: 2, cheque: 3, fidelityCredit: 4, unpaid: 5, paymentTypeId: 'pt', posTerminalId: null, specific: [{ type: 't', name: 'n', amount: 1 }, {}], ticketDetails: [], tickets: 1 }), { cashAmount: 1, electronicAmount: 2, chequeAmount: 3, ticketsAmount: 1, paymentDiscountAmount: 4, unpaid: 5, paymentTypeId: 'pt', posTerminalId: null, specificPayments: [{ type: 't', name: 'n', amount: 1 }, { type: null, name: null, amount: 0 }], tickets: [] });
  });

  it('reads the facts of a stored sale tolerantly', () => {
    const place = id();
    assert.deepEqual(loyaltyFactsOf({ placeId: place.toHexString(), date: NOW, finalTotalCheckout: 5, paymentDiscountAmount: 'x', products: [{ code: 'A', freeProduct: false, categories: [], qt: 2, price: { taxed: 3 } }, { qt: 'x' }] }), { placeId: place, date: NOW, finalTotalCheckout: 5, creditUsed: 0, lines: [{ code: 'A', taxedPrice: 3, quantity: 2 }, { code: '', taxedPrice: 0, quantity: 0 }] });
    assert.equal(loyaltyFactsOf({ placeId: place, date: NOW }).placeId, place);
    // The code of a line that is not a product of the catalog counts only as stored (the adoption of a sale of the legacy).
    const free = { placeId: place, date: NOW, products: [{ code: '000-r-multi-1', freeProduct: true, qt: 1, price: { taxed: 5 } }, { code: '000-r-mono-1', freeProduct: false, qt: 1, price: { taxed: 5 } }] };
    assert.deepEqual([loyaltyFactsOf(free).lines.map((line) => line.code), loyaltyFactsOf(free, true).lines.map((line) => line.code)], [['', ''], ['000-r-multi-1', '000-r-mono-1']]);
    assert.deepEqual([currencyOf({ products: [{ price: { currency: '' } }, { price: { currency: 'USD' } }] }), currencyOf({}), cardCodeOf({ fidelityCard: { code: ' A ' } }), cardCodeOf({ fidelityCard: { code: ' ' } }), cardCodeOf({})], ['USD', 'EUR', ' A ', null, null]);
  });

  it('follows the refunds of this backend and ignores the ones of the legacy', () => {
    const sale = {
      finalTotalCheckout: 100,
      products: [{ qt: 4 }, { qt: 2 }],
      refund: [
        { timestampId: 'R-1', returnedGoodsValue: { priceTaxed: 25 }, returnedGoods: [{ index: 0, returnedQt: 1 }, { index: 7, returnedQt: 1 }, { returnedQt: 1 }, { index: -1, returnedQt: 1 }] },
        { timestampId: 'R-2', returnedGoodsValue: { priceTaxed: 25 }, returnedGoods: [{ index: 0, returnedQt: 1.005 }, { index: 1, returnedQt: 'x' }] },
        { timestampId: null, canceled: true, returnedGoodsValue: { priceTaxed: 50 }, returnedGoods: [{ index: 1, returnedQt: 2 }] },
        { returnedGoodsValue: { priceTaxed: 20 }, returnedGoods: [{ _id: id(), returnedQt: 9 }] },
      ],
    };
    assert.deepEqual(returnedByLine(sale), [2.01, 0]);
    assert.equal(refundedRatioOf(sale), 0.5);
    assert.equal(refundedRatioOf({ finalTotalCheckout: 0, refund: [{ timestampId: 'R', returnedGoodsValue: { priceTaxed: 5 } }] }), 0);
    assert.equal(refundedRatioOf({ finalTotalCheckout: 10, refund: [{ timestampId: 'R', returnedGoodsValue: { priceTaxed: 50 } }] }), 1);
    assert.equal(refundedRatioOf({ finalTotalCheckout: 10 }), 0);
  });

  it('never gives credit back for a refill: a negative quantity or price, or a refund beyond what was sold, count for nothing more than the refills of the sale', () => {
    const line = (qt: number, taxed: number) => ({ freeProduct: false, categories: [], code: '000-r-multi-1', qt, price: { taxed } });
    const refunded = (lines: Document[], returned: number[]) => ({ products: lines, refund: [{ timestampId: 'R', returnedGoods: returned.map((returnedQt, index) => ({ index, returnedQt })) }] });
    assert.equal(refillReturnedOf(refunded([line(2, 50)], [1])), 50);
    assert.equal(refillReturnedOf(refunded([line(2, 50)], [9])), 100);
    assert.equal(refillReturnedOf(refunded([line(-1, 50)], [1])), 0);
    assert.equal(refillReturnedOf(refunded([line(2, -50)], [1])), 0);
    assert.equal(refillReturnedOf(refunded([line(2, -50), line(1, 30)], [1, 1])), 0, 'the total never goes above the refills of the sale, which a negative line brings below zero');
    assert.equal(refillReturnedOf(refunded([line(2, 50), line(1, -80)], [2, 0])), 20, 'at most the refills of the sale (100 - 80)');
    assert.equal(refillReturnedOf(refunded([{ code: '000-r-multi-1', freeProduct: true, qt: 1, price: { taxed: 5 } }], [1])), 0);
  });

  it('builds the refund and the cancellation entries and tells what is wrong with the lines of a refund', () => {
    const product = id();
    const sale = { products: [{ _id: product, code: 'A', name: { it: 'A' }, type: 'product', qt: 2, price: { price: 10, taxed: 12.2, discount: 10, tax: 22, taxData: { id: 't' } } }, { qt: 'x' }], refund: [] };
    const body = { timestampId: 'R-1', date: NOW, products: [{ index: 0, quantity: 1 }, { index: 0, quantity: 1.5 }] };
    const { entry, exceeds } = refundEntryOf(sale, body as never, null);
    assert.equal(exceeds, true);
    assert.deepEqual(entry['returnedGoodsValue'], { totalNoTax: 22.5, taxValue: 4.95, priceTaxed: 27.45 });
    assert.deepEqual(entry['returnedGoods'].map((good: Document) => [good['index'], good['returnedQt'], good['_id']]), [[0, 2.5, product]]);
    const given = refundEntryOf(sale, { ...body, products: [{ index: 0, quantity: 1 }], value: { taxable: 1, tax: 2, total: 3 } } as never, id());
    assert.deepEqual([given.exceeds, given.entry['returnedGoodsValue']], [false, { totalNoTax: 1, taxValue: 2, priceTaxed: 3 }]);
    assert.deepEqual(refundEntryOf(sale, { ...body, products: [{ index: 0, quantity: 1 }], value: null } as never, null).entry['returnedGoodsValue'], { totalNoTax: 9, taxValue: 1.98, priceTaxed: 10.98 });
    const cancelled = cancellationEntryOf({ ...sale, refund: [{ timestampId: 'R-1', returnedGoods: [{ index: 0, returnedQt: 1 }] }] }, { date: NOW, fiscalReceiptInfo: { number: 9 } } as never, null);
    assert.deepEqual([cancelled['canceled'], cancelled['timestampId'], cancelled['returnedGoods'].map((good: Document) => good['returnedQt']), cancelled['fiscalReceiptInfo']['number']], [true, null, [1], 9]);
    assert.deepEqual(refundLineProblems(sale, { products: [{ index: 0, productId: product }, { index: 3, quantity: 1 }, { index: 0, productId: id() }, { index: 1, productId: product }] } as never), ['products.1.index', 'products.2.productId', 'products.3.index']);
  });

  it('builds a sale in the legacy shape from a body, with every optional part', () => {
    const body = validate(
      createSaleBody,
      {
        timestampId: 'T-1',
        date: '2026-11-27T10:00:00.000Z',
        receiptType: 'charge',
        nonFiscal: true,
        operatorId: id().toHexString(),
        cashDesk: { deviceId: 'd', name: 'Cassa', serialNumber: 's', driver: 'x' },
        customer: { contactId: id().toHexString() },
        fidelityCardCode: 'C',
        lotteryCode: 'L',
        products: [{ qt: 1, name: { it: 'Varie' } }],
        totals: { taxable: 1, tax: 0.22, total: 1.22, taxableBeforeDiscount: 2, totalBeforeDiscount: 2.44, discount: { adjustment: 'surcharge', kind: 'value', percentage: 5, value: 1 } },
        payments: { cash: 1.22 },
        fiscalReceiptInfo: { report: 1, number: 2, amount: 1.22, date: '2026-11-27T10:00:01.000Z' },
        table: { tableId: 't', roomId: 'r', name: 'T1', startDate: '2026-11-27T09:00:00.000Z', covers: 2, partition: 'p' },
        delivery: { type: 'home', date: '2026-11-27T11:00:00.000Z', sentAt: '2026-11-27T11:05:00.000Z' },
        reservation: { date: '2026-11-27T12:00:00.000Z' },
        appointment: { appointmentId: id().toHexString(), customerId: id().toHexString(), services: [{ serviceId: id().toHexString(), staffId: id().toHexString() }, { serviceId: id().toHexString() }] },
        hotel: { roomId: '1', roomName: 'Room 1' },
        fullMeal: { status: 'open', quantity: 2 },
        note: 'Nota',
        checkoutStartedAt: '2026-11-27T09:59:00.000Z',
      },
      '(body)',
    );
    const placeId = id();
    const { sale } = buildSale({ body, id: id(), companyId: id(), placeId, userId: null, now: NOW, catalog: new Map(), contact: null, customerNamed: false, createdBy: { kind: 'user', userId: id() }, operatorAnomalies: [] });
    assert.deepEqual([sale['sType'], sale['receiptType'], sale['adjustmentType'], sale['discountType'], sale['discountPercentage'], sale['discountValue'], sale['finalTotalTaxableWithoutDiscount'], sale['finalTotalCheckoutWithoutDiscount'], sale['finalTotalTaxWithoutDiscount']], [true, 'charge', 'surcharge', 'value', 5, 1, 2, 2.44, 0.44]);
    assert.deepEqual([sale['device'], sale['table'], sale['delivery'], sale['reservation'], sale['hotel'], sale['fullMeal'], sale['savedCheckoutsNote'], sale['lotteryId'], sale['fidelityCard']], [
      { settings: { id: 'd', name: 'Cassa', serialNumber: 's', driver: 'x' }, companyId: sale['companyId'].toHexString(), placeId: placeId.toHexString() },
      { originalTable: { id: 't', name: 'T1', roomId: 'r' }, startDate: new Date('2026-11-27T09:00:00.000Z'), covers: 2, partition: 'p' },
      { type: 'home', date: new Date('2026-11-27T11:00:00.000Z'), userId: null, sentAt: new Date('2026-11-27T11:05:00.000Z') },
      { date: new Date('2026-11-27T12:00:00.000Z') },
      { roomId: '1', roomName: 'Room 1' },
      { status: 'open', quantity: 2 },
      'Nota',
      'L',
      { code: 'C' },
    ]);
    assert.deepEqual(sale['appointment'].services.map((service: Document) => service['staffSelected'] === null), [false, true]);
    // The smallest body: every optional part is missing, and the totals before the discount are the totals.
    const small = validate(createSaleBody, { timestampId: 'T-2', date: '2026-11-27T10:00:00.000Z', receiptType: 'receipt', products: [{ qt: 1 }], totals: { taxable: 1, tax: 0.22, total: 1.22 }, payments: {} }, '(body)');
    const built = buildSale({ body: small, id: id(), companyId: id(), placeId, userId: null, now: NOW, catalog: new Map(), contact: { copy: {}, trashed: false }, customerNamed: true, createdBy: { kind: 'user', userId: id() }, operatorAnomalies: [] });
    assert.deepEqual([built.sale['device'], built.sale['table'], built.sale['appointment'], built.sale['delivery'], built.sale['reservation'], built.sale['fullMeal'], built.sale['savedCheckoutsNote'], built.sale['fidelityCard'], built.sale['discountValue'], built.sale['finalTotalCheckoutWithoutDiscount'], built.sale['sType']], [null, null, null, null, null, null, null, null, 0, 1.22, false]);
    assert.deepEqual(built.anomalies, []);
    const nulls = validate(createSaleBody, { ...JSON.parse(JSON.stringify({ timestampId: 'T-3', date: '2026-11-27T10:00:00.000Z', receiptType: 'receipt', products: [{ qt: 1 }], totals: { taxable: 1, tax: 0.22, total: 1.22 }, payments: {} })), fidelityCardCode: null, table: null, appointment: null, delivery: null, reservation: null, hotel: null, fullMeal: null, cashDesk: null, customer: null, note: null, fiscalReceiptInfo: null }, '(body)');
    assert.equal(buildSale({ body: nulls, id: id(), companyId: id(), placeId, userId: null, now: NOW, catalog: new Map(), contact: { copy: {}, trashed: true }, customerNamed: true, createdBy: { kind: 'user', userId: id() }, operatorAnomalies: ['operatorUnknown'] }).anomalies.map((anomaly) => anomaly.code).join(), 'operatorUnknown,customerTrashed');
  });
});

describe('the view of a sale for the store', () => {
  it('reads a stored sale tolerantly, the legacy ones included', () => {
    const _id = id();
    const view = storeSaleView({
      _id,
      timestampId: '',
      date: NOW,
      receiptType: 'other',
      sType: 'yes',
      fiscalState: 'x',
      userId: 'not an id',
      customer: { _id: 'A'.repeat(24) },
      fidelityCard: { code: 'C' },
      products: [{ _id: 'bad', qt: 'x', name: { it: 'A', en: 5 }, price: { taxData: {} } }, { _id: id(), price: 5, name: 'x' }],
      refund: [{ canceled: false, returnedGoods: [{ index: 0, _id: id(), returnedQt: 1 }, { index: 5, returnedQt: 1 }, { returnedQt: 2 }], returnedGoodsValue: 5, fiscalReceiptInfo: { reportNumber: 1 }, date: 'x' }, 7],
      adjustmentType: 3,
    });
    assert.deepEqual([view.id, view.timestampId, view.receiptType, view.nonFiscal, view.fiscalState, view.operatorId, view.customer, view.fidelityCardCode, view.checks, view.totals.discount.adjustment], [_id.toHexString(), null, null, true, null, null, { contactId: 'a'.repeat(24) }, 'C', { status: null, anomalies: 0 }, null]);
    assert.deepEqual([view.products[0]!.productId, view.products[0]!.name, view.products[0]!.quantity, view.products[0]!.taxId, view.products[0]!.returned, view.products[1]!.name, view.products[1]!.unitPrice], [null, { it: 'A' }, 0, null, 1, null, { net: 0, gross: 0 }]);
    assert.deepEqual(view.refunds.map((refund) => [refund.fiscalReceiptInfo, refund.value, refund.date, refund.products.length]), [[{ date: null, report: 1, number: null, amount: null }, { taxable: 0, tax: 0, total: 0 }, null, 3]]);
    const empty = storeSaleView({ _id });
    assert.deepEqual([empty.nonFiscal, empty.products, empty.refunds, empty.fiscalReceiptInfo, empty.date], [false, [], [], null, null]);
    assert.deepEqual(storeSaleView({ _id, receiptType: 'invoice', fiscalState: 'canceled', floodCloud: { serverCheck: { status: 'ok' }, anomalies: [{}, {}] } }).checks, { status: 'ok', anomalies: 2 });
    assert.equal(storeSaleView({ _id, receiptType: 'charge', fiscalState: 'refunded', floodCloud: { serverCheck: { status: 'differences' } } }).checks.status, 'differences');
  });
});

describe('the schemas of the sales', () => {
  const run = (schema: Parameters<typeof validate>[0], value: unknown): unknown => {
    try {
      return validate(schema, value, '(body)');
    } catch (error) {
      return (error as { details: unknown }).details;
    }
  };

  it('judges a product object with the limits of the one place that takes unknown fields', () => {
    assert.deepEqual(run(looseProduct, null), [{ field: '(body)', issue: 'type' }]);
    assert.deepEqual(run(looseProduct, [1]), [{ field: '(body)', issue: 'type' }]);
    assert.deepEqual(run(looseProduct, { a: Number.NaN }), [{ field: '(body)', issue: 'type' }]);
    assert.deepEqual(run(looseProduct, { a: () => 1 }), [{ field: '(body)', issue: 'type' }]);
    assert.deepEqual(run(looseProduct, { a: undefined }), [{ field: '(body)', issue: 'type' }]);
    assert.deepEqual(run(looseProduct, Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`a${String(n)}`, Array.from({ length: 200 }, () => 1)]))), [{ field: '(body)', issue: 'tooMany' }]);
    assert.deepEqual(run(looseProduct, { a: [{ b: [null, true, 'x', 1.5, { c: 'd' }] }] }), { a: [{ b: [null, true, 'x', 1.5, { c: 'd' }] }] });
  });

  it('judges the bodies of the amendment, the refund, the cancellation and the search', () => {
    assert.deepEqual(run(patchSaleBody, { fidelityCardCode: null, customer: null }), { fidelityCardCode: null, customer: null });
    assert.deepEqual(run(patchSaleBody, {}), [{ field: '(body)', issue: 'required' }]);
    assert.deepEqual(run(refundSaleBody, { timestampId: 'R', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 0 }] }), [{ field: 'products.0.quantity', issue: 'minimum' }]);
    assert.deepEqual(Object.keys(run(cancelSaleBody, { date: '2026-11-28T09:00:00.000Z', operatorId: null, fiscalReceiptInfo: null }) as object).sort(), ['date', 'fiscalReceiptInfo', 'operatorId']);
    assert.deepEqual(run(storeSalesQuery, { timestampId: 'T-1', limit: '3' }), { timestampId: 'T-1', limit: 3 });
    assert.deepEqual(run(storeSalesQuery, { reportNumber: '4', serialNumber: 'S' }), { reportNumber: 4, serialNumber: 'S' });
    assert.deepEqual(run(storeSalesQuery, { timestampId: 'T', serialNumber: 'S' }), [{ field: 'serialNumber', issue: 'incorrect' }]);
    assert.deepEqual(run(storeSalesQuery, { serialNumber: 'S' }), [{ field: '(body)', issue: 'incorrect' }]);
    assert.deepEqual(run(storeSalesQuery, {}), [{ field: '(body)', issue: 'incorrect' }]);
  });
});

describe('the repository of the sales writes', () => {
  it('refuses a change that names a field the backend does not own', async () => {
    const repository = createSalesWriteRepository({} as never);
    await assert.rejects(() => repository.update({ scope: { kind: 'none' } } as never, {} as never, id(), { $set: { 'metadata.unpaidIds': [] } }), /does not own the field metadata/);
    await assert.rejects(() => repository.update({ scope: { kind: 'none' } } as never, {} as never, id(), { $set: { 'secret.x': 1 } }), /does not own the field secret/);
    await assert.rejects(() => repository.update({ scope: { kind: 'none' } } as never, {} as never, id(), { $set: { _id: 1 } }), /does not own the field _id/);
  });
});
