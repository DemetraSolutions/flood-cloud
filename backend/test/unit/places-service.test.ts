import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createPlacesService } from '../../src/modules/places/places.service.ts';
import type { PlacesService } from '../../src/modules/places/places.service.ts';
import type { PlacesRepository } from '../../src/modules/places/places.repository.ts';
import type { PlacePatch } from '../../src/modules/places/place.types.ts';
import type { CompaniesPlacesWriter, CompanyOfPlace, WriteOutcome } from '../../src/shared/legacy-write/companies-places.writer.ts';
import { CrossClusterWriteError, MalformedDocumentError } from '../../src/shared/legacy-write/errors.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { PRICE_LIST, fullLegacyPlace } from '../helpers/place-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

const GROUP = fixtureId('group', 1);
const COMPANY = fixtureId('company', 1);
const ID = fixtureId('place', 1);
const access = { groupId: GROUP, clusterId: 'cluster0', crossGroup: false, features: {} } as unknown as GroupAccess;
const client = { requestId: 'r', ip: null, userAgent: null };
const document = (overrides: Document = {}): Document => fullLegacyPlace(1, GROUP, COMPANY, { countryCode: 'DE', countryAreaCode: '', ...overrides });
const versionOfDocument = (overrides: Document = {}): string => versionOf('places', document(overrides), TEST_VERSION_KEY);
const CREATION = { name: 'x', companyId: COMPANY.toHexString(), address: { street: 's', postcode: 'p', city: 'c', country: 'DE' } };

/** What every refusal of the write service becomes: the code, and the details when it has any. */
const REFUSED = {
  notFound: ['NOT_FOUND', undefined],
  conflict: ['PRECONDITION_FAILED', undefined],
  companyNotFound: ['VALIDATION_ERROR', [{ field: 'companyId', issue: 'incorrect' }]],
  notTrashed: ['CONFLICT', undefined],
  trashed: ['CONFLICT', undefined],
  busy: ['CONFLICT', [{ field: 'devices.items', issue: 'busy' }]],
} as const;
const refused = (outcome: WriteOutcome, overrides: Partial<Record<string, readonly [string, unknown]>> = {}) => (error: unknown) => {
  const [code, details] = overrides[outcome.outcome] ?? REFUSED[outcome.outcome as keyof typeof REFUSED];
  return error instanceof AppError && error.code === code && JSON.stringify(error.details) === JSON.stringify(details);
};

interface Script {
  readonly reads?: Array<Document | null>;
  readonly outcome?: WriteOutcome | Error;
  readonly company?: CompanyOfPlace | null;
}

/** A write service whose reads and writes are scripted. */
function writerOf(script: Script): { writer: CompaniesPlacesWriter; writes: string[]; companyReads: ObjectId[] } {
  const reads = [...(script.reads ?? [document()])];
  const writes: string[] = [];
  const companyReads: ObjectId[] = [];
  const answer = async (name: string): Promise<WriteOutcome> => {
    writes.push(name);
    if (script.outcome instanceof Error) {
      throw script.outcome;
    }
    return script.outcome ?? (name === 'delete' ? { outcome: 'deleted', id: ID } : { outcome: 'written', id: ID, version: 'v' });
  };
  const writer = {
    read: async () => {
      const next = reads.length > 1 ? reads.shift()! : reads[0]!;
      return next === null ? null : { document: next, version: versionOf('places', next, TEST_VERSION_KEY) };
    },
    companyOfPlace: async (id: ObjectId) => {
      companyReads.push(id);
      return script.company === undefined ? { trashed: false, invoiceSeries: ['FE'], series: [{ name: 'FE', cash: true }] } : script.company;
    },
    createPlace: () => answer('create'),
    updatePlace: () => answer('update'),
    trash: () => answer('trash'),
    restore: () => answer('restore'),
    deleteTrashed: () => answer('delete'),
    duplicatePlace: () => answer('duplicate'),
  } as unknown as CompaniesPlacesWriter;
  return { writer, writes, companyReads };
}

/** What the places service asked the store keys to revoke, in order: `[groupId, placeId, reason]`. */
const revoked: unknown[][] = [];
let revokeFails = false;
const logs = memoryLogger();

