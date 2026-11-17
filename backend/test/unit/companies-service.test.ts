import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCompaniesService } from '../../src/modules/companies/companies.service.ts';
import type { CompaniesService } from '../../src/modules/companies/companies.service.ts';
import type { CompaniesRepository } from '../../src/modules/companies/companies.repository.ts';
import type { CompanyPatch } from '../../src/modules/companies/company.types.ts';
import type { CompaniesPlacesWriter, WriteOutcome } from '../../src/shared/legacy-write/companies-places.writer.ts';
import { CrossClusterWriteError, MalformedDocumentError } from '../../src/shared/legacy-write/errors.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { fullLegacyCompany } from '../helpers/company-fixtures.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

const GROUP = fixtureId('group', 1);
const ID = fixtureId('company', 1);
const access = { groupId: GROUP, clusterId: 'cluster0', crossGroup: false, features: {} } as unknown as GroupAccess;
const client = { requestId: 'r', ip: null, userAgent: null };
const document = (): Document => fullLegacyCompany(1, GROUP, { countryCode: 'DE', countryAreaCode: '' });
const refused = (outcome: WriteOutcome) => (error: unknown) => error instanceof AppError && error.code === REFUSED[outcome.outcome as keyof typeof REFUSED];
const REFUSED = { notFound: 'NOT_FOUND', companyNotFound: 'NOT_FOUND', conflict: 'PRECONDITION_FAILED', notTrashed: 'CONFLICT', vatNumberTaken: 'CONFLICT', referenced: 'CONFLICT' } as const;

/** A write service whose reads and writes are scripted. */
function writerOf(script: { reads?: Array<Document | null>; outcome?: WriteOutcome | Error }): { writer: CompaniesPlacesWriter; writes: string[] } {
  const reads = [...(script.reads ?? [document()])];
  const writes: string[] = [];
  const answer = async (name: string): Promise<WriteOutcome> => {
    writes.push(name);
    if (script.outcome instanceof Error) {
      throw script.outcome;
    }
    return script.outcome ?? { outcome: 'written', id: ID, version: 'v' };
  };
  const writer = {
    read: async () => {
      const next = reads.length > 1 ? reads.shift()! : reads[0]!;
      return next === null ? null : { document: next, version: versionOf('companies', next, TEST_VERSION_KEY) };
    },
    createCompany: () => answer('create'),
    updateCompany: () => answer('update'),
    trash: () => answer('trash'),
    restore: () => answer('restore'),
    deleteTrashed: () => answer('delete'),
  } as unknown as CompaniesPlacesWriter;
  return { writer, writes };
}

function serviceOf(writer: CompaniesPlacesWriter, overrides: Partial<CompaniesRepository> = {}): { service: CompaniesService; activity: ReturnType<typeof memoryActivityLog> } {
  const activity = memoryActivityLog();
  const repository: CompaniesRepository = {
    list: async () => ({ items: [], page: { limit: 50, next: null } }),
    trashedIds: async () => [],
    countTrashed: async () => 0,
    findCountry: async () => ({ code: 'DE', areas: null }),
    isDealer: async () => true,
    listDealers: async () => [],
    groupLists: async () => ({ currencies: new Set(['EUR', 'USD']), priceLists: new Set(['pl1']), taxes: new Set(), favorites: new Map() }),
    ...overrides,
  };
  return { service: createCompaniesService({ repository, writerFor: () => writer, images: { logoSource: async () => null }, activityLog: activity, newId: () => 'a'.repeat(24) }), activity };
}

const psa = (): AuthPrincipal => principalOf('PSA');
const versionOfDocument = (): string => versionOf('companies', document(), TEST_VERSION_KEY);

