import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createCompaniesRepository } from '../../src/modules/companies/companies.repository.ts';
import type { CompaniesRepository } from '../../src/modules/companies/companies.repository.ts';
import { fixtureId, legacyCountry, legacyGroup, legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let repository: CompaniesRepository;

before(async () => {
  ctx = await openTestDatabases();
  repository = createCompaniesRepository(ctx.databases, createCatalogsRepository(ctx.databases));
  const common = ctx.databases.common();
  await common.collection('countries').insertMany([
    legacyCountry(1, { code: 'IT', areas: [{ code: 'MI' }, { code: 'RM' }, { name: 'no code' }, null, { code: 5 }] }),
    legacyCountry(2, { code: 'DE', areas: [] }),
    legacyCountry(3, { code: 'FR', areas: 'none' }),
    legacyCountry(4, { code: 'ES', areas: undefined }),
    legacyCountry(5, { code: 'PT', areas: [null, { name: 'x' }] }),
  ]);
  await common.collection('groups').insertMany([
    legacyGroup(1, {
      currencies: { EUR: { code: 'EUR', symbol: '&euro;' }, USD: { code: 'USD', symbol: '$' } },
      priceLists: { a: { id: 'a', name: 'On', status: true, default: true }, b: { id: 'b', name: 'Off', status: false, default: false }, c: 'broken' },
    }),
    legacyGroup(2, { currencies: 'none', priceLists: null }),
  ]);
  await common.collection('users').insertMany([legacyUser(1, { role: 'D' }), legacyUser(2, { role: 'D', trash: true }), legacyUser(3, { role: 'SA' }), legacyUser(4, { role: 'D', trash: false }), legacyUser(5, { role: 'D', status: false })]);
});
after(async () => {
  await ctx.cleanup();
});

describe('companies repository (real MongoDB)', () => {
  it('reads a country with the codes of its areas, or none when it lists none', async () => {
    assert.deepEqual(await repository.findCountry('IT'), { code: 'IT', areas: new Set(['MI', 'RM']) });
    for (const code of ['DE', 'FR', 'ES', 'PT']) {
      assert.deepEqual(await repository.findCountry(code), { code, areas: null }, code);
    }
    assert.equal(await repository.findCountry('ZZ'), null);
  });

  it('tells a dealer that is not in the trash from the others', async () => {
    assert.equal(await repository.isDealer(fixtureId('user', 1)), true);
    assert.equal(await repository.isDealer(fixtureId('user', 4)), true);
    assert.equal(await repository.isDealer(fixtureId('user', 2)), false);
    assert.equal(await repository.isDealer(fixtureId('user', 3)), false);
    assert.equal(await repository.isDealer(fixtureId('user', 5)), false);
    assert.equal(await repository.isDealer(new ObjectId()), false);
  });

  it('reads the currencies and the enabled price lists of a group through its catalogs, tolerating a broken container', async () => {
    assert.deepEqual(await repository.groupLists(fixtureId('group', 1)), { currencies: new Set(['EUR', 'USD']), priceLists: new Set(['a']) });
    assert.deepEqual(await repository.groupLists(fixtureId('group', 2)), { currencies: new Set(), priceLists: new Set() });
    assert.equal(await repository.groupLists(fixtureId('group', 99)), null);
  });
});