function serviceOf(writer: CompaniesPlacesWriter, overrides: Partial<PlacesRepository> = {}): { service: PlacesService; activity: ReturnType<typeof memoryActivityLog> } {
  const activity = memoryActivityLog();
  const repository: PlacesRepository = {
    list: async () => ({ items: [], page: { limit: 50, next: null } }),
    hasUsers: async () => false,
    missingTemplates: async () => new Set<number>(),
    missingUsers: async () => new Set<number>(),
    groupLanguages: async () => new Set(['it']),
    findCountry: async () => ({ code: 'DE', areas: null }),
    groupLists: async () => ({ currencies: new Set(['EUR']), priceLists: new Set([PRICE_LIST, 'pl2']), taxes: new Set(['tax1']), favorites: new Map([['fav1', 'Preferiti']]) }),
    ...overrides,
  };
  return { service: createPlacesService({ repository, writerFor: () => writer, activityLog: activity, references: { missing: async () => [] }, images: { logoSource: async () => null }, readerFor: () => writer, logger: logs.logger, storeKeys: { revokeForPlace: async (...args) => { if (revokeFails) { throw new Error('mongo down'); } revoked.push(args); } }, newId: () => 'generated1' }), activity };
}

const psa = (): AuthPrincipal => principalOf('PSA');
const sa = (): AuthPrincipal => principalOf('SA');
const ca = (): AuthPrincipal => principalOf('CA', { companyIds: [COMPANY] });
const pa = (): AuthPrincipal => principalOf('PA', { placeIds: [ID] });
const details = (...list: Array<[string, string]>) => (error: unknown) => error instanceof AppError && JSON.stringify(error.details) === JSON.stringify(list.map(([field, issue]) => ({ field, issue })));

