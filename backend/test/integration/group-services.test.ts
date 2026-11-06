import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { addUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { TEST_CLUSTER, openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;
const g = (index: number) => office.cluster.groups[index]!;
const path = (index: number) => `/groups/${g(index).groupId.toHexString()}/services`;
const names = (reply: { body: { data: Array<{ name: string }> } }): string[] => reply.body.data.map((item) => item.name);

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  await ctx.databases.common().collection('groups').updateOne({ _id: g(0).groupId }, { $set: { 'settings.services': true } });
  await ctx.databases.group(g(0).groupId, TEST_CLUSTER).collection('products').insertMany([
    { _id: new ObjectId(), type: 'service', name: { it: 'Taglio', en: 'Cut' } },
    { _id: new ObjectId(), type: 'service', name: { en: 'Colour' } },
    { _id: new ObjectId(), type: 'service', name: { it: 'Barba' } },
    { _id: new ObjectId(), type: 'service', name: 'plain text' },
    { _id: new ObjectId(), type: 'service', name: { it: 5 } },
    { _id: new ObjectId(), type: 'service' },
    { _id: new ObjectId(), type: 'product', name: { it: 'Shampoo' } },
    { _id: new ObjectId(), type: 'service', trash: true, name: { it: 'Vecchio' } },
    { _id: new ObjectId(), type: 'service', trash: false, name: { it: 'Zona' } },
  ]);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('GET /v1/groups/{groupId}/services', () => {
  it('lists the services of the group by name in the language of the user, with the first language as a fallback, and nothing else', async () => {
    const reply = await as.call(g(0).sa, 'GET', path(0));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(names(reply), ['', '', '', 'Barba', 'Colour', 'Taglio', 'Zona']);
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['id', 'name']);
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    const text = JSON.stringify(reply.body);
    assert.ok(!text.includes('Shampoo') && !text.includes('Vecchio'));
  });

  it('searches the name, case-insensitively and literally, and pages with a cursor of at most 100', async () => {
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0)}?q=ARB`)), ['Barba']);
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0)}?q=${encodeURIComponent('.*')}`)), []);
    const seen: string[] = [];
    let url = `${path(0)}?limit=3`;
    for (let page = 0; page < 5; page += 1) {
      const reply = await as.call(g(0).sa, 'GET', url);
      seen.push(...names(reply));
      if (reply.body.page.next === null) {
        break;
      }
      url = `${path(0)}?limit=3&cursor=${reply.body.page.next as string}`;
    }
    assert.deepEqual(seen, ['', '', '', 'Barba', 'Colour', 'Taglio', 'Zona']);
    assert.deepEqual(as.failure(await as.call(g(0).sa, 'GET', `${path(0)}?limit=101`)), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'limit', issue: 'maximum' }] });
    assert.equal((await as.call(g(0).sa, 'GET', `${path(0)}?limit=100&sort=-name`)).status, 200);
    assert.equal(as.failure(await as.call(g(0).sa, 'GET', `${path(0)}?cursor=not-a-cursor`)).status, 422);
  });

  it('needs the permission to read users and the services feature, and keeps the groups apart', async () => {
    assert.deepEqual(as.failure(await as.call(g(1).sa, 'GET', path(1))), { status: 403, code: 'FEATURE_DISABLED', details: undefined });
    assert.equal(as.failure(await as.call(g(0).sa, 'GET', path(1))).status, 404);
    assert.equal(as.failure(await as.call(office.cluster.dealerB, 'GET', path(0))).status, 404);
    assert.equal((await as.call(office.cluster.psa, 'GET', path(0))).status, 200);
    const reader = await addUser(ctx, office, { permissions: { status: false, users: { r: false, w: false } } });
    assert.equal(as.failure(await as.call(reader.id, 'GET', path(0))).status, 403);
    assert.equal((await office.call('GET', path(0), undefined)).status, 401);
  });
});
