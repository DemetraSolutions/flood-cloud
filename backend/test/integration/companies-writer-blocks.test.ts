import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { companiesPlacesWriter } from '../../src/shared/legacy-write/companies-places.writer.ts';
import type { CompaniesPlacesWriter, WriteOutcome } from '../../src/shared/legacy-write/companies-places.writer.ts';
import { EXACT_TYPES, expectedCopy, sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { InvalidWriteInputError, MalformedDocumentError } from '../../src/shared/legacy-write/errors.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { ECOMMERCE_FLAGS } from '../../src/shared/legacy-write/company-paths.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { fullLegacyCompany } from '../helpers/company-fixtures.ts';
import { accessFor } from '../helpers/group-access.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { copyGroupsToMirror } from '../helpers/mirror.ts';
import { snapshotOf } from '../helpers/legacy-write.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

const G1 = fixtureId('group', 1);
const G2 = fixtureId('group', 2);
const C = (n: number): ObjectId => fixtureId('company', n);
const P = (n: number): ObjectId => fixtureId('place', n);

let ctx: TestDatabases;
let access: GroupAccess;
let tick = 0;
const principal = principalOf('PSA');
const clock = (): Date => new Date(Date.UTC(2026, 10, 13, 10, 0, tick++));
const writer = (): CompaniesPlacesWriter => companiesPlacesWriter(principal, access, ctx.databases, { versionKey: TEST_VERSION_KEY, now: clock });
const groupDb = (group = G1) => ctx.databases.group(group, 'cluster0');
const stored = async (id: ObjectId, group = G1): Promise<Document> => (await groupDb(group).collection('companies').findOne({ _id: id }, { ...EXACT_TYPES }))!;
const copy = async (id: ObjectId): Promise<Document> => (await ctx.databases.common().collection('companies').findOne({ _id: id }, { ...EXACT_TYPES }))!;
const versionOfCompany = async (id: ObjectId): Promise<string> => (await writer().currentVersion('companies', id))!;
const written = (outcome: WriteOutcome): { id: ObjectId; version: string } => {
  assert.equal(outcome.outcome, 'written');
  return outcome as { id: ObjectId; version: string; outcome: 'written' };
};
const names = (): string[] => [`${ctx.prefix}development_common`, `${ctx.prefix}development_${G1.toHexString()}`, `${ctx.prefix}development_${G2.toHexString()}`];

beforeEach(async () => {
  tick = 0;
  ctx = await openTestDatabases();
  await ctx.databases.common().collection('groups').insertMany([legacyGroup(1), legacyGroup(2)]);
  await groupDb().collection('companies').insertMany([
    fullLegacyCompany(1, G1),
    fullLegacyCompany(2, G1, { code: 'IT 0111 4601 006', trash: true, name: 'Trashed' }),
    legacyCompany(3, G1, { code: 'DE123456789', settings: {}, fattura_elettronica: {}, medias: {} }),
    legacyCompany(4, G1, { code: 'OTHER4', settings: null, fattura_elettronica: 'x' }),
    legacyCompany(5, G1, { code: 'OTHER5', settings: { global: 'x' } }),
    legacyCompany(6, G1, { code: 'OTHER6', settings: { global: { discountLines: true }, ecommerce: { status: true } }, medias: { images: [] } }),
    legacyCompany(7, G1, { code: ['array'] }),
  ]);
  await groupDb().collection('companies').updateOne({ _id: C(7) }, { $unset: { settings: '', fattura_elettronica: '', medias: '' } });
  await groupDb().collection('places').insertMany([legacyPlace(1, G1, C(1)), legacyPlace(2, G1, C(2), { trash: true })]);
  await groupDb(G2).collection('companies').insertOne(fullLegacyCompany(8, G2, { code: VAT_OF_OTHER_GROUP }));
  await copyGroupsToMirror(ctx.databases, [G1, G2]);
  access = (await accessFor(principal, G1))!;
});
afterEach(async () => {
  await ctx.cleanup();
});

const VAT_OF_OTHER_GROUP = '00905811006';
const TAKEN = { outcome: 'vatNumberTaken' };

async function assertMirrored(id: ObjectId): Promise<void> {
  assert.ok(sameDocument(expectedCopy(await stored(id), G1), await copy(id)), `copy of ${id.toHexString()} is not identical`);
}

describe('companies writer: the keys of the blocks', () => {
  it('sets each key at its own path with the BSON type the legacy writes, and keeps every other key as it was', async () => {
    const before = await stored(C(1));
    const outcome = written(
      await writer().updateCompany(C(1), await versionOfCompany(C(1)), {
        'fattura_elettronica.hub': 'aruba__0123456789abcdef01234567',
        'fattura_elettronica.rea_ufficio': '',
        'settings.global.lastInvoiceNumber': 121,
        'settings.global.discountLines': false,
        'settings.api.cerved': false,
        'settings.ecommerce.showProductRemainingQuantity': 2.5,
        'settings.ecommerce.status': false,
        'settings.ecommerce.listId': '',
        'settings.ecommerce.minAmount': { EUR: { code: 'EUR', value: 30 }, USD: { code: 'USD', value: 5.25 } },
        'medias.images.externalUrl': '',
        'medias.images.customersAppLogoLight': null,
        invoicesPS: 'suffix',
        invoicesPSValues: [{ name: 'Z', cash: true }],
        banks: [{ id: 'b2', name: 'Second', iban: 'IT60X0542811101000000123456', abi: '', cab: '', bic: '', default: false }],
        ticketsSuppliers: [{ id: 't2', name: 'Other', cuts: [10, 2.5, null] }],
      }),
    );
    const after = await stored(C(1));
    const settings = after['settings'] as { global: Document; api: Document; ecommerce: Document };
    assert.ok(settings.global['lastInvoiceNumber'] instanceof Int32 && settings.global['lastInvoiceNumber'].value === 121);
    assert.ok(settings.ecommerce['showProductRemainingQuantity'] instanceof Double && settings.ecommerce['showProductRemainingQuantity'].value === 2.5);
    const minimum = settings.ecommerce['minAmount'] as { EUR: Document; USD: Document };
    assert.ok(minimum.EUR['value'] instanceof Int32 && minimum.USD['value'] instanceof Double);
    const cuts = (after['ticketsSuppliers'] as Array<{ cuts: unknown[] }>)[0]!.cuts;
    assert.ok(cuts[0] instanceof Int32 && cuts[1] instanceof Double && cuts[2] === null);
    assert.deepEqual([after['invoicesPS'], settings.ecommerce['status'], settings.ecommerce['listId'], settings.global['discountLines'], settings.api['cerved']], ['suffix', false, '', false, false]);
    assert.deepEqual((after['fattura_elettronica'] as Document)['hub'], 'aruba__0123456789abcdef01234567');
    assert.equal(((after['medias'] as Document)['images'] as Document)['customersAppLogoLight'], null);
    // Everything else, the unknown keys of the blocks included, is the same bytes.
    for (const path of ['unknownEInvoicing', 'IdTrasmittente_codice', 'regime_fiscale']) {
      assert.ok(sameDocument({ v: (after['fattura_elettronica'] as Document)[path] }, { v: (before['fattura_elettronica'] as Document)[path] }), path);
    }
    for (const key of ['unknownGlobal', 'enableLoginSignup']) {
      assert.ok(sameDocument({ v: settings.global[key] }, { v: ((before['settings'] as Document)['global'] as Document)[key] }), key);
    }
    for (const key of ['unknownEcommerce', 'enableFidelity', 'catalogMode']) {
      assert.ok(sameDocument({ v: settings.ecommerce[key] }, { v: ((before['settings'] as Document)['ecommerce'] as Document)[key] }), key);
    }
    assert.ok(sameDocument({ v: settings['unknownSettings' as keyof typeof settings] }, { v: (before['settings'] as Document)['unknownSettings'] }));
    assert.ok(sameDocument({ v: (after['medias'] as Document)['unknownMedia'] }, { v: (before['medias'] as Document)['unknownMedia'] }));
    assert.ok(sameDocument({ v: (after['futureKey']) }, { v: before['futureKey'] }));
    assert.equal(outcome.version, versionOf('companies', after, TEST_VERSION_KEY));
    assert.notEqual(outcome.version, versionOf('companies', before, TEST_VERSION_KEY));
    await assertMirrored(C(1));
  });

  it('writes nothing but updateDate for the keys it is not given', async () => {
    const before = await stored(C(1));
    written(await writer().updateCompany(C(1), await versionOfCompany(C(1)), { 'settings.ecommerce.catalogMode': true }));
    const after = await stored(C(1));
    const changed = Object.keys({ ...before, ...after }).filter((key) => !sameDocument({ v: before[key] }, { v: after[key] }));
    assert.deepEqual(changed.sort(), ['settings', 'updateDate']);
    assert.ok(sameDocument({ v: { ...(after['settings'] as Document).ecommerce, catalogMode: false } }, { v: { ...(before['settings'] as Document).ecommerce } }));
  });

  it('completes a block that is missing or empty with the defaults of the keys it does not set', async () => {
    written(await writer().updateCompany(C(3), await versionOfCompany(C(3)), { 'settings.ecommerce.status': true, 'fattura_elettronica.hub': 'aruba', 'medias.images.externalUrl': 'https://example.test/x' }));
    const after = await stored(C(3));
    const settings = after['settings'] as { global?: Document; api?: Document; ecommerce: Document };
    assert.equal(settings.global, undefined);
    assert.equal(settings.api, undefined);
    assert.equal(Object.keys(settings.ecommerce).length, 27);
    assert.deepEqual([settings.ecommerce['status'], settings.ecommerce['listId'], settings.ecommerce['minAmount'], settings.ecommerce['catalogMode']], [true, '', {}, false]);
    const invoicing = after['fattura_elettronica'] as Document;
    assert.equal(Object.keys(invoicing).length, 16);
    assert.deepEqual([invoicing['hub'], invoicing['regime_fiscale'], invoicing['codice_eori']], ['aruba', 'RF01', '']);
    assert.deepEqual(after['medias'], { images: { internalFileName: '', externalUrl: 'https://example.test/x', customersAppLogoLight: null, customersAppLogoDark: null } });
    await assertMirrored(C(3));
  });

  it('completes the blocks of a company that has none of them, and the ones a partial settings lacks', async () => {
    written(await writer().updateCompany(C(7), await versionOfCompany(C(7)), { 'settings.global.discountLines': true, 'settings.api.cerved': true }));
    const settings = (await stored(C(7)))['settings'] as { global: Document; api: Document };
    assert.deepEqual(Object.keys(settings.global).length, 5);
    assert.deepEqual([settings.global['discountLines'], settings.global['lastInvoiceNumber'], settings.api], [true, null, { cerved: true }]);
    // A settings with some blocks: only the block written into is completed when it is empty, and a block that has keys is left as it is.
    written(await writer().updateCompany(C(6), await versionOfCompany(C(6)), { 'settings.api.cerved': true, 'settings.global.showTermsPage': true, 'settings.ecommerce.catalogMode': true }));
    const after = await stored(C(6));
    assert.deepEqual(Object.keys((after['settings'] as Document)['global'] as Document).sort(), ['discountLines', 'showTermsPage']);
    assert.deepEqual(Object.keys((after['settings'] as Document)['ecommerce'] as Document).sort(), ['catalogMode', 'status']);
    assert.deepEqual((after['settings'] as Document)['api'], { cerved: true });
  });

  it('refuses, and writes nothing, when a block it writes into is not an object', async () => {
    const before = await snapshotOf(ctx.client, names());
    for (const [id, key, path] of [
      [C(4), 'settings.global.discountLines', 'settings'],
      [C(4), 'fattura_elettronica.hub', 'fattura_elettronica'],
      [C(5), 'settings.global.discountLines', 'settings.global'],
      [C(6), 'medias.images.externalUrl', 'medias.images'],
    ] as Array<[ObjectId, string, string]>) {
      await assert.rejects(
        async () => writer().updateCompany(id, await versionOfCompany(id), { [key]: key.endsWith('Url') ? 'x' : key.endsWith('hub') ? 'aruba' : true }),
        (error: unknown) => error instanceof MalformedDocumentError && error.path === path && !error.message.includes('true'),
        `${id.toHexString()} ${key}`,
      );
    }
    assert.deepEqual(await snapshotOf(ctx.client, names()), before);
    // A change that does not go through the broken block still works.
    written(await writer().updateCompany(C(4), await versionOfCompany(C(4)), { name: 'fine', banks: [] }));
  });

  it('refuses a value of the wrong kind for a key of a block before touching the database', async () => {
    const before = await snapshotOf(ctx.client, names());
    for (const changes of [{ 'settings.global.lastInvoiceNumber': 1.5 }, { 'settings.ecommerce.minAmount': [] }, { banks: [{ id: 1 }] }, { settings: {} }, { 'fattura_elettronica.hub': null }]) {
      await assert.rejects(() => writer().updateCompany(C(1), 'v', changes as never), InvalidWriteInputError);
    }
    assert.deepEqual(await snapshotOf(ctx.client, names()), before);
  });

  it('detects a change of the legacy to a key of a block as a conflict, and ignores the keys it does not own', async () => {
    const version = await versionOfCompany(C(1));
    await groupDb().collection('companies').updateOne({ _id: C(1) }, { $set: { 'settings.ecommerce.unknownEcommerce': false, 'settings.unknownSettings.keep': false, 'fattura_elettronica.unknownEInvoicing': 1 } });
    assert.equal(await versionOfCompany(C(1)), version);
    for (const [path, value] of [['settings.ecommerce.status', false], ['fattura_elettronica.hub', 'x'], ['banks.0.name', 'changed'], ['settings.global.lastInvoiceNumber', new Double(120)]] as Array<[string, unknown]>) {
      const before = await versionOfCompany(C(1));
      await groupDb().collection('companies').updateOne({ _id: C(1) }, { $set: { [path]: value } });
      assert.notEqual(await versionOfCompany(C(1)), before, path);
      assert.deepEqual(await writer().updateCompany(C(1), before, { name: 'late' }), { outcome: 'conflict' });
    }
  });

  it('rolls everything back when the copy cannot be written', async () => {
    const version = await versionOfCompany(C(1));
    const before = await snapshotOf(ctx.client, names());
    const failing = {
      ...ctx.databases,
      common: () => ({
        collection: () => ({
          replaceOne: async () => {
            throw new Error('boom');
          },
        }),
      }),
    } as never;
    await assert.rejects(() => companiesPlacesWriter(principal, access, failing, { versionKey: TEST_VERSION_KEY, now: clock }).updateCompany(C(1), version, { 'settings.api.cerved': false }), /boom/);
    assert.deepEqual(await snapshotOf(ctx.client, names()), before);
  });
});

describe('companies writer: creation with the keys of the blocks', () => {
  it('creates a company with every key at its place and the legacy types', async () => {
    const outcome = written(
      await writer().createCompany({
        name: 'New Co',
        code: '15844561009',
        status: false,
        'fattura_elettronica.hub': 'aruba',
        'settings.global.lastInvoiceNumber': 5,
        'settings.ecommerce.status': true,
        'settings.ecommerce.showProductRemainingQuantity': 1.5,
        'settings.ecommerce.minAmount': { EUR: { code: 'EUR', value: 3 } },
        'medias.images.internalFileName': 'a.png',
        invoicesPSValues: [{ name: 'A', cash: true }],
        banks: [{ id: 'b1', name: '', iban: 'IT60X0542811101000000123456', abi: '', cab: '', bic: '', default: true }],
      }),
    );
    const created = await stored(outcome.id);
    const settings = created['settings'] as { global: Document; ecommerce: Document };
    assert.deepEqual([created['status'], created['expirationDate'], created['invoicesPSValues']], [false, null, [{ name: 'A', cash: true }]]);
    assert.ok(settings.global['lastInvoiceNumber'] instanceof Int32 && settings.ecommerce['showProductRemainingQuantity'] instanceof Double);
    assert.equal(Object.keys(settings.ecommerce).length, 27);
    assert.equal(Object.keys(created['fattura_elettronica'] as Document).length, 16);
    assert.equal(((created['medias'] as Document)['images'] as Document)['internalFileName'], 'a.png');
    assert.equal(outcome.version, versionOf('companies', created, TEST_VERSION_KEY));
    assert.ok(sameDocument(expectedCopy(created, G1), await copy(outcome.id)));
    assert.equal(ECOMMERCE_FLAGS.length + 3, Object.keys(settings.ecommerce).length);
  });
});

describe('companies writer: the VAT number of a company', () => {
  it('refuses a creation whose normalized number belongs to a company of the group that is not in the trash, and writes nothing', async () => {
    const before = await snapshotOf(ctx.client, names());
    for (const code of [' it01114601006', '0111 4601 006', 'IT 01114601006', 'it 0111 46010 06']) {
      assert.deepEqual(await writer().createCompany({ name: 'Dup', code }), TAKEN, code);
    }
    assert.deepEqual(await snapshotOf(ctx.client, names()), before);
  });

  it('ignores the companies in the trash, the other groups, the other formats, and codes that are not text', async () => {
    // Company 2 is in the trash and has the number of company 1 in another form; group 2 has this number.
    written(await writer().createCompany({ name: 'Other group', code: VAT_OF_OTHER_GROUP }));
    written(await writer().createCompany({ name: 'Close', code: '01114601007' }));
    written(await writer().createCompany({ name: 'Foreign', code: 'DE012345678' }));
    written(await writer().createCompany({ name: 'No code' }));
    written(await writer().createCompany({ name: 'No code either', code: '   ' }));
    const trashed = await groupDb().collection('companies').countDocuments({ trash: true, code: 'IT 0111 4601 006' });
    assert.equal(trashed, 1);
    // A number only a trashed company has is free.
    await groupDb().collection('companies').updateOne({ _id: C(1) }, { $set: { trash: true } });
    written(await writer().createCompany({ name: 'Free now', code: '01114601006' }));
  });

  it('finds a foreign number whatever its case and spaces', async () => {
    assert.deepEqual(await writer().createCompany({ name: 'Dup', code: 'de 123 456 789' }), TAKEN);
  });

  it('checks an update only when the code changes, and never against the company itself', async () => {
    // The data has duplicates: a company that is not given a code is changed even if another has the same number.
    await groupDb().collection('companies').updateOne({ _id: C(3) }, { $set: { code: '01114601006' } });
    const renamed = written(await writer().updateCompany(C(1), await versionOfCompany(C(1)), { name: 'Renamed' }));
    await groupDb().collection('companies').updateOne({ _id: C(3) }, { $set: { code: 'DE123456789' } });
    // The same number in another form is the same company's: no conflict.
    written(await writer().updateCompany(C(1), renamed.version, { code: 'IT01114601006' }));
    // A free number.
    written(await writer().updateCompany(C(1), await versionOfCompany(C(1)), { code: '00905811006', name: 'x' }));
    assert.equal((await stored(C(1)))['code'], '00905811006');
    // Another company's number, in any form.
    const before = await snapshotOf(ctx.client, names());
    assert.deepEqual(await writer().updateCompany(C(1), await versionOfCompany(C(1)), { code: ' de123456789 ' }), TAKEN);
    assert.deepEqual(await snapshotOf(ctx.client, names()), before);
    // An empty code is not a number: nothing to compare.
    written(await writer().updateCompany(C(1), await versionOfCompany(C(1)), { code: '' }));
  });
});

describe('companies writer: reading and deleting', () => {
  it('applies the perimeter of the principal to what it reads', async () => {
    const own = principalOf('CA', { groupId: G1, companyIds: [C(1)], placeIds: [P(1)] });
    const ownAccess = (await accessFor(own, G1))!;
    const reader = companiesPlacesWriter(own, ownAccess, ctx.databases, { versionKey: TEST_VERSION_KEY });
    assert.notEqual(await reader.read('companies', C(1)), null);
    assert.equal(await reader.read('companies', C(2)), null);
    assert.notEqual(await reader.read('places', P(1)), null);
    assert.equal(await reader.read('places', P(2)), null);
    const placeAdmin = principalOf('PA', { groupId: G1, placeIds: [P(2)] });
    const paReader = companiesPlacesWriter(placeAdmin, (await accessFor(placeAdmin, G1))!, ctx.databases, { versionKey: TEST_VERSION_KEY });
    assert.equal(await paReader.read('companies', C(1)), null);
    assert.notEqual(await paReader.read('places', P(2)), null);
    assert.equal(await paReader.read('places', P(1)), null);
  });

  it('restores a company only while its VAT number is free, and also when the stored code is not text', async () => {
    const version = await versionOfCompany(C(2));
    // Company 2 is in the trash with the number of company 1 in another form.
    assert.deepEqual(await writer().restore('companies', C(2), version), TAKEN);
    assert.equal((await stored(C(2)))['trash'], true);
    await groupDb().collection('companies').updateOne({ _id: C(1) }, { $set: { trash: true } });
    written(await writer().restore('companies', C(2), version));
    assert.equal((await stored(C(2)))['trash'], false);
    await groupDb().collection('companies').updateOne({ _id: C(7) }, { $set: { trash: true } });
    written(await writer().restore('companies', C(7), await versionOfCompany(C(7))));
    assert.deepEqual(await writer().restore('companies', C(99), 'v'), { outcome: 'notFound' });
    assert.deepEqual(await writer().restore('companies', C(7), 'wrong'), { outcome: 'conflict' });
  });

  it('counts a place that stores its company as text among the references', async () => {
    await groupDb().collection('places').updateOne({ _id: P(2) }, { $set: { companyId: C(2).toHexString() } });
    assert.deepEqual(await writer().deleteTrashed('companies', C(2), await versionOfCompany(C(2))), { outcome: 'referenced' });
  });

  it('reads a document with its exact types and the version a write checks', async () => {
    const found = (await writer().read('companies', C(1)))!;
    assert.equal(found.version, await versionOfCompany(C(1)));
    assert.ok(((found.document['settings'] as Document)['global'] as Document)['lastInvoiceNumber'] instanceof Int32);
    assert.equal(found.document['name'], 'Acme S.r.l.');
    assert.equal(await writer().read('companies', C(99)), null);
    assert.equal(await writer().read('companies', C(8)), null);
    assert.equal((await writer().read('places', P(1)))!.version, await writer().currentVersion('places', P(1)));
    await assert.rejects(() => writer().read('companies', 'x' as never), InvalidWriteInputError);
  });

  it('refuses to delete a company that a place of the group still refers to, trashed places included', async () => {
    // Company 2 is in the trash and place 2 (in the trash too) belongs to it.
    const before = await snapshotOf(ctx.client, names());
    assert.deepEqual(await writer().deleteTrashed('companies', C(2), await versionOfCompany(C(2))), { outcome: 'referenced' });
    assert.deepEqual(await snapshotOf(ctx.client, names()), before);
    await groupDb().collection('places').deleteOne({ _id: P(2) });
    await ctx.databases.common().collection('places').deleteOne({ _id: P(2) });
    assert.deepEqual(await writer().deleteTrashed('companies', C(2), await versionOfCompany(C(2))), { outcome: 'deleted', id: C(2) });
    assert.equal(await stored(C(2)), null);
    assert.equal(await ctx.databases.common().collection('companies').findOne({ _id: C(2) }), null);
  });
});