describe('places service: what the write service answers', () => {
  const refusals: WriteOutcome[] = [{ outcome: 'notFound' }, { outcome: 'conflict' }, { outcome: 'companyNotFound' }, { outcome: 'notTrashed' }, { outcome: 'trashed' }, { outcome: 'busy' }];

  it('turns every refusal into its error, for every write', async () => {
    for (const outcome of refusals) {
      const { service } = serviceOf(writerOf({ outcome }).writer);
      await assert.rejects(() => service.create(psa(), access, CREATION as never, client), refused(outcome), `create ${outcome.outcome}`);
      await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), { name: 'New' }, client), refused(outcome), `update ${outcome.outcome}`);
      await assert.rejects(() => service.trash(psa(), access, ID, versionOfDocument(), client), refused(outcome), `trash ${outcome.outcome}`);
      const trashed = serviceOf(writerOf({ outcome, reads: [document({ trash: true })] }).writer).service;
      await assert.rejects(() => trashed.restore(psa(), access, ID, versionOfDocument({ trash: true }), client), refused(outcome), `restore ${outcome.outcome}`);
      await assert.rejects(() => trashed.remove(psa(), access, ID, versionOfDocument({ trash: true }), client), refused(outcome), `remove ${outcome.outcome}`);
      // A duplication whose company is wrong is a conflict, not a validation error: the request has no company.
      await assert.rejects(() => service.duplicate(psa(), access, ID, client), refused(outcome, { companyNotFound: ['CONFLICT', [{ field: 'companyId', issue: 'incorrect' }]] }), `duplicate ${outcome.outcome}`);
    }
  });

  it('lets a failure that is not a refusal go to the central handler, a group on another cluster included', async () => {
    const cross = new CrossClusterWriteError(GROUP, 'cluster1', 'cluster0');
    const { service } = serviceOf(writerOf({ outcome: cross }).writer);
    await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), { name: 'x' }, client), (error: unknown) => error === cross);
    await assert.rejects(() => service.create(psa(), access, CREATION as never, client), (error: unknown) => error === cross);
    await assert.rejects(() => service.trash(psa(), access, ID, versionOfDocument(), client), (error: unknown) => error === cross);
    await assert.rejects(() => service.duplicate(psa(), access, ID, client), (error: unknown) => error === cross);
  });

  it('answers 409 with a message when the stored place has a block that is not an object', async () => {
    const { service } = serviceOf(writerOf({ outcome: new MalformedDocumentError('platform') }).writer);
    await assert.rejects(
      () => service.update(psa(), access, ID, versionOfDocument(), { dealerSettings: { sentry: false } }, client),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && error.message.includes('block') && !error.message.includes('platform'),
    );
  });

  it('answers 404 when the place disappears between the write and the read that follows it, with the write already in the log', async () => {
    const { service, activity } = serviceOf(writerOf({ reads: [document(), null] }).writer);
    await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), { name: 'x' }, client), refused({ outcome: 'notFound' }));
    assert.deepEqual(activity.entries.map((entry) => entry.action), ['place.updated']);
    const created = serviceOf(writerOf({ reads: [null] }).writer).service;
    await assert.rejects(() => created.trash(psa(), access, ID, versionOfDocument(), client), refused({ outcome: 'notFound' }));
    await assert.rejects(() => created.get(psa(), access, ID), refused({ outcome: 'notFound' }));
  });

  it('writes the log of every operation: created, updated, trashed, restored, deleted and duplicated', async () => {
    revoked.length = 0;
    const live = serviceOf(writerOf({}).writer);
    await live.service.create(psa(), access, CREATION as never, client);
    await live.service.update(psa(), access, ID, versionOfDocument(), { name: 'New' }, client);
    await live.service.trash(psa(), access, ID, versionOfDocument(), client);
    await live.service.duplicate(psa(), access, ID, { ...client, ip: '203.0.113.1' });
    assert.deepEqual(live.activity.entries.map((entry) => entry.action), ['place.created', 'place.updated', 'place.trashed', 'place.duplicated']);
    assert.equal(live.activity.entries.at(-1)!.ip, '203.0.113.1');
    const trashed = serviceOf(writerOf({ reads: [document({ trash: true })] }).writer);
    await trashed.service.restore(psa(), access, ID, versionOfDocument({ trash: true }), client);
    await trashed.service.remove(psa(), access, ID, versionOfDocument({ trash: true }), client);
    assert.deepEqual(trashed.activity.entries.map((entry) => entry.action), ['place.restored', 'place.deleted']);
    // The store key ends with the trash and with the deletion, and only then: a restored place gets none back.
    assert.deepEqual(revoked.map(([, placeId, reason]) => [placeId, reason]), [[ID, 'placeTrashed'], [ID, 'placeDeleted']]);
  });

  it('keeps the outcome of a trash and of a deletion that were committed when the revocation of the key fails: the data event is there and the failure is logged', async () => {
    revokeFails = true;
    try {
      logs.events.length = 0;
      const live = serviceOf(writerOf({}).writer);
      assert.equal((await live.service.trash(psa(), access, ID, versionOfDocument(), client)).place.id, ID.toHexString());
      const trashed = serviceOf(writerOf({ reads: [document({ trash: true })] }).writer);
      await trashed.service.remove(psa(), access, ID, versionOfDocument({ trash: true }), client);
      assert.deepEqual(live.activity.entries.map((entry) => entry.action), ['place.trashed']);
      assert.deepEqual(trashed.activity.entries.map((entry) => entry.action), ['place.deleted']);
      assert.deepEqual(logs.events.map((event) => [event['msg'], event['reason']]), [['revoking the store key of a place failed', 'placeTrashed'], ['revoking the store key of a place failed', 'placeDeleted']]);
    } finally {
      revokeFails = false;
    }
  });

  it('does not revoke the store key of a place whose trash or deletion was refused', async () => {
    revoked.length = 0;
    const { service } = serviceOf(writerOf({ outcome: { outcome: 'conflict' } }).writer);
    await assert.rejects(() => service.trash(psa(), access, ID, versionOfDocument(), client));
    assert.deepEqual(revoked, []);
  });
});

describe('places service: the invoice series of the company of a place', () => {
  it('gives the series with their cash flag, and [] for a place without a company or whose company is gone', async () => {
    assert.deepEqual(await serviceOf(writerOf({}).writer).service.invoiceSeries(pa(), access, ID), [{ name: 'FE', cash: true }]);
    assert.deepEqual(await serviceOf(writerOf({ reads: [document({ companyId: null })] }).writer).service.invoiceSeries(pa(), access, ID), []);
    assert.deepEqual(await serviceOf(writerOf({ company: null }).writer).service.invoiceSeries(pa(), access, ID), []);
  });
});

