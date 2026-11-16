import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { newPlaceDocument } from '../../src/shared/legacy-write/defaults.ts';
import { PLACE_FIELD_KINDS, checkFields } from '../../src/shared/legacy-write/fields.ts';
import { DEPRECATED_ROOMS_PATHS, SETTING_BLOCKS, SETTING_CONTAINERS, SETTING_FIELDS } from '../../src/shared/legacy-write/place-settings.ts';
import { valueAt } from '../../src/modules/companies/company.mapper.ts';
import { codecOf } from '../../src/modules/places/place-settings.mapper.ts';
import { settingsSchema } from '../../src/modules/places/place-settings.schemas.ts';
import { required, partial } from '../../src/modules/companies/companies.schemas.ts';
import { newPaymentTypeId } from '../../src/modules/places/place-ids.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const template = (): Document => newPlaceDocument(new ObjectId(), fixtureId('group', 1), { name: 'x', companyId: fixtureId('company', 1) }, new Date());

/** The stored keys of the template that are not settings of a block: the ones of other tabs, of the POS and of the integrations. */
const NOT_SETTINGS = ['general.priceLists', 'platform.sentry', 'delivery.time', 'roomsSettings.reservation'];

function leafPaths(value: unknown, prefix: string, wholes: ReadonlySet<string>): string[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof ObjectId) && !wholes.has(prefix)) {
    return Object.entries(value).flatMap(([key, inner]) => leafPaths(inner, prefix === '' ? key : `${prefix}.${key}`, wholes));
  }
  return [prefix];
}

describe('place settings: the table of keys against the template of a new place', () => {
  const wholes = new Set(SETTING_FIELDS.filter((field) => field.kind.t === 'whole' || field.kind.t === 'logo').map((field) => field.legacy));

  it('has a key for every leaf the template has in the blocks of the settings, and none the template lacks', () => {
    const document = template();
    const owned = new Set([...SETTING_FIELDS.map((field) => field.legacy), ...DEPRECATED_ROOMS_PATHS]);
    for (const field of SETTING_FIELDS) {
      assert.notEqual(valueAt(document, field.legacy), undefined, field.legacy);
    }
    const roots = ['general', 'advancedReport', 'receipt', 'prebilling', 'ordering', 'roomsSettings', 'payments', 'paymentTypes', 'deliveryTakeAway', 'delivery', 'selfOrdering', 'kiosk', 'appointment', 'externalDisplay', 'fidelity', 'tgm', 'medias'];
    const covered = (path: string): boolean => owned.has(path) || NOT_SETTINGS.some((skip) => path === skip || path.startsWith(`${skip}.`)) || [...owned].some((own) => path.startsWith(`${own}.`));
    for (const root of roots) {
      for (const path of leafPaths(document[root], root, wholes)) {
        assert.ok(covered(path), `${path} is not in the table`);
      }
    }
  });

  it('reads the default of the template as the default of the form and writes it back as the same stored value (the numbers of the same BSON type)', () => {
    const document = template();
    for (const field of SETTING_FIELDS) {
      const codec = codecOf(field.kind);
      const stored = valueAt(document, field.legacy);
      const domain = codec.read(stored);
      assert.deepEqual(codec.write(domain, stored), stored, field.legacy);
    }
  });

  it('is complete for the containers: every container it names exists in the template as an object', () => {
    const document = template();
    for (const container of SETTING_CONTAINERS) {
      const value = valueAt(document, container);
      assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), container);
    }
    assert.ok(SETTING_CONTAINERS.includes('roomsSettings.reservation.webWidget') && !SETTING_CONTAINERS.includes('roomsSettings.tableGroups'));
  });

  it('checks every key of the table in the write service, the images as descriptors, and lets the deprecated copies through', () => {
    for (const field of SETTING_FIELDS) {
      assert.equal(PLACE_FIELD_KINDS[field.legacy], field.kind.t === 'logo' ? 'logoOrNull' : 'setting', field.legacy);
    }
    for (const path of DEPRECATED_ROOMS_PATHS) {
      assert.deepEqual(checkFields(PLACE_FIELD_KINDS, { [path]: true }), { [path]: true });
    }
    assert.equal(Object.keys(SETTING_BLOCKS).length, 13);
  });

  it('accepts as a setting the values the codecs write and refuses operators, paths and what is too large or too deep', () => {
    const ok = (value: unknown) => checkFields(PLACE_FIELD_KINDS, { 'kiosk.titleText': value });
    for (const value of [null, true, 5, 'text', new ObjectId(), new Date(), new Int32(1), new Double(1.5), [{ a: [1] }], { it: 'x', en: { deep: null } }]) {
      assert.doesNotThrow(() => ok(value));
    }
    const deep = (levels: number): unknown => (levels === 0 ? 1 : { a: deep(levels - 1) });
    for (const value of [Number.NaN, undefined === 1 ? 0 : () => 1, 'x'.repeat(5001), { $where: 1 }, { 'a.b': 1 }, Array.from({ length: 501 }, () => 1), Object.fromEntries(Array.from({ length: 501 }, (_unused, index) => [`k${String(index)}`, 1])), deep(7), [[[[[[[1]]]]]]]]) {
      assert.throws(() => ok(value), /Invalid value/);
    }
  });
});

