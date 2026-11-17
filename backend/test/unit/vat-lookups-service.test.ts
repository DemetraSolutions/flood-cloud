import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CervedError } from '../../src/integrations/cerved/index.ts';
import type { CervedClient, CervedCompany } from '../../src/integrations/cerved/index.ts';
import type { ActivityEntry } from '../../src/shared/activity-log/activity-log.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { toVatLookupResult } from '../../src/modules/vat-lookups/vat-lookups.mapper.ts';
import { createVatLookupsService } from '../../src/modules/vat-lookups/vat-lookups.service.ts';
import { principalOf } from '../helpers/principal.ts';

const VAT = '12345678903';
const COMPANY: CervedCompany = { subjectId: '42', vatNumber: VAT, name: 'ROSSI SRL', fiscalCode: VAT, street: 'VIA ROMA 1', postcode: '20100', city: 'MILANO', province: 'mi' };
const client = { requestId: 'r1', ip: '203.0.113.9', userAgent: null };

function setup(cerved: Partial<CervedClient> = {}) {
  const entries: ActivityEntry[] = [];
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const calls: string[] = [];
  const stub: CervedClient = {
    available: true,
    findCompanyByVat: async (vat) => {
      calls.push(`search ${vat}`);
      return COMPANY;
    },
    findPec: async (id) => {
      calls.push(`profile ${id}`);
      return 'pec@rossi.example';
    },
    ...cerved,
  };
  const service = createVatLookupsService({
    cerved: stub,
    activityLog: { record: async (entry) => void entries.push(entry) },
    logger: { debug: () => {}, info: () => {}, warn: (_message, fields) => void warnings.push(fields), error: () => {} },
  });
  return { service, entries, warnings, calls };
}

const failure = async (call: Promise<unknown>): Promise<AppError> => {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error;
  }
  throw new assert.AssertionError({ message: 'did not fail' });
};