describe('places service: the perimeter and the roles', () => {
  it('is 404 for a place the writer does not hand over, on every operation, and nothing is written', async () => {
    const { writer, writes } = writerOf({ reads: [null] });
    const { service } = serviceOf(writer);
    await assert.rejects(() => service.get(pa(), access, ID), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.update(pa(), access, ID, 'v', { name: 'x' }, client), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.trash(pa(), access, ID, 'v', client), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.restore(pa(), access, ID, 'v', client), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.remove(pa(), access, ID, 'v', client), refused({ outcome: 'notFound' }));
    assert.deepEqual(writes, []);
  });

  it('refuses the duplication to every role but the PSA and the dealers, before the write service', async () => {
    const { writer, writes } = writerOf({});
    const { service } = serviceOf(writer);
    for (const principal of [sa(), ca(), pa(), principalOf('E')]) {
      await assert.rejects(() => service.duplicate(principal, access, ID, client), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
    }
    assert.deepEqual(writes, []);
    await service.duplicate(principalOf('D', { dealerGroupIds: [GROUP] }), access, ID, client);
    assert.deepEqual(writes, ['duplicate']);
  });

  it('refuses an empty modification, and writes nothing for one that changes nothing', async () => {
    const { writer, writes } = writerOf({});
    const { service } = serviceOf(writer);
    await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), {}, client), details(['(body)', 'required']));
    await assert.rejects(() => service.update(psa(), access, ID, 'stale', { name: 'x' }, client), refused({ outcome: 'conflict' }));
    const same = await service.update(psa(), access, ID, versionOfDocument(), { name: 'Bar Roma', openingHours: { timezone: 'Europe/Rome' } }, client);
    assert.equal(same.place.name, 'Bar Roma');
    assert.deepEqual(writes, []);
  });

  it('refuses to delete a place that is not in the trash, that a user refers to, or whose version is not the stored one', async () => {
    const { writer, writes } = writerOf({ reads: [document({ trash: true })] });
    const { service } = serviceOf(writer, { hasUsers: async () => true });
    await assert.rejects(() => service.remove(psa(), access, ID, versionOfDocument({ trash: true }), client), details(['users', 'referenced']));
    await assert.rejects(() => service.remove(psa(), access, ID, 'stale', client), refused({ outcome: 'conflict' }));
    const live = serviceOf(writerOf({}).writer).service;
    await assert.rejects(() => live.remove(psa(), access, ID, versionOfDocument(), client), refused({ outcome: 'notTrashed' }));
    assert.deepEqual(writes, []);
  });
});