describe('place settings: the codecs read tolerantly', () => {
  const read = (path: string, stored: unknown) => codecOf(SETTING_FIELDS.find((field) => field.legacy === path)!.kind).read(stored);

  it('reads a value of the wrong type as the default of the form', () => {
    assert.equal(read('general.fastLogin', 'yes'), false);
    assert.equal(read('general.chargeDocumentQt', 'x'), 1);
    assert.equal(read('general.chargeDocumentQt', new Double(2)), 2);
    assert.equal(read('general.chargeDocumentQt', 2.5), 1);
    assert.equal(read('general.localWarehouseOutOfStock', 'weird'), 'disabled');
    assert.equal(read('general.receiptsCancellation', 5), null);
    assert.equal(read('receipt.subtotalFontSize', '9-9'), '1-1');
    assert.equal(read('externalDisplay.backgroundColor', 'red'), '#8936F7');
    assert.equal(read('general.operatingTime', ''), null);
    assert.equal(read('general.totalRounding', 'x'), null);
    assert.equal(read('deliveryTakeAway.deliveryListId', ''), null);
    assert.equal(read('roomsSettings.reservation.emailNotification.templateId', 'abc'), null);
    assert.equal(read('medias.images.externalUrl', 5), '');
    assert.equal(read('medias.images.logoLight', 5), null);
    assert.equal(read('selfOrdering.additionalInfo', { it: 'x' }), null);
    assert.equal(read('selfOrdering.additionalInfo', 'text'), 'text');
  });

  it('reads the whole lists and maps item by item, leaving out what is not well formed', () => {
    assert.deepEqual(read('general.workshiftNames', ['a', 5, 'b']), ['a', 'b']);
    assert.deepEqual(read('general.workshiftNames', 'x'), []);
    assert.deepEqual(read('roomsSettings.tipValues', [{ type: 'p', value: new Double(5) }, { type: 'x', value: 2 }, { type: 'v' }, 3]), [{ type: 'p', value: 5 }, { type: 'v', value: 2 }]);
    assert.deepEqual(read('roomsSettings.tableGroups', true), { status: true, name: false, autoCreateFirst: false });
    assert.deepEqual(read('roomsSettings.tableGroups', 'x'), { status: false, name: false, autoCreateFirst: false });
    assert.deepEqual(read('roomsSettings.tableGroups', { status: true, name: true, autoCreateFirst: false, mergeProductsPrint: true }), { status: true, name: true, autoCreateFirst: false });
    assert.deepEqual(read('roomsSettings.reservation.timeBlocks', [{ weekDays: [1, 'x', new Int32(2)], start: '09:00', end: 5 }, 7]), [{ weekDays: [1, 2], start: '09:00', end: '' }]);
    assert.deepEqual(read('roomsSettings.reservation.timeBlocks', [{ start: '09:00' }]), [{ weekDays: [], start: '09:00', end: '' }]);
    assert.deepEqual(read('paymentTypes', [{ id: 'a', name: 'Cash', cash: true, fattura_elettronica: { ModalitaPagamento: 'MP01' } }, { id: 5, fattura_elettronica: 3 }]), [
      { id: 'a', name: 'Cash', cash: true, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: 'MP01' },
      { id: '', name: '', cash: false, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: null },
    ]);
    assert.deepEqual(read('deliveryTakeAway.shippingCosts', [{ taxed: 1, toKm: new Int32(2) }, { taxed: 1 }]), [{ taxed: 1, toKm: 2 }]);
    assert.deepEqual(read('kiosk.productsCategories', [{ _id: 'a', position: 2 }, { _id: 7 }]), [{ _id: 'a', position: 2 }]);
    assert.deepEqual(read('kiosk.titleText', { it: 'x', en: 5 }), { it: 'x' });
    assert.deepEqual(read('kiosk.titleText', 'x'), {});
    assert.deepEqual(read('selfOrdering.priceListsConfig', { a: { roundTime: 5, variants: true, productsCategories: [{ _id: 'c', purchasable: true, position: 1 }, { _id: 3 }] }, b: 'x' }), {
      a: { roundTime: 5, roundMaxProducts: null, totalMaxProducts: null, variants: true, freeVariants: false, tableAutoClose: false, productsCategories: [{ _id: 'c', roundMaxProducts: null, totalMaxProducts: null, position: 1, purchasable: true }] },
    });
    assert.deepEqual(read('selfOrdering.priceListsConfig', 'x'), {});
  });

  it('writes the maps merged with what the document has, and the table groups with the copy of the ordering', () => {
    const codec = (path: string) => codecOf(SETTING_FIELDS.find((field) => field.legacy === path)!.kind);
    assert.deepEqual(codec('kiosk.titleText').write({ it: 'a' }, { it: 'old', de: 'keep' }), { it: 'a', de: 'keep' });
    assert.deepEqual(codec('kiosk.titleText').write({ it: 'a' }, 'x'), { it: 'a' });
    assert.deepEqual(codec('roomsSettings.tableGroups').write({ status: true, name: false, autoCreateFirst: true }, { mergeProductsPrint: true }), { status: true, name: false, autoCreateFirst: true, mergeProductsPrint: true });
    assert.deepEqual(codec('roomsSettings.tableGroups').write({ status: true, name: false, autoCreateFirst: true }, true), { status: true, name: false, autoCreateFirst: true, mergeProductsPrint: false });
    assert.deepEqual(codec('paymentTypes').write([{ id: 'a', name: 'n', cash: true, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: null }], []), [
      { id: 'a', name: 'n', cash: true, electronic: false, cheque: false, tickets: false, fattura_elettronica: { ModalitaPagamento: '' } },
    ]);
    assert.equal(codec('roomsSettings.reservation.emailNotification.templateId').write(null, undefined), null);
    assert.deepEqual(codec('roomsSettings.reservation.emailNotification.templateId').write(fixtureId('group', 5).toHexString(), undefined), fixtureId('group', 5));
    assert.equal(codec('general.chargeDocumentQt').write(null, 1), 1);
    assert.equal(codec('general.receiptsCancellation').write(null, null), null);
  });
});

