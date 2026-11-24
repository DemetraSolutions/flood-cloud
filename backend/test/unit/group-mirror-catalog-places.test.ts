import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { readCatalogPlaces } from '../../src/shared/security/scope/group-mirror.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';

describe('readCatalogPlaces', () => {
  it('refuses ids that are not ObjectIds before any read', async () => {
    const groupId = new ObjectId();
    const sa = principalOf('SA', { groupId });
    const access = (await accessFor(sa, groupId))!;
    const databases = { common: () => assert.fail('no read') } as unknown as Databases;
    await assert.rejects(readCatalogPlaces(sa, access, databases, ['not-an-id' as unknown as ObjectId], 5), /needs their ids/);
  });
});
