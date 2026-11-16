import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacesRepository } from '../../src/modules/places/places.repository.ts';
import { fixtureId, legacyGroup, legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
});
after(async () => {
  await ctx.cleanup();
});

describe('places repository: the languages of a group', () => {
  it('lists the codes the group has, and `it` when it has none, a list that is not one, or no document', async () => {
    const repository = createPlacesRepository(ctx.databases, { findCountry: async () => null, groupLists: async () => null });
    await ctx.databases.common().collection('groups').insertMany([
      legacyGroup(1, { settings: { languages: ['it', 'en', 5] } }),
      legacyGroup(2, { settings: { languages: true } }),
      legacyGroup(3, { settings: { languages: [] } }),
      legacyGroup(4, { settings: undefined }),
    ]);
    assert.deepEqual([...(await repository.groupLanguages(fixtureId('group', 1)))].sort(), ['en', 'it']);
    for (const n of [2, 3, 4, 99]) {
      assert.deepEqual([...(await repository.groupLanguages(fixtureId('group', n)))], ['it'], String(n));
    }
  });
});

describe('places repository: the users a table can be assigned to', () => {
  it('accepts a group administrator, a user with the place and a company administrator of its company, and refuses the others, the trash and other groups', async () => {
    const repository = createPlacesRepository(ctx.databases, { findCountry: async () => null, groupLists: async () => null });
    const group = fixtureId('group', 1);
    const place = fixtureId('place', 1);
    const company = fixtureId('company', 1);
    const make = (n: number, overrides: Record<string, unknown>) => legacyUser(n, { groupId: group, ...overrides });
    await ctx.databases.common().collection('users').insertMany([
      make(1, { role: 'SA' }),
      make(2, { role: 'PA', placeId: place }),
      make(3, { role: 'PA', placesId: [place] }),
      make(4, { role: 'CA', companyId: company }),
      make(5, { role: 'PA', placeId: fixtureId('place', 2) }),
      make(6, { role: 'SA', trash: true }),
      make(7, { role: 'SA', groupId: fixtureId('group', 2) }),
    ]);
    const ids = [1, 2, 3, 4, 5, 6, 7, 99].map((n) => fixtureId('user', n));
    assert.deepEqual([...(await repository.missingUsers(group, place, company, ids))], [4, 5, 6, 7]);
    // A place without a company has no company administrators.
    assert.deepEqual([...(await repository.missingUsers(group, place, null, ids))], [3, 4, 5, 6, 7]);
  });
});