describe('place settings: the schemas', () => {
  const run = (block: string, value: unknown, part = partial) => validate(settingsSchema(block, part), value, '(body)');
  const issues = (block: string, value: unknown, part = partial): Array<{ field: string; issue: string }> => {
    try {
      run(block, value, part);
    } catch (error) {
      return (error as { details: Array<{ field: string; issue: string }> }).details;
    }
    return [];
  };

  it('takes any subset of a block as a modification and refuses unknown keys, operators and the keys of other blocks', () => {
    assert.deepEqual(run('cashSettings', { fastLogin: true, chargeDocumentQt: 3, customDiscount: ' 5;10 ', operatingTime: '' }), { fastLogin: true, chargeDocumentQt: 3, customDiscount: '5;10', operatingTime: null });
    assert.deepEqual(issues('cashSettings', { priceLists: [] }), [{ field: 'priceLists', issue: 'unknown' }]);
    assert.deepEqual(issues('cashSettings', { $set: 1 }), [{ field: '(key)', issue: 'forbiddenKey' }]);
    assert.deepEqual(run('printing', { ordering: { productsSorting: 'position' }, receipt: { subtotalFontSize: '2-3' } }), { ordering: { productsSorting: 'position' }, receipt: { subtotalFontSize: '2-3' } });
  });

  it('needs every key of the block as a whole block', () => {
    const missing = issues('fidelity', {}, required);
    assert.deepEqual(missing.map((item) => item.field), ['type', 'showPoints', 'showPointsCheckout', 'printDataOnFiscalReceipt', 'printDataOnReceipt']);
    assert.deepEqual(run('fidelity', { type: '', showPoints: true, showPointsCheckout: false, printDataOnFiscalReceipt: false, printDataOnReceipt: false }, required), { type: null, showPoints: true, showPointsCheckout: false, printDataOnFiscalReceipt: false, printDataOnReceipt: false });
  });

  it('refuses the values outside the form: enums, fonts, colors, times, integers, ids and lengths', () => {
    // The form of a font size, a color and a time is judged by the service where the value changes: the schema only bounds the length.
    assert.deepEqual(issues('printing', { receipt: { subtotalFontSize: '4-1' } }), []);
    assert.deepEqual(issues('printing', { receipt: { subtotalFontSize: '1-1-1' } }).map((item) => item.issue), ['maxLength']);
    assert.deepEqual(issues('externalDisplay', { backgroundColor: 'red', tips: 'yes' }).map((item) => item.field), ['tips']);
    assert.deepEqual(issues('externalDisplay', { backgroundColor: '#1234567' }).map((item) => item.issue), ['maxLength']);
    assert.deepEqual(issues('cashSettings', { operatingTime: '25:00', chargeDocumentQt: 0, localWarehouseOutOfStock: 'x', totalRounding: -1 }).map((item) => item.field), ['chargeDocumentQt', 'localWarehouseOutOfStock', 'totalRounding']);
    assert.deepEqual(issues('tobacco', { companyId: 'nope' }).map((item) => item.field), ['companyId']);
    assert.deepEqual(issues('kiosk', { listId: 'a b', mode: 'x', idleTimeAlert: 1.5 }).map((item) => item.field), ['listId', 'mode', 'idleTimeAlert']);
    assert.deepEqual(issues('delivery', { takeAway: { sendOrderOnSave: 'x', deliveryListId: 'a b' }, lat: 5000 }).map((item) => item.field), ['takeAway.sendOrderOnSave', 'takeAway.deliveryListId', 'lat']);
    assert.deepEqual(issues('media', { internalFileName: '../x', externalUrl: 'ftp://x', internalFileNameLogo: 'a/b', externalUrlLogo: 'javascript:1' }).map((item) => item.field), ['internalFileNameLogo', 'externalUrlLogo', 'internalFileName', 'externalUrl']);
    assert.deepEqual(run('media', { logoLight: { imageId: 'a'.repeat(24) }, logoKiosk: null, externalUrl: '' }), { logoLight: { imageId: 'a'.repeat(24) }, logoKiosk: null, externalUrl: '' });
  });

  it('bounds every list and map, and keys the maps safely', () => {
    assert.deepEqual(issues('tables', { tipValues: Array.from({ length: 21 }, () => ({ type: 'v', value: 1 })) }).map((item) => item.issue), ['tooMany']);
    assert.deepEqual(issues('tables', { tipValues: [{ type: 'x', value: 1 }], tableGroups: { status: true } }).map((item) => item.field), ['tipValues.0.type', 'tableGroups.name', 'tableGroups.autoCreateFirst']);
    assert.deepEqual(issues('delivery', { minAmount: { eur: 1, EUR: -1 } }).map((item) => item.field), ['minAmount.eur', 'minAmount.EUR']);
    assert.deepEqual(issues('delivery', { minAmount: { $ne: 1 } }).map((item) => item.issue), ['forbiddenKey']);
    assert.deepEqual(issues('kiosk', { titleText: { 'it.x': 'a', xyz: 'b', it: 5 } }).map((item) => item.issue), ['forbiddenKey', 'format', 'type']);
    assert.deepEqual(issues('kiosk', { titleText: Object.fromEntries(Array.from({ length: 21 }, (_unused, index) => [`a${String.fromCharCode(97 + (index % 26))}`, 'x'])) }).map((item) => item.issue), ['tooMany']);
    assert.deepEqual(issues('selfOrdering', { priceListsConfig: { 'a.b': {}, __proto__x: 1 } }).length > 0, true);
    assert.deepEqual(issues('reservations', { timeBlocks: [{ weekDays: [1, 1, 8], start: '9:00', end: '10:00' }] }).map((item) => item.field), ['timeBlocks.0.weekDays.1', 'timeBlocks.0.weekDays.2']);
    assert.deepEqual(issues('payments', { paymentTypes: [{ id: 'a b', name: '', cash: true, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: 'MP99' }] }).map((item) => item.field), ['paymentTypes.0.id', 'paymentTypes.0.name', 'paymentTypes.0.electronicInvoiceMode']);
    assert.deepEqual(run('payments', { paymentTypes: [{ name: 'Cash', cash: true, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: '' }] }), { paymentTypes: [{ name: 'Cash', cash: true, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: null }] });
  });

  it('makes the ids of the payment types in the form of the legacy', () => {
    const id = newPaymentTypeId(() => 1_700_000_000_000);
    assert.match(id, /^[0-9a-z]{7}\d{1,10}1700000000000$/);
    assert.notEqual(newPaymentTypeId(), newPaymentTypeId());
  });
});