describe('places service: the rules on the data', () => {
  interface Run {
    readonly principal?: AuthPrincipal;
    /** Fields of the stored document. */
    readonly overrides?: Document;
    readonly script?: Script;
    readonly repository?: Partial<PlacesRepository>;
  }
  /** Runs a modification of the stored place `overrides` describes, with the scripted collaborators. */
  const run = (patch: PlacePatch, options: Run = {}) => {
    const { principal = psa(), overrides = {}, script = {}, repository = {} } = options;
    const scripted = writerOf({ reads: [document(overrides)], ...script });
    const { service } = serviceOf(scripted.writer, repository);
    return { result: () => service.update(principal, access, ID, versionOfDocument(overrides), patch, client), ...scripted };
  };
  const dealer = (): AuthPrincipal => principalOf('D', { dealerGroupIds: [GROUP] });

  it('takes a group that has no lists as a group that offers nothing', async () => {
    const repository = { groupLists: async () => null };
    await assert.rejects(run({ priceListId: 'pl2' }, { repository }).result, details(['priceListId', 'incorrect']));
    await assert.rejects(run({ priceLists: [{ id: 'x', allYouCanEat: false, ayceCode1: null, ayceCode2: null }] }, { repository }).result, details(['priceLists.0.id', 'incorrect']));
  });

  it('does not ask for the lists when nothing in the request needs them', async () => {
    let reads = 0;
    await run({ name: 'Other', priceListId: PRICE_LIST, ecommercePriceListId: null }, { repository: { groupLists: async () => (++reads, null) } }).result();
    assert.equal(reads, 0);
  });

  it('judges the invoice series of a place that has no company as an error, and asks for the company of the place when the company is not in the request', async () => {
    const bare = run({ invoiceSeries: 'FE' }, { principal: pa(), overrides: { companyId: undefined, invoicePS: null } });
    await assert.rejects(bare.result, details(['invoiceSeries', 'incorrect']));
    assert.deepEqual(bare.companyReads, []);
    const asked = run({ invoiceSeries: 'FE', name: 'x' }, { principal: pa(), overrides: { invoicePS: null } });
    await asked.result();
    assert.deepEqual(asked.companyReads, [COMPANY]);
    await assert.rejects(run({ invoiceSeries: 'FE' }, { principal: pa(), overrides: { invoicePS: null }, script: { company: null } }).result, details(['invoiceSeries', 'incorrect']));
    await assert.rejects(run({ invoiceSeries: false }, { principal: pa() }).result, details(['invoiceSeries', 'incorrect']));
  });

  it('judges the company only where it changes, and as a company of the group that is in the perimeter and not in the trash', async () => {
    const other = fixtureId('company', 2).toHexString();
    await assert.rejects(run({ companyId: other }, { script: { company: { trashed: true, invoiceSeries: [], series: [] } } }).result, details(['companyId', 'incorrect']));
    await assert.rejects(run({ companyId: other }, { script: { company: null } }).result, details(['companyId', 'incorrect']));
    const outside = run({ companyId: other }, { principal: ca() });
    await assert.rejects(outside.result, details(['companyId', 'incorrect']));
    assert.deepEqual(outside.companyReads, []);
    const same = run({ companyId: COMPANY.toHexString(), name: 'x' }, { principal: ca() });
    await same.result();
    assert.deepEqual(same.companyReads, []);
  });

  it('lets the province of a place that has no country be changed without asking for a country', async () => {
    let asked = 0;
    const repository = { findCountry: async () => (++asked, null) };
    await run({ address: { province: 'MI' } }, { overrides: { countryCode: undefined }, repository }).result();
    assert.equal(asked, 0);
  });

  it('reads the series of the new company on a creation', async () => {
    const { writer, companyReads } = writerOf({});
    const { service } = serviceOf(writer);
    await service.create(psa(), access, { ...CREATION, invoiceSeries: 'FE' } as never, client);
    assert.deepEqual(companyReads, [COMPANY]);
  });

  it('refuses a plan that is not one of the five, a time zone and times that are not valid, only where they change', async () => {
    await assert.rejects(run({ license: { plan: 'nope' } }).result, details(['license.plan', 'incorrect']));
    await run({ license: { plan: 'advanced' } }).result();
    await assert.rejects(run({ openingHours: { timezone: 'Nowhere/City' } }).result, details(['openingHours.timezone', 'incorrect']));
    await run({ openingHours: { timezone: 'UTC' } }).result();
    await run({ openingHours: { timezone: 'Europe/Rome' } }).result();
    await assert.rejects(
      run({ openingHours: { special: { '2026-02-30': { closed: true, values: [{ start: '9', end: '10' }] } } } }).result,
      details(['openingHours.special.2026-02-30', 'format'], ['openingHours.special.2026-02-30.values.0.start', 'format'], ['openingHours.special.2026-02-30.values.0.end', 'format']),
    );
    // The special day the place already has is not judged again.
    await run({ openingHours: { special: { '2026-12-25': { closed: true, values: [] } } } }).result();
  });

  it('refuses the fields of the license to the roles that may not change them, by name', async () => {
    await assert.rejects(run({ license: { status: 'disabled' } }, { principal: ca() }).result, details(['license.status', 'notAllowed']));
    await assert.rejects(run({ license: { plan: 'basic' }, dealerSettings: { sentry: false } }, { principal: dealer() }).result, details(['license.plan', 'notAllowed'], ['dealerSettings.sentry', 'notAllowed']));
    await run({ license: { status: 'disabled', expirationDate: null } }, { principal: dealer() }).result();
    const { service } = serviceOf(writerOf({}).writer);
    await assert.rejects(() => service.create(sa(), access, { ...CREATION, license: { plan: 'advanced' } } as never, client), details(['license.plan', 'notAllowed']));
    await service.create(dealer(), access, { ...CREATION, license: { plan: 'advanced' } } as never, client);
    await assert.rejects(() => service.create(dealer(), access, { ...CREATION, license: { plan: 'desk-secondary' } } as never, client), details(['license.plan', 'notAllowed']));
    await service.create(psa(), access, { ...CREATION, license: { plan: 'desk-secondary' } } as never, client);
  });
});