describe('companies service: what the write service answers', () => {
  const refusals: WriteOutcome[] = [{ outcome: 'notFound' }, { outcome: 'conflict' }, { outcome: 'companyNotFound' }, { outcome: 'notTrashed' }, { outcome: 'vatNumberTaken' }, { outcome: 'referenced' }];
  it('turns every refusal into its error, for every write', async () => {
    for (const outcome of refusals) {
      const { writer } = writerOf({ outcome });
      const { service } = serviceOf(writer);
      const patch: CompanyPatch = { name: 'New' };
      await assert.rejects(() => service.create(psa(), access, { name: 'x', vatNumber: '01114601006', address: { street: 's', postcode: 'p', city: 'c', country: 'DE' } } as never, client), refused(outcome), `create ${outcome.outcome}`);
      await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), patch, client), refused(outcome), `update ${outcome.outcome}`);
      await assert.rejects(() => service.trash(psa(), access, ID, versionOfDocument(), client), refused(outcome), `trash ${outcome.outcome}`);
      await assert.rejects(() => service.remove(psa(), access, ID, versionOfDocument(), client), refused(outcome), `remove ${outcome.outcome}`);
    }
    const { service } = serviceOf(writerOf({ outcome: { outcome: 'conflict' }, reads: [{ ...document(), trash: true }] }).writer);
    await assert.rejects(() => service.restore(psa(), access, ID, versionOf('companies', { ...document(), trash: true }, TEST_VERSION_KEY), client), refused({ outcome: 'conflict' }));
  });

  it('gives the details of a taken VAT number and of a referenced company', async () => {
    const { service } = serviceOf(writerOf({ outcome: { outcome: 'vatNumberTaken' } }).writer);
    await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), { vatNumber: 'DE1234' }, client), (error: unknown) => error instanceof AppError && JSON.stringify(error.details) === JSON.stringify([{ field: 'vatNumber', issue: 'taken' }]));
    const referenced = serviceOf(writerOf({ outcome: { outcome: 'referenced' } }).writer).service;
    await assert.rejects(() => referenced.remove(psa(), access, ID, 'v', client), (error: unknown) => error instanceof AppError && JSON.stringify(error.details) === JSON.stringify([{ field: 'places', issue: 'referenced' }]));
  });

  it('lets a failure that is not a refusal go to the central handler, a group on another cluster included', async () => {
    const cross = new CrossClusterWriteError(GROUP, 'cluster1', 'cluster0');
    const { service } = serviceOf(writerOf({ outcome: cross }).writer);
    await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), { name: 'x' }, client), (error: unknown) => error === cross);
    await assert.rejects(() => service.create(psa(), access, { name: 'x', vatNumber: '01114601006', address: { street: 's', postcode: 'p', city: 'c', country: 'DE' } } as never, client), (error: unknown) => error === cross);
    await assert.rejects(() => service.trash(psa(), access, ID, versionOfDocument(), client), (error: unknown) => error === cross);
    await assert.rejects(() => service.remove(psa(), access, ID, versionOfDocument(), client), (error: unknown) => error === cross);
  });

  it('answers 409 with a message when the stored company has a block that is not an object', async () => {
    const { service } = serviceOf(writerOf({ outcome: new MalformedDocumentError('settings') }).writer);
    await assert.rejects(
      () => service.update(psa(), access, ID, versionOfDocument(), { customerApp: { enableLoginSignup: false } }, client),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && error.message.includes('block') && !error.message.includes('settings'),
    );
  });

  it('answers 404 when the company disappears between the write and the read that follows it', async () => {
    const { service, activity } = serviceOf(writerOf({ reads: [document(), null] }).writer);
    await assert.rejects(() => service.update(psa(), access, ID, versionOfDocument(), { name: 'x' }, client), refused({ outcome: 'notFound' }));
    // The write happened, and its entry is recorded before the read: nothing is lost from the audit.
    assert.deepEqual(activity.entries.map((entry) => entry.action), ['company.updated']);
    const created = serviceOf(writerOf({ reads: [null] }).writer).service;
    await assert.rejects(() => created.trash(psa(), access, ID, versionOfDocument(), client), refused({ outcome: 'notFound' }));
  });
});

describe('companies service: the perimeter', () => {
  const ca = (companyId: ObjectId): AuthPrincipal => principalOf('CA', { companyIds: [companyId] });
  it('is 404 for a company outside the perimeter on every operation, before the document is read', async () => {
    const { writer, writes } = writerOf({});
    const { service } = serviceOf(writer);
    const other = ca(fixtureId('company', 2));
    await assert.rejects(() => service.get(other, access, ID), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.update(other, access, ID, 'v', { name: 'x' }, client), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.trash(other, access, ID, 'v', client), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.restore(other, access, ID, 'v', client), refused({ outcome: 'notFound' }));
    await assert.rejects(() => service.remove(other, access, ID, 'v', client), refused({ outcome: 'notFound' }));
    assert.deepEqual(writes, []);
    assert.equal((await service.get(ca(ID), access, ID)).company.id, ID.toHexString());
  });

  it('takes a group that has no lists as a group that offers nothing', async () => {
    const { service } = serviceOf(writerOf({}).writer, { groupLists: async () => null });
    await assert.rejects(
      () => service.update(psa(), access, ID, versionOfDocument(), { currency: 'USD' }, client),
      (error: unknown) => error instanceof AppError && JSON.stringify(error.details) === JSON.stringify([{ field: 'currency', issue: 'incorrect' }]),
    );
  });
});
