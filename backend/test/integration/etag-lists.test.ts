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
const base = (index: number) => `/groups/${g(index).groupId.toHexString()}`;

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  await ctx.databases.group(g(0).groupId, TEST_CLUSTER).collection('products').insertOne({ _id: new ObjectId(), type: 'product', name: { it: 'Only in group 0' } });
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

/** Every compact reference list, with the caller allowed to read it. */
const lists = (): Array<{ name: string; path: string; reader: ObjectId; denied: () => Promise<ObjectId> }> => {
  const nobody = async () => (await addUser(ctx, office, { permissions: { status: false } })).id;
  return [
    { name: 'groups', path: '/groups', reader: office.cluster.psa, denied: async () => g(0).ca },
    { name: 'companies', path: `${base(0)}/companies`, reader: g(0).sa, denied: async () => g(0).pa },
    { name: 'places', path: `${base(0)}/places`, reader: g(0).sa, denied: nobody },
    { name: 'lookup/products', path: `${base(0)}/lookup/products`, reader: g(0).sa, denied: nobody },
    { name: 'lookup/product-categories', path: `${base(0)}/lookup/product-categories`, reader: g(0).sa, denied: nobody },
    { name: 'lookup/customers', path: `${base(0)}/lookup/customers`, reader: g(0).sa, denied: nobody },
    { name: 'lookup/contact-groups', path: `${base(0)}/lookup/contact-groups`, reader: g(0).sa, denied: nobody },
    { name: 'lookup/price-lists', path: `${base(0)}/lookup/price-lists`, reader: g(0).sa, denied: nobody },
  ];
};

describe('ETag on the compact reference lists', () => {
  it('carry a weak ETag and no-store, answer 304 without a body to a matching If-None-Match and 200 to another', async () => {
    for (const list of lists()) {
      const token = await as.tokenOf(list.reader);
      const first = await office.call('GET', list.path, token);
      const tag = first.headers.get('etag')!;
      assert.equal(first.status, 200, list.name);
      assert.match(tag, /^W\/"[A-Za-z0-9_-]{43}"$/, list.name);
      assert.equal(first.headers.get('cache-control'), 'no-store', list.name);
      await first.text();
      const again = await office.call('GET', list.path, token, undefined, { 'if-none-match': tag });
      assert.deepEqual([again.status, await again.text(), again.headers.get('etag'), again.headers.get('cache-control')], [304, '', tag, 'no-store'], list.name);
      const stale = await office.call('GET', list.path, token, undefined, { 'if-none-match': 'W/"old"' });
      assert.equal(stale.status, 200, list.name);
      assert.equal(stale.headers.get('etag'), tag, list.name);
      assert.ok(Array.isArray(((await stale.json()) as { data: unknown }).data), list.name);
    }
  });

  it('follow the whole body: another page of the same list has another tag', async () => {
    const token = await as.tokenOf(office.cluster.psa);
    const whole = await office.call('GET', '/groups?limit=200', token);
    const small = await office.call('GET', '/groups?limit=1', token);
    assert.notEqual(whole.headers.get('etag'), small.headers.get('etag'));
    await whole.text();
    await small.text();
  });

  it('depend on the perimeter of the caller: different perimeters have different tags, and a tag does not revalidate for another caller', async () => {
    const pairs: Array<[string, ObjectId, ObjectId]> = [
      ['/groups?limit=200', office.cluster.psa, office.cluster.dealerA],
      [`${base(0)}/companies`, g(0).sa, g(0).ca],
      [`${base(0)}/places`, g(0).sa, g(0).ca],
      [`${base(0)}/lookup/products`, g(0).sa, g(0).sa],
    ];
    for (const [path, wide, narrow] of pairs) {
      const first = await office.call('GET', path, await as.tokenOf(wide));
      const tag = first.headers.get('etag')!;
      await first.text();
      if (wide === narrow) {
        continue;
      }
      const other = await office.call('GET', path, await as.tokenOf(narrow), undefined, { 'if-none-match': tag });
      assert.equal(other.status, 200, path);
      assert.notEqual(other.headers.get('etag'), tag, path);
      await other.text();
    }
    const here = await office.call('GET', `${base(0)}/lookup/products`, await as.tokenOf(g(0).sa));
    const there = await office.call('GET', `${base(1)}/lookup/products`, await as.tokenOf(g(1).sa));
    assert.notEqual(here.headers.get('etag'), there.headers.get('etag'));
    await here.text();
    await there.text();
  });

  it('never let If-None-Match win over 401, 403 or 404', async () => {
    for (const list of lists()) {
      const token = await as.tokenOf(list.reader);
      const first = await office.call('GET', list.path, token);
      const tag = first.headers.get('etag')!;
      await first.text();
      const anonymous = await office.call('GET', list.path, undefined, undefined, { 'if-none-match': tag });
      assert.equal(anonymous.status, 401, list.name);
      assert.equal(anonymous.headers.get('etag'), null, list.name);
      await anonymous.text();
      const forbidden = await as.call(await list.denied(), 'GET', list.path, undefined, { 'if-none-match': tag });
      assert.equal(forbidden.status, 403, list.name);
      assert.equal(forbidden.headers.get('etag'), null, list.name);
      if (list.path.startsWith('/groups/')) {
        const hidden = await as.call(g(1).sa, 'GET', list.path, undefined, { 'if-none-match': tag });
        assert.equal(hidden.status, 404, list.name);
      }
    }
  });

  it('keep validation before the comparison: a wrong parameter is 422 even with a matching tag', async () => {
    const token = await as.tokenOf(office.cluster.psa);
    const first = await office.call('GET', '/groups', token);
    const tag = first.headers.get('etag')!;
    await first.text();
    const invalid = await office.call('GET', '/groups?limit=0', token, undefined, { 'if-none-match': tag });
    assert.equal(invalid.status, 422);
    await invalid.text();
  });
});
