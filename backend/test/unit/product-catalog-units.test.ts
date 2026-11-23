import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { ClientSession, Document } from 'mongodb';
import { PRODUCTS_ATTRIBUTES_OWNED_FIELDS, PRODUCTS_BRANDS_OWNED_FIELDS, PRODUCTS_DEPARTMENTS_OWNED_FIELDS } from '../../src/db/collections.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { ClientContext } from '../../src/shared/http/client-context.ts';
import { createCatalogsService } from '../../src/modules/groups/catalogs/catalogs.service.ts';
import type { CatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { taxes } from '../../src/modules/groups/catalogs/taxes.ts';
import { assertWritablePlaces, isWritablePlaces, perimeterOf, placeIdsOf, placesWrite, shownPlaceIds, visibleTo } from '../../src/modules/product-catalog/availability.ts';
import { createEntityRepository } from '../../src/modules/product-catalog/entity.repository.ts';
import { entityVersion } from '../../src/modules/product-catalog/entity.service.ts';
import { imageOf, imageWrite, newMedias } from '../../src/modules/product-catalog/image.ts';
import { groupLanguagesOf, languageIssues, mergeTexts, requiredLanguage, textsOf } from '../../src/modules/product-catalog/texts.ts';
import { createAttributeGroupsService } from '../../src/modules/product-attribute-groups/product-attribute-groups.service.ts';
import { createBrandsService } from '../../src/modules/product-brands/product-brands.service.ts';
import { createDepartmentsService } from '../../src/modules/product-departments/product-departments.service.ts';
import { MAX_DEPARTMENTS_READ, createDepartmentsRepository, createTaxDepartments } from '../../src/modules/product-departments/product-departments.repository.ts';
import { codeOf, departmentExtra } from '../../src/modules/product-departments/product-departments.mapper.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';

const groupId = fixtureId('group', 1);
const own = fixtureId('place', 1);
const other = fixtureId('place', 2);
const hex = (id: ObjectId) => id.toHexString();
const ca = principalOf('CA', { groupId, companyIds: [fixtureId('company', 1)], placeIds: [own] });
const sa = principalOf('SA', { groupId });
const access = { groupId, clusterId: 'cluster0', crossGroup: false, features: { media: true } } as unknown as GroupAccess;
const client: ClientContext = { requestId: 'r1', ip: null, userAgent: null };
const key = Buffer.alloc(32, 7);

describe('texts', () => {
  it('reads the languages of a group from the legacy text, from a list, and falls back to Italian', () => {
    assert.deepEqual(groupLanguagesOf('it;EN; de ;it;xx1;;'), ['it', 'en', 'de']);
    assert.deepEqual(groupLanguagesOf(['en', 5, 'fr', 'en']), ['en', 'fr']);
    for (const raw of [undefined, null, '', true, 5, {}, ['x1'], ';']) {
      assert.deepEqual(groupLanguagesOf(raw), ['it']);
    }
  });

  it('chooses the language a name is required in', () => {
    assert.equal(requiredLanguage('en', ['it', 'en']), 'en');
    assert.equal(requiredLanguage('de', ['it', 'en']), 'it');
  });

  it('reads and merges texts without trusting the stored shape', () => {
    assert.deepEqual(textsOf({ it: 'a', en: 5, 'it-IT': 'b', __proto__: 'x', constructor: 'c', 'bad key': 'z' }), { it: 'a', 'it-IT': 'b' });
    for (const raw of [undefined, null, 'text', 5, ['it']]) {
      assert.deepEqual(textsOf(raw), {});
    }
    assert.deepEqual(mergeTexts({ it: 'a', fr: 'b', other: 1 }, { it: 'c', fr: null, en: 'd' }), { it: 'c', other: 1, en: 'd' });
    assert.deepEqual(mergeTexts('text', { it: 'c' }), { it: 'c' });
    assert.deepEqual(languageIssues('name', { it: 'a', fr: 'b', de: null }, { fr: 'b' }, new Set(['it'])), []);
    assert.deepEqual(languageIssues('name', { it: 'a', fr: 'c', de: 'd' }, { fr: 'b' }, new Set(['it'])), [
      { field: 'name.fr', issue: 'incorrect' },
      { field: 'name.de', issue: 'incorrect' },
    ]);
  });
});

describe('availability', () => {
  it('reads place ids as ObjectIds only and shows a restricted caller only his own', () => {
    assert.deepEqual(placeIdsOf([own, hex(other), own, 'junk', 5, null]), [hex(own)]);
    assert.deepEqual(placeIdsOf(undefined), []);
    assert.deepEqual(placeIdsOf('x'), []);
    assert.deepEqual(shownPlaceIds(ca, [own, other]), [hex(own)]);
    assert.deepEqual(shownPlaceIds(sa, [own, other]), [hex(own), hex(other)]);
    assert.equal(perimeterOf(sa), null);
    assert.deepEqual(visibleTo(sa), {});
    assert.deepEqual([...perimeterOf(ca)!], [hex(own)]);
  });

  it('writes the whole list, and a restricted caller never leaves an entry without a place of his own', () => {
    assert.deepEqual(placesWrite(ca, [own], [hex(own)]), { value: [own], added: [] });
    assert.deepEqual(placesWrite(sa, [own], []), { value: [], added: [] });
    assert.deepEqual(placesWrite(sa, [own], [hex(own), hex(other)]).added, [hex(other)]);
    assert.throws(() => placesWrite(ca, [own], []), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN' && JSON.stringify(error.details) === '[{"field":"placeIds","issue":"notAllowed"}]');
    assert.throws(() => placesWrite(ca, undefined, [hex(other)]), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
  });

  it('lets a restricted caller modify and delete only entries that name places and all of them are his', () => {
    assert.doesNotThrow(() => assertWritablePlaces(ca, [own]));
    assert.doesNotThrow(() => assertWritablePlaces(sa, []));
    assert.equal(isWritablePlaces(sa, undefined), true);
    for (const stored of [[], [own, other], [own, 1], [own, hex(own)], [own, own], undefined, null, 'x']) {
      assert.equal(isWritablePlaces(ca, stored), false, JSON.stringify(stored));
      assert.throws(() => assertWritablePlaces(ca, stored), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN', JSON.stringify(stored));
    }
  });
});

describe('images', () => {
  const descriptor = { _id: hex(new ObjectId()), basename: 'a.png', extension: 'png', filename: 'A', mimetype: 'image/png', title: 'A', alt: '', dirname: '/media/image', type: 'image', filectime: 5 };

  it('removes only the main image, and does nothing when there is none', () => {
    assert.deepEqual(imageWrite({ images: {} }, null), { set: {}, unset: {}, medias: { images: {} } });
    assert.deepEqual(imageWrite(undefined, null), { set: {}, unset: {}, medias: undefined });
    assert.deepEqual(imageWrite({ images: 'x' }, null).unset, {});
    assert.deepEqual(imageWrite({ images: { main: {}, keep: 1 }, other: 2 }, null), { set: {}, unset: { 'medias.images.main': '' }, medias: { images: { keep: 1 }, other: 2 } });
  });

  it('stores the image in the smallest container that holds the path and reads it back', () => {
    for (const stored of [undefined, null, 'x', { other: 1 }, { images: null }, { images: {} }]) {
      const written = imageWrite(stored, descriptor);
      assert.equal(imageOf({ medias: written.medias })?._id, descriptor._id);
    }
    assert.equal(imageOf({}), null);
    assert.equal(imageOf({ medias: { images: { main: 'x' } } }), null);
    assert.deepEqual(newMedias(null), { images: {} });
    assert.equal(imageOf({ medias: newMedias(descriptor) })?._id, descriptor._id);
  });
});

describe('the repository of an entry collection', () => {
  const calls: Document[] = [];
  let matched = 1;
  const collection = { updateOne: async (...args: unknown[]) => (calls.push(args as unknown as Document), { matchedCount: matched }), insertOne: async () => ({}) };
  const databases = { group: () => ({ collection: () => collection }) };
  const repository = createEntityRepository(databases as never, { open: (db) => db.collection('x') as never, ownedFields: ['name', 'medias', 'placesAvailability'], summary: { name: 1 } });
  const principal = sa;

  it('refuses to write a field it does not own, in an insert and in an update, before touching the database', async () => {
    const access = (await accessFor(sa, groupId))!;
    await assert.rejects(repository.insert(principal, access, { _id: new ObjectId(), name: {}, groupId }), /not an owned field/);
    await assert.rejects(repository.update(principal, access, new ObjectId(), { set: { 'medias.images.main': {}, mystery: 1 }, unset: {}, updateDate: new Date(), readPlaces: undefined }, undefined), /mystery/);
    await assert.rejects(repository.update(principal, access, new ObjectId(), { set: {}, unset: { 'tax.id': '' }, updateDate: new Date(), readPlaces: undefined }, undefined), /tax\.id/);
    assert.equal(calls.length, 0);
  });

  it('writes the owned paths, and requires the date read exactly as it is stored, whatever its type', async () => {
    const access = (await accessFor(sa, groupId))!;
    assert.equal(await repository.update(principal, access, new ObjectId(), { set: { 'medias.images.main': {} }, unset: { medias: '' }, updateDate: new Date(), readPlaces: undefined }, undefined), 'updated');
    assert.equal(calls.length, 1);
    matched = 0;
    assert.equal(await repository.update(principal, access, new ObjectId(), { set: { name: {} }, unset: {}, updateDate: new Date(), readPlaces: undefined }, new Date(0)), 'conflict');
    assert.equal(calls.length, 2);
    matched = 1;
    // A stored value that looks like an operator is compared as a literal; no date and a null date match what is stored.
    for (const odd of [{ $gt: 0 }, 'x', 5, null, undefined]) {
      assert.equal(await repository.update(principal, access, new ObjectId(), { set: { name: {} }, unset: {}, updateDate: new Date(), readPlaces: undefined }, odd), 'updated');
    }
    const filters = calls.map((call) => (call as unknown as Array<Document>)[0]!);
    assert.deepEqual(filters[2]!['updateDate'], { $eq: { $gt: 0 } });
    assert.deepEqual(filters[6]!['updateDate'], { $exists: false });
    assert.deepEqual(filters[5]!['updateDate'], { $eq: null });
    await repository.update(principal, access, new ObjectId(), { set: { placesAvailability: [] }, unset: {}, updateDate: new Date(), readPlaces: undefined }, new Date(0));
    await repository.update(principal, access, new ObjectId(), { set: { placesAvailability: [] }, unset: {}, updateDate: new Date(), readPlaces: [own] }, new Date(0));
    const guards = calls.slice(-2).map((call) => (call as unknown as Array<Document>)[0]!['placesAvailability']);
    assert.deepEqual(guards, [{ $exists: false }, { $eq: [own] }]);
  });
});

/** The collaborators of an entry service that never reach a database. */
function fakes(stored: Document | null, overrides: { update?: 'updated' | 'conflict'; remove?: boolean; language?: string | null } = {}) {
  const log = memoryActivityLog();
  const logs = memoryLogger();
  const written: Document[] = [];
  const repository = {
    list: async () => ({ items: [], page: { limit: 50, next: null } }),
    findById: async () => stored,
    insert: async (_p: unknown, _a: unknown, document: Document) => void written.push(document),
    update: async () => overrides.update ?? 'updated',
    remove: async () => overrides.remove ?? true,
  };
  return {
    log,
    logs,
    written,
    deps: {
      repository,
      references: { missing: async () => [] },
      images: { imageSource: async () => null },
      languages: { of: async () => ['it'] },
      users: { findById: async () => (overrides.language === null ? null : ({ user: { language: overrides.language ?? 'it' } } as never)) },
      activityLog: log,
      logger: logs.logger,
      versionKey: key,
      now: () => Date.now(),
    },
  };
}

describe('the services of the entries, with collaborators that fail in the ways a database can', () => {
  const brand = { _id: new ObjectId(), name: { it: 'Marca' }, description: { it: '' }, placesAvailability: [], medias: { images: {} }, status: true, insertDate: new Date(1000), updateDate: new Date(1000) };
  const version = (document: Document) => entityVersion(document, PRODUCTS_BRANDS_OWNED_FIELDS, key);
  const reject = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

  it('answers 404 when the caller disappeared since the authentication', async () => {
    const { deps } = fakes(brand, { language: null });
    const service = createBrandsService({ ...deps, products: { withBrand: async () => [] } });
    await assert.rejects(service.list(sa, access, {}), reject('NOT_FOUND'));
    await assert.rejects(service.create(sa, access, { name: { it: 'x' } }, client), reject('NOT_FOUND'));
  });

  it('answers 409 when the entry changed or was deleted while the request ran', async () => {
    const service = createBrandsService({ ...fakes(brand, { update: 'conflict' }).deps, products: { withBrand: async () => [] } });
    await assert.rejects(service.update(sa, access, brand._id, version(brand), { enabled: false }, client), reject('CONFLICT'));
    const gone = createBrandsService({ ...fakes(brand, { remove: false }).deps, products: { withBrand: async () => [] } });
    await assert.rejects(gone.remove(sa, access, brand._id, client), reject('CONFLICT'));
    await assert.rejects(createBrandsService({ ...fakes(null).deps, products: { withBrand: async () => [] } }).get(sa, access, brand._id), reject('NOT_FOUND'));
  });

  it('uses the generator of ids it is given', async () => {
    const id = new ObjectId();
    const { deps, written } = fakes(null);
    const service = createBrandsService({ ...deps, products: { withBrand: async () => [] }, newId: () => id });
    const created = await service.create(sa, access, { name: { it: 'x' } }, client);
    assert.equal(created.entity.id, hex(id));
    assert.equal(written[0]!['_id'], id);
    const departments = createDepartmentsService({
      ...fakes(null).deps,
      catalogs: { list: async () => [{ id: 't', rate: 22, department: 1, description: null, vatNature: null }] },
      products: { withDepartmentNumber: async () => [] },
      repository: { ...fakes(null).deps.repository, codes: async () => [], hasOtherActiveWithNumber: async () => false },
      newId: () => id,
    });
    assert.equal((await departments.create(sa, access, { code: 1, name: { it: 'x' }, taxId: 't' }, client)).entity.id, hex(id));
  });

  it('answers 404, 409 and 404 for a group of attributes that disappeared, changed or was deleted meanwhile', async () => {
    const group = { _id: new ObjectId(), name: { it: 'Colori' }, attributes: [{ id: 'a', name: { it: 'Rosso' } }], insertDate: new Date(1), updateDate: new Date(1) };
    const make = (overrides: Parameters<typeof fakes>[1], stored: Document | null = group) => {
      const { deps } = fakes(stored, overrides);
      return createAttributeGroupsService({ repository: deps.repository, products: { withAttributes: async () => [] }, languages: deps.languages, users: deps.users, activityLog: deps.activityLog, versionKey: key, now: deps.now, newAttributeId: () => 'new-id' });
    };
    const tag = entityVersion(group, PRODUCTS_ATTRIBUTES_OWNED_FIELDS, key);
    await assert.rejects(make({ language: null }).list(sa, access, {}), reject('NOT_FOUND'));
    await assert.rejects(make({ language: null }).create(sa, access, { name: { it: 'x' } }, client), reject('NOT_FOUND'));
    await assert.rejects(make({ language: null }).update(sa, access, group._id, tag, { name: { it: 'x' } }, client), reject('NOT_FOUND'));
    await assert.rejects(make({ update: 'conflict' }).update(sa, access, group._id, tag, { name: { it: 'Altro' } }, client), reject('CONFLICT'));
    await assert.rejects(make({ remove: false }).remove(sa, access, group._id, client), reject('CONFLICT'));
    await assert.rejects(make({}, null).get(sa, access, group._id), reject('NOT_FOUND'));
    const id = new ObjectId();
    const { deps } = fakes(null);
    const created = await createAttributeGroupsService({ repository: deps.repository, products: { withAttributes: async () => [] }, languages: deps.languages, users: deps.users, activityLog: deps.activityLog, versionKey: key, now: deps.now, newAttributeId: () => 'x', newId: () => id }).create(sa, access, { name: { it: 'x' } }, client);
    assert.equal(created.entity.id, hex(id));
  });
});

describe('the departments', () => {
  it('reads codes written by this backend, by the legacy and by nobody', () => {
    for (const [raw, expected] of [[5, 5], ['5', 5], [' 05 ', 5], ['abc', null], ['1.5', null], [Number.NaN, null], [1.5, null], [null, null], [undefined, null], [{}, null], ['1234567890', null]] as const) {
      assert.equal(codeOf(raw), expected, String(raw));
    }
    assert.equal(departmentExtra({ code: 3, tax: { id: 'x', value: 22, department: 1, description: 'd', natura: 'N1' }, noDiscount: true }).tax?.description, 'd');
  });

  it('knows whether the group database can be written together with the common one', async () => {
    const calls: string[] = [];
    const databases = { commonCluster: 'cluster0', transaction: async (work: (session: ClientSession) => Promise<unknown>) => (calls.push('transaction'), work({} as ClientSession)) };
    const port = createTaxDepartments(databases as never);
    assert.equal(port.atomic({ clusterId: 'cluster1' } as unknown as GroupAccess), null);
    const atomic = port.atomic(access)!;
    assert.equal(await atomic(async () => 'done'), 'done');
    assert.deepEqual(calls, ['transaction']);
  });
});

describe('the tax rates and the departments that hold a copy of them', () => {
  const rate = { id: 't1', value: 22, department: 1, description: null, natura: null };
  const updateDate = new Date(5000);
  const groupAccess = { ...access, features: {} } as unknown as GroupAccess;

  /** A catalogs service over a fake group document that holds one tax rate, with a port to the departments that records what it is asked. */
  function build(options: { atomic: boolean; apply?: 'updated' | 'conflict' | 'notFound'; usedBy?: string[]; productsUsing?: string[]; realignFails?: boolean; incomplete?: boolean }) {
    const events: string[] = [];
    const entries: Array<Record<string, unknown>> = [];
    const logger = memoryLogger();
    const repository: CatalogsRepository = {
      read: async () => ({ updateDate, size: 100, values: { taxes: [rate] } }),
      apply: async (_id, _changes, _expected, _now, session) => {
        events.push(session === undefined ? 'apply' : 'apply in transaction');
        return options.apply ?? 'updated';
      },
    };
    const service = createCatalogsService({
      catalogs: repository,
      references: { missing: async () => [] },
      activityLog: { record: async (entry: never) => void (events.push('record'), entries.push(entry as Record<string, unknown>)) },
      logger: logger.logger,
      newId: () => 'new',
      now: () => 10_000,
      taxDepartments: {
        usedBy: async () => options.usedBy ?? [],
        productsUsing: async () => options.productsUsing ?? [],
        realign: async (_p, _a, copy, _now, session) => {
          events.push(session === undefined ? 'realign' : 'realign in transaction');
          assert.deepEqual({ ...copy, value: 0 }, { id: 't1', value: 0, department: 1, description: null, natura: null });
          if (options.realignFails === true) {
            throw new Error('database down');
          }
          return options.incomplete === true ? { complete: false, remainingBlocks: 3 } : { complete: true, remainingBlocks: 0 };
        },
        atomic: () => (options.atomic ? async (work) => (events.push('begin'), work({} as ClientSession)) : null),
      },
    });
    return { service, events, logger, entries };
  }

  it('writes the rate and the copies in one transaction and records the change after it', async () => {
    const { service, events } = build({ atomic: true });
    await service.patch(sa, groupAccess, taxes, 't1', { rate: 5 }, client);
    assert.deepEqual(events, ['begin', 'apply in transaction', 'realign in transaction', 'record']);
  });

  it('writes nothing in the departments when the transaction does not write the rate', async () => {
    for (const apply of ['conflict', 'notFound'] as const) {
      const { service, events } = build({ atomic: true, apply });
      await assert.rejects(service.patch(sa, groupAccess, taxes, 't1', { rate: 5 }, client), (error: unknown) => error instanceof AppError && error.code === (apply === 'conflict' ? 'CONFLICT' : 'NOT_FOUND'));
      assert.deepEqual(events, ['begin', 'apply in transaction']);
    }
  });

  it('writes the rate, records it and then realigns the copies when the group is on another cluster, and a failure of the realignment leaves the rate written and logged', async () => {
    const { service, events } = build({ atomic: false });
    await service.patch(sa, groupAccess, taxes, 't1', { rate: 5 }, client);
    assert.deepEqual(events, ['apply', 'record', 'realign']);
    const broken = build({ atomic: false, realignFails: true });
    // The rate is written and logged: the answer says the realignment did not complete, and the failure is logged.
    const failed = (await broken.service.patch(sa, groupAccess, taxes, 't1', { rate: 5 }, client)) as unknown as { realignment: unknown; rate: number };
    assert.deepEqual([failed.rate, failed.realignment], [5, { complete: false, remainingBlocks: null }]);
    assert.deepEqual(broken.events, ['apply', 'record', 'realign', 'record']);
    const trace = broken.entries.find((entry) => entry['action'] === 'group.tax.realignmentIncomplete')!;
    assert.deepEqual([trace['outcome'], trace['category']], ['failure', 'data']);
    assert.deepEqual(trace['metadata'], { taxId: 't1', remainingBlocks: null, skipped: false });
    assert.equal(broken.logger.events.filter((entry) => entry['level'] === 'error').length, 1);
    const partial = build({ atomic: false, incomplete: true });
    assert.deepEqual(((await partial.service.patch(sa, groupAccess, taxes, 't1', { rate: 5 }, client)) as unknown as { realignment: unknown }).realignment, { complete: false, remainingBlocks: 3 });
    // A repeated request that changes nothing goes on with the realignment, and says so too.
    const again = build({ atomic: false, incomplete: true });
    assert.deepEqual(((await again.service.patch(sa, groupAccess, taxes, 't1', { rate: 22 }, client)) as unknown as { realignment: unknown }).realignment, { complete: false, remainingBlocks: 3 });
  });

  it('refuses to delete a tax rate a department holds', async () => {
    const { service, events } = build({ atomic: true, usedBy: ['aa', 'bb'] });
    await assert.rejects(service.remove(sa, groupAccess, taxes, 't1', client), (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && JSON.stringify(error.details) === JSON.stringify([{ field: 'productDepartments.aa', issue: 'referenced' }, { field: 'productDepartments.bb', issue: 'referenced' }]));
    assert.deepEqual(events, []);
  });

  it('refuses to delete a tax rate a price of a product holds, once the departments do not', async () => {
    const { service, events } = build({ atomic: true, productsUsing: ['cc'] });
    await assert.rejects(service.remove(sa, groupAccess, taxes, 't1', client), (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && JSON.stringify(error.details) === JSON.stringify([{ field: 'products.cc', issue: 'referenced' }]));
    assert.deepEqual(events, []);
  });
});

describe('the code of a department without a unique index', () => {
  const smaller = new ObjectId('000000000000000000000001');
  const larger = new ObjectId('ffffffffffffffffffffffff');
  const reject = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
  const tax = { id: 't', rate: 22, department: 1, description: null, vatNature: null };
  const NOW = new Date(5000);
  const entry = (id: ObjectId, code: unknown, updateDate: unknown) => ({ id, code, updateDate });

  /** A departments service whose code list says what the test wants on each read; it records the writes and what is logged as an error. */
  function build(stored: Document | null, reads: Array<Array<{ id: ObjectId; code: unknown; updateDate: unknown }>>, undo: 'updated' | 'conflict' | 'gone' = 'updated') {
    const base = fakes(stored);
    const writes: string[] = [];
    let read = 0;
    const repository = {
      ...base.deps.repository,
      remove: async () => (writes.push('remove'), undo !== 'gone'),
      update: async (_p: unknown, _a: unknown, _id: ObjectId, change: { set: Document; unset: Document }) => (writes.push(JSON.stringify([change.set, change.unset])), writes.length === 1 && stored !== null ? ('updated' as const) : undo === 'conflict' ? ('conflict' as const) : ('updated' as const)),
      codes: async () => reads[Math.min(read++, reads.length - 1)]!,
      hasOtherActiveWithNumber: async () => false,
    };
    const service = createDepartmentsService({ ...base.deps, now: () => NOW.getTime(), repository, catalogs: { list: async () => [tax] }, products: { withDepartmentNumber: async () => [] } });
    return { service, writes, errors: () => base.logs.events.filter((event) => event['level'] === 'error') };
  }

  it('undoes its creation when another department with the same code was written before it: an older date, or the same date and a smaller id', async () => {
    for (const other of [entry(larger, '7', new Date(1)), entry(smaller, 7, NOW), entry(smaller, 7, 'not a date')]) {
      const { service, writes } = build(null, [[], [other]]);
      await assert.rejects(service.create(sa, access, { code: 7, name: { it: 'x' }, taxId: 't' }, client), reject('CONFLICT'));
      assert.deepEqual(writes, ['remove']);
    }
    // A more recent date, the same date and a larger id, or no other department lets the creation stand.
    for (const other of [entry(smaller, 7, new Date(9000)), entry(larger, 7, NOW), entry(smaller, 8, new Date(1))]) {
      const kept = build(null, [[], [other]]);
      assert.equal((await kept.service.create(sa, access, { code: 7, name: { it: 'x' }, taxId: 't' }, client)).entity.code, 7);
      assert.deepEqual(kept.writes, []);
    }
  });

  it('reports a creation that cannot be undone and still answers 409', async () => {
    const { service, errors } = build(null, [[], [entry(smaller, 7, new Date(1))]], 'gone');
    await assert.rejects(service.create(sa, access, { code: 7, name: { it: 'x' }, taxId: 't' }, client), reject('CONFLICT'));
    assert.equal(errors().length, 1);
  });

  it('undoes the whole modification, not only the code, when the change loses the race, and reports an undo that fails', async () => {
    const make = (code: unknown): Document => ({ _id: new ObjectId(), ...(code === undefined ? {} : { code }), tax: { id: 't', value: 22, department: 1, description: null, natura: null }, name: { it: 'x' }, status: true, noDiscount: false, insertDate: new Date(1), updateDate: new Date(1) });
    for (const previous of [5, undefined]) {
      const doc = make(previous);
      const { service, writes, errors } = build(doc, [[], [entry(smaller, 7, new Date(0))]]);
      await assert.rejects(service.update(sa, access, doc['_id'] as ObjectId, entityVersion(doc, PRODUCTS_DEPARTMENTS_OWNED_FIELDS, key), { code: 7, enabled: false, noDiscount: true }, client), reject('CONFLICT'));
      const [restoreSet, restoreUnset] = JSON.parse(writes.at(-1)!) as [Document, Document];
      assert.deepEqual(restoreSet, { status: true, noDiscount: false, ...(previous === undefined ? {} : { code: 5 }) });
      assert.deepEqual(restoreUnset, previous === undefined ? { code: '' } : {});
      assert.equal(errors().length, 0);
    }
    const doc = make(5);
    const failed = build(doc, [[], [entry(smaller, 7, new Date(0))]], 'conflict');
    await assert.rejects(failed.service.update(sa, access, doc['_id'] as ObjectId, entityVersion(doc, PRODUCTS_DEPARTMENTS_OWNED_FIELDS, key), { code: 7, enabled: false }, client), reject('CONFLICT'));
    assert.equal(failed.errors().length, 1);
    // A change that does not touch the code is never judged, whatever else has the code.
    const same = make(5);
    const { service, writes } = build(same, [[entry(smaller, 5, new Date(0))]]);
    await service.update(sa, access, same['_id'] as ObjectId, entityVersion(same, PRODUCTS_DEPARTMENTS_OWNED_FIELDS, key), { enabled: false, code: 5 }, client);
    assert.equal(writes.length, 1);
  });

  it('refuses explicitly to check a code against a part of the departments of a group', async () => {
    const accessOf = (await accessFor(sa, groupId))!;
    const databases = { group: () => ({ collection: () => ({ find: () => ({ toArray: async () => Array.from({ length: MAX_DEPARTMENTS_READ + 1 }, () => ({ _id: new ObjectId(), code: 1 })) }) }) }) };
    await assert.rejects(createDepartmentsRepository(databases as never).codes(sa, accessOf), /more than 1000 departments/);
  });
});

describe('the groups of attributes of a company or place administrator', () => {
  it('are read only: every write is refused before anything is read, and the group says so', async () => {
    const group = { _id: new ObjectId(), name: { it: 'Colori' }, attributes: [], updateDate: new Date(1) };
    const { deps } = fakes(group);
    const service = createAttributeGroupsService({ repository: deps.repository, products: { withAttributes: async () => [] }, languages: deps.languages, users: deps.users, activityLog: deps.activityLog, versionKey: key, now: deps.now, newAttributeId: () => 'x' });
    const refused = (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN';
    await assert.rejects(service.create(ca, access, { name: { it: 'x' } }, client), refused);
    await assert.rejects(service.update(ca, access, group._id, 'x'.repeat(43), { name: { it: 'y' } }, client), refused);
    await assert.rejects(service.remove(ca, access, group._id, client), refused);
    assert.equal((await service.get(ca, access, group._id)).entity.editable, false);
    assert.equal((await service.get(sa, access, group._id)).entity.editable, true);
  });
});
