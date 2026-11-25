import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addUser } from '../helpers/backoffice.ts';
import { DOJO_KEY, TSH_ID, TSH_SECRET, integrationsEnv, startFakes, startIntegrationsWorld, stopFakes } from '../helpers/integrations-world.ts';
import type { Fakes, IntegrationsWorld } from '../helpers/integrations-world.ts';
import { fixtureId, legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let fakes: Fakes;
let on: IntegrationsWorld;
let place: Awaited<ReturnType<IntegrationsWorld['seed']>>;

/** The four routes of the places of the integrations: what to send to each. */
const ROUTES: ReadonlyArray<readonly [string, string, unknown]> = [
  ['GET', '/integrations/dojo/terminals', undefined],
  ['POST', '/integrations/satispay/activation', { activationCode: 'AB12CD34' }],
  ['POST', '/integrations/tsh/charge-categories/sync', undefined],
  ['POST', '/geocoding', { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' }],
];
const outgoing = (): number => Object.values(fakes).reduce((total, fake) => total + fake.requests.length, 0);

before(async () => {
  fakes = await startFakes();
  ctx = await openTestDatabases();
  on = await startIntegrationsWorld(ctx, { env: integrationsEnv(fakes) });
  place = await on.seed(860, {
    dojo: { status: true, apiKey: DOJO_KEY },
    satispay: { status: true, keyId: null, type: 'checkin' },
    tsh: { status: true, id: TSH_ID, secret: TSH_SECRET, propertyId: 'prop', testMode: false },
    googleMaps: { status: true },
  });
});
after(async () => {
  await on.world.office.close();
  await ctx.cleanup();
  await stopFakes(fakes);
});

describe('who may reach the routes of the integrations of a place', () => {
  it('refuses a call without a token or with an invalid one (401)', async () => {
    for (const [method, rest, body] of ROUTES) {
      for (const token of [undefined, 'not-a-token']) {
        const reply = await on.world.office.call(method, on.path(place, rest), token, body, { 'idempotency-key': randomUUID() });
        assert.equal(reply.status, 401, `${method} ${rest}`);
      }
    }
    assert.equal(outgoing(), 0);
  });

  it('refuses a user who cannot change places (403), before anything is read or sent', async () => {
    const employee = await addUser(ctx, on.world.office, { role: 'CA', companyId: fixtureId('company', 1), permissions: legacyPermissions({ status: false }) });
    for (const [method, rest, body] of ROUTES) {
      const reply = await on.world.as.call(employee.id, method, on.path(place, rest), body, { 'idempotency-key': randomUUID() });
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], `${method} ${rest}`);
    }
    assert.equal(outgoing(), 0);
  });

  it('refuses the server of a point of sale with its store key (403), on its own place too: the routes are never open to it', async () => {
    const own = on.world.group(0).ownPlaceId;
    const key = await on.world.activate(own);
    for (const [method, rest, body] of ROUTES) {
      const reply = await on.world.asStore(key.key, method, on.path(own, rest), body, { 'idempotency-key': randomUUID() });
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], `${method} ${rest}`);
    }
    assert.equal(outgoing(), 0);
  });

  it('refuses a public API key on /v1 (401) and does not serve the routes on /public/v1', async () => {
    for (const [method, rest, body] of ROUTES) {
      for (const surface of ['v1', 'public/v1']) {
        const reply = await fetch(`${on.world.office.app.baseUrl}/${surface}/groups/${on.world.group(0).groupId.toHexString()}/places/${place.toHexString()}${rest}`, {
          method,
          headers: { 'x-api-key': 'fc_pk_whatever', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.ok([401, 404].includes(reply.status), `${method} ${surface}${rest}: ${String(reply.status)}`);
      }
    }
    assert.equal(outgoing(), 0);
  });
});
