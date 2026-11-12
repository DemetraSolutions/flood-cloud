import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLookupService } from '../../src/modules/group-lookup/lookup.service.ts';
import type { LookupRepository } from '../../src/modules/group-lookup/lookup.repository.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { principalOf } from '../helpers/principal.ts';

describe('the compact reads', () => {
  it('fail with not found when the caller is gone since the authentication', async () => {
    const lookup = {
      products: () => Promise.reject(new Error('must not be reached')),
      categories: () => Promise.reject(new Error('must not be reached')),
    } as unknown as LookupRepository;
    const service = createLookupService({ lookup, users: { findById: () => Promise.resolve(null) } });
    await assert.rejects(service.products(principalOf('SA'), {} as GroupAccess, {}), { code: 'NOT_FOUND' });
    await assert.rejects(service.categories(principalOf('SA'), {} as GroupAccess, {}), { code: 'NOT_FOUND' });
  });
});
