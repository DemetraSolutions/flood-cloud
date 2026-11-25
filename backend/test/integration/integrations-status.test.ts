import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { actors } from '../helpers/users.ts';

// A throw-away value: the status route never calls the provider.
const KEY = 'test-key-0123456789abcdef'; // gitleaks:allow (fake test value)
const GOOGLE = 'test-google-key-0123456789'; // gitleaks:allow (fake test value)

let ctx: TestDatabases;
let bareCtx: TestDatabases;
let world: StoreWorld;
let bare: Backoffice;
const outgoing: string[] = [];

before(async () => {
  ctx = await openTestDatabases();
  bareCtx = await openTestDatabases();
  const refusing: typeof fetch = async (input) => {
    outgoing.push(String(input));
    throw new Error('no outgoing call expected');
  };
  world = await startStoreWorld(ctx, { env: { CERVED_API_KEY: KEY, DOJO_RESELLER_ID: 'reseller', DOJO_SOFTWARE_HOUSE_ID: 'house', GOOGLE_MAPS_API_KEY: GOOGLE }, integrationsHttp: { cerved: { fetch: refusing }, dojo: { fetch: refusing }, geocoding: { fetch: refusing } } });
  bare = await startBackoffice(bareCtx);
});
after(async () => {
  await world.office.close();
  await bare.close();
  await ctx.cleanup();
  await bareCtx.cleanup();
});

describe('GET /v1/integrations', () => {
  it('answers which providers are available, from the configuration, without calling anybody', async () => {
    const group = world.office.cluster.groups[0]!;
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA, group.sa, group.ca, group.pa]) {
      const reply = await world.as.call(actor, 'GET', '/integrations');
      assert.deepEqual([reply.status, reply.body], [200, { data: { cerved: true, dojo: true, satispay: false, tsh: false, geocoding: true } }]);
    }
    assert.deepEqual(outgoing, []);
  });

  it('says a provider without a key is off', async () => {
    const reply = await actors(bare).call(bare.cluster.psa, 'GET', '/integrations');
    assert.deepEqual([reply.status, reply.body], [200, { data: { cerved: false, dojo: false, satispay: false, tsh: false, geocoding: false } }]);
  });

  it('is refused without a token, with an invalid one, to a user with neither permission, to a store key and to a public API key', async () => {
    const anonymous = await world.office.call('GET', '/integrations', undefined);
    assert.equal(anonymous.status, 401);
    const invalid = await world.office.call('GET', '/integrations', 'not-a-token');
    assert.equal(invalid.status, 401);

    const employee = await addUserWithNoModules();
    const refused = await world.as.call(employee, 'GET', '/integrations');
    assert.deepEqual([refused.status, refused.body.error.code], [403, 'FORBIDDEN']);

    const group = world.office.cluster.groups[0]!;
    const key = await world.activate(group.ownPlaceId);
    const asStore = await world.asStore(key.key, 'GET', '/integrations');
    assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN']);

    const asApiKey = await fetch(`${world.office.app.baseUrl}/v1/integrations`, { headers: { 'x-api-key': 'fc_pk_whatever' } });
    assert.equal(asApiKey.status, 401);
    const onPublic = await fetch(`${world.office.app.baseUrl}/public/v1/integrations`, { headers: { 'x-api-key': 'fc_pk_whatever' } });
    assert.ok([401, 404].includes(onPublic.status));
    assert.deepEqual(outgoing, []);
  });
});

/** A place administrator whose own permissions grant nothing: only what every user holds on his own account is left. */
async function addUserWithNoModules() {
  return (await addUser(ctx, world.office, { role: 'PA', permissions: legacyPermissions({ status: false }) })).id;
}
