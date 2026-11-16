import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacesRepository } from '../../src/modules/places/places.repository.ts';
import { fixtureId, legacyGroup } from '../helpers/legacy-fixtures.ts';
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
