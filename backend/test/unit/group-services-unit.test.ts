import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupServicesService } from '../../src/modules/group-services/services.service.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { principalOf } from '../helpers/principal.ts';

describe('the services list', () => {
  it('fails with not found when the caller is gone since the authentication', async () => {
    const service = createGroupServicesService({
      services: { list: () => Promise.reject(new Error('must not be reached')) },
      users: { findById: () => Promise.resolve(null) },
    });
    await assert.rejects(service.list(principalOf('SA'), {} as GroupAccess, {}), { code: 'NOT_FOUND' });
  });
});