describe('the VAT lookup service', () => {
  it('finds the company, asks the profile for the PEC and logs the lookup with the VAT number as the resource', async () => {
    const { service, entries, calls } = setup();
    const result = await service.lookup(principalOf('PSA'), `  it${VAT} `, client);
    assert.deepEqual(result, { vatNumber: VAT, name: 'ROSSI SRL', fiscalCode: VAT, address: { street: 'VIA ROMA 1', postcode: '20100', city: 'MILANO', province: 'MI', country: 'IT' }, pec: 'pec@rossi.example' });
    assert.deepEqual(calls, [`search ${VAT}`, 'profile 42']);
    assert.equal(entries.length, 1);
    assert.deepEqual(
      [entries[0]!.category, entries[0]!.action, entries[0]!.outcome, entries[0]!.actor.kind, entries[0]!.resource, entries[0]!.metadata, entries[0]!.ip, entries[0]!.requestId],
      ['data', 'vatLookup.performed', 'success', 'user', { type: 'vatLookup', id: VAT }, { outcome: 'found' }, '203.0.113.9', 'r1'],
    );
  });

  it('answers 422 for a value that is not eleven digits, or whose check digit is wrong, without asking the provider or logging', async () => {
    const { service, entries, calls } = setup();
    for (const [value, issue] of [['', 'format'], ['  ', 'format'], ['1234567890', 'format'], ['123456789012', 'format'], ['1234567890a', 'format'], ['DE123456789', 'format'], ['12345678901&x', 'format'], ['12345678901', 'checksum'], ['IT12345678900', 'checksum']] as const) {
      const error = await failure(service.lookup(principalOf('PSA'), value, client));
      assert.deepEqual([error.code, error.details], ['VALIDATION_ERROR', [{ field: 'vatNumber', issue }]], value);
    }
    assert.deepEqual([calls, entries], [[], []]);
  });

  it('answers 404 and logs notFound when there is no such subject', async () => {
    const { service, entries, calls } = setup({ findCompanyByVat: async () => null });
    assert.equal((await failure(service.lookup(principalOf('D'), VAT, { ...client, ip: null }))).code, 'NOT_FOUND');
    assert.deepEqual(calls, []);
    assert.deepEqual([entries[0]!.outcome, entries[0]!.metadata, 'ip' in entries[0]!], ['success', { outcome: 'notFound' }, false]);
  });

  it('answers 503 and logs unavailable when there is no key, and does not ask the provider', async () => {
    const { service, entries, calls } = setup({ available: false });
    const error = await failure(service.lookup(principalOf('PSA'), VAT, client));
    assert.deepEqual([error.code, error.message], ['SERVICE_UNAVAILABLE', 'Service unavailable']);
    assert.deepEqual(calls, []);
    assert.deepEqual([entries[0]!.outcome, entries[0]!.metadata], ['failure', { outcome: 'unavailable' }]);
  });

  it('answers 503 with nothing of the provider when the search fails, and logs unavailable', async () => {
    const { service, entries } = setup({
      findCompanyByVat: async () => {
        throw new CervedError('search', 'status', 500);
      },
    });
    const error = await failure(service.lookup(principalOf('PSA'), VAT, client));
    assert.deepEqual([error.code, error.message, error.details], ['SERVICE_UNAVAILABLE', 'Service unavailable', undefined]);
    assert.deepEqual(entries.map((entry) => entry.metadata), [{ outcome: 'unavailable' }]);
  });

  it('does not hide a bug: an error that is not the provider failing is rethrown, in the search and in the profile', async () => {
    const search = setup({
      findCompanyByVat: async () => {
        throw new TypeError('bug');
      },
    });
    await assert.rejects(search.service.lookup(principalOf('PSA'), VAT, client), TypeError);
    assert.deepEqual(search.entries, []);
    const profile = setup({
      findPec: async () => {
        throw new TypeError('bug');
      },
    });
    await assert.rejects(profile.service.lookup(principalOf('PSA'), VAT, client), TypeError);
    assert.deepEqual(profile.entries, []);
  });

  it('answers without the PEC when the profile fails, and logs the name and the reason of the error only', async () => {
    const { service, entries, warnings } = setup({
      findPec: async () => {
        throw new CervedError('profile', 'timeout');
      },
    });
    const result = await service.lookup(principalOf('PSA'), VAT, client);
    assert.equal(result.pec, null);
    assert.equal(result.name, 'ROSSI SRL');
    assert.deepEqual(warnings, [{ errorName: 'CervedError', reason: 'timeout' }]);
    assert.deepEqual(entries.map((entry) => entry.metadata), [{ outcome: 'found' }]);
  });

  it('does not ask the profile of a subject that has no identifier', async () => {
    const { service, calls } = setup({ findCompanyByVat: async () => ({ ...COMPANY, subjectId: null }) });
    assert.equal((await service.lookup(principalOf('PSA'), VAT, client)).pec, null);
    assert.equal(calls.length, 0);
  });
});

describe('the VAT lookup mapper', () => {
  it('keeps a two-letter province in upper case and drops anything else', () => {
    const province = (value: string | null) => toVatLookupResult({ ...COMPANY, province: value }, null).address.province;
    assert.deepEqual(['mi', 'RM', 'Milano', 'M', 'M1', ' MI', null].map(province), ['MI', 'RM', null, null, null, null, null]);
  });

  it('has the country IT, the PEC it is given, and nothing else', () => {
    const result = toVatLookupResult({ ...COMPANY, name: null, street: null }, null);
    assert.deepEqual(result, { vatNumber: VAT, name: null, fiscalCode: VAT, address: { street: null, postcode: '20100', city: 'MILANO', province: 'MI', country: 'IT' }, pec: null });
    assert.deepEqual(Object.keys(result), ['vatNumber', 'name', 'fiscalCode', 'address', 'pec']);
  });
});
