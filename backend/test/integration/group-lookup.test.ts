import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { addUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { encryptLegacy, legacyEncryptionKey } from '../helpers/legacy-fixtures.ts';
import { TEST_CLUSTER, openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;
const g = (index: number) => office.cluster.groups[index]!;
const path = (index: number, segment: string) => `/groups/${g(index).groupId.toHexString()}/lookup/${segment}`;
const names = (reply: { body: { data: Array<{ name: string }> } }): string[] => reply.body.data.map((item) => item.name);
const SEGMENTS = ['products', 'product-categories', 'customers', 'contact-groups'] as const;
const hex = (id: ObjectId) => id.toHexString();

const shampoo = new ObjectId();
const cut = new ObjectId();
const otherGroupProduct = new ObjectId();
const encrypted = encryptLegacy('Segreto Persona', legacyEncryptionKey());

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  const inGroup = (index: number, collection: string, documents: Array<Record<string, unknown>>) =>
    ctx.databases.group(g(index).groupId, TEST_CLUSTER).collection(collection).insertMany(documents);
  await inGroup(0, 'products', [
    { _id: shampoo, type: 'product', name: { it: 'Shampoo', en: 'Shampoo EN' }, price: 9, supplier: 'riservato' },
    { _id: cut, type: 'service', name: { en: 'Cut' } },
    { _id: new ObjectId(), type: 'tobaccos', name: { it: 'Sigari' } },
    { _id: new ObjectId(), type: 'exempt', name: 'plain text' },
    { _id: new ObjectId(), name: { it: 5 } },
    { _id: new ObjectId(), type: 7, trash: false, name: { it: 'Tipo numerico' } },
    { _id: new ObjectId(), type: 'product', trash: true, name: { it: 'Vecchio' } },
  ]);
  await inGroup(1, 'products', [{ _id: otherGroupProduct, type: 'product', name: { it: 'Altro gruppo' } }]);
  await inGroup(0, 'products_categories', [
    { _id: new ObjectId(), name: { it: 'Bevande' } },
    { _id: new ObjectId(), name: { en: 'Food' }, trash: false },
    { _id: new ObjectId(), name: { it: 'Cestinata' }, trash: true },
    { _id: new ObjectId(), name: 7 },
  ]);
  await inGroup(1, 'products_categories', [{ _id: new ObjectId(), name: { it: 'Altro gruppo' } }]);
  await inGroup(0, 'contacts', [
    { _id: new ObjectId(), customer: true, supplier: false, companyName: ' Rossi Srl ', name: 'Mario', surname: 'Rossi', email: ['mario@example.test'], telephone: ['000'] },
    { _id: new ObjectId(), customer: true, companyName: '', name: 'Anna', surname: 'Bianchi', address: 'via riservata' },
    { _id: new ObjectId(), customer: true, name: 'Solo', surname: '' },
    { _id: new ObjectId(), customer: true, name: encrypted, surname: encrypted, companyName: 5 },
    { _id: new ObjectId(), customer: true, name: encrypted, surname: 'Verdi' },
    { _id: new ObjectId(), customer: true, trash: true, companyName: 'Cestinato' },
    { _id: new ObjectId(), customer: false, supplier: true, companyName: 'Fornitore Spa' },
  ]);
  await inGroup(1, 'contacts', [{ _id: new ObjectId(), customer: true, companyName: 'Altro gruppo' }]);
  await inGroup(0, 'contacts_groups', [
    { _id: new ObjectId(), name: 'VIP' },
    { _id: new ObjectId(), name: 'Abituali' },
    { _id: new ObjectId(), name: { it: 'oggetto' } },
  ]);
  await inGroup(1, 'contacts_groups', [{ _id: new ObjectId(), name: 'Altro gruppo' }]);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('GET /v1/groups/{groupId}/lookup/products', () => {
  it('lists id, name and type of the products not in the trash, in the language of the user, and nothing else', async () => {
    const reply = await as.call(g(0).sa, 'GET', path(0, 'products'));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(names(reply), ['', '', 'Cut', 'Shampoo', 'Sigari', 'Tipo numerico']);
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['id', 'name', 'type']);
    assert.deepEqual(reply.body.data.map((item: { type: string | null }) => item.type), ['exempt', null, 'service', 'product', 'tobaccos', null]);
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    const text = JSON.stringify(reply.body);
    for (const hidden of ['Vecchio', 'Altro gruppo', 'riservato', 'price']) {
      assert.ok(!text.includes(hidden), hidden);
    }
  });

  it('filters by type from an allowlist, searches the name literally and resolves ids', async () => {
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0, 'products')}?type=service`)), ['Cut']);
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0, 'products')}?type=games`)), []);
    assert.deepEqual(as.failure(await as.call(g(0).sa, 'GET', `${path(0, 'products')}?type=weapon`)).status, 422);
    assert.deepEqual(as.failure(await as.call(g(0).sa, 'GET', `${path(0, 'products')}?type[$ne]=x`)).status, 422);
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0, 'products')}?q=SHAM`)), ['Shampoo']);
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0, 'products')}?q=${encodeURIComponent('.*')}`)), []);
    const byIds = await as.call(g(0).sa, 'GET', `${path(0, 'products')}?ids=${hex(shampoo)},${hex(cut).toUpperCase()},${hex(cut)},${hex(otherGroupProduct)}`);
    assert.deepEqual(byIds.body.data.map((item: { name: string }) => item.name), ['Cut', 'Shampoo']);
  });
});

describe('GET /v1/groups/{groupId}/lookup/product-categories', () => {
  it('lists the categories not in the trash by name in the language of the user', async () => {
    const reply = await as.call(g(0).sa, 'GET', path(0, 'product-categories'));
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['', 'Bevande', 'Food']);
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['id', 'name']);
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0, 'product-categories')}?sort=-name&limit=1`)), ['Food']);
  });
});

describe('GET /v1/groups/{groupId}/lookup/customers', () => {
  it('shows the company name, else name and surname in clear, never encrypted or other personal data, and leaves suppliers out', async () => {
    const reply = await as.call(g(0).sa, 'GET', path(0, 'customers'));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(names(reply), ['', 'Anna Bianchi', 'Rossi Srl', 'Solo', 'Verdi']);
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['id', 'name']);
    const text = JSON.stringify(reply.body);
    for (const hidden of ['Fornitore', 'Cestinato', 'Altro gruppo', 'Mario', 'mario@', 'riservata', encrypted]) {
      assert.ok(!text.includes(hidden), hidden);
    }
    assert.deepEqual(names(await as.call(g(0).sa, 'GET', `${path(0, 'customers')}?q=bianchi`)), ['Anna Bianchi']);
  });
});

describe('GET /v1/groups/{groupId}/lookup/contact-groups', () => {
  it('lists the contact groups by name', async () => {
    const reply = await as.call(g(0).sa, 'GET', path(0, 'contact-groups'));
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['', 'Abituali', 'VIP']);
  });
});

describe('every compact read', () => {
  it('pages with a cursor of at most 100 and validates its parameters', async () => {
    for (const segment of SEGMENTS) {
      const seen: string[] = [];
      let url = `${path(0, segment)}?limit=2`;
      for (let page = 0; page < 10; page += 1) {
        const reply = await as.call(g(0).sa, 'GET', url);
        assert.equal(reply.status, 200);
        seen.push(...reply.body.data.map((item: { id: string }) => item.id));
        if (reply.body.page.next === null) {
          break;
        }
        url = `${path(0, segment)}?limit=2&cursor=${reply.body.page.next as string}`;
      }
      const all = await as.call(g(0).sa, 'GET', path(0, segment));
      assert.deepEqual(seen, all.body.data.map((item: { id: string }) => item.id), segment);
      assert.deepEqual(as.failure(await as.call(g(0).sa, 'GET', `${path(0, segment)}?limit=101`)), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'limit', issue: 'maximum' }] });
      assert.equal(as.failure(await as.call(g(0).sa, 'GET', `${path(0, segment)}?cursor=not-a-cursor`)).status, 422);
      assert.equal(as.failure(await as.call(g(0).sa, 'GET', `${path(0, segment)}?ids=not-an-id`)).status, 422);
      assert.equal(as.failure(await as.call(g(0).sa, 'GET', `${path(0, segment)}?ids=${hex(shampoo)},`)).status, 422);
      assert.equal(as.failure(await as.call(g(0).sa, 'GET', `${path(0, segment)}?ids=${Array(101).fill(hex(shampoo)).join(',')}`)).status, 422);
      assert.equal((await as.call(g(0).sa, 'GET', `${path(0, segment)}?ids=${Array(100).fill(hex(shampoo)).join(',')}`)).status, 200);
      assert.equal(as.failure(await as.call(g(0).sa, 'GET', `${path(0, segment)}?unknown=1`)).status, 422);
    }
  });

  it('keeps the groups apart, follows products:read and needs no feature', async () => {
    for (const segment of SEGMENTS) {
      assert.equal((await as.call(g(0).sa, 'GET', path(0, segment))).status, 200, segment);
      assert.equal((await as.call(g(0).ca, 'GET', path(0, segment))).status, 200, segment);
      assert.equal((await as.call(g(0).pa, 'GET', path(0, segment))).status, 200, segment);
      assert.equal((await as.call(office.cluster.psa, 'GET', path(0, segment))).status, 200, segment);
      assert.equal(as.failure(await as.call(g(0).sa, 'GET', path(1, segment))).status, 404, segment);
      assert.equal(as.failure(await as.call(g(1).ca, 'GET', path(0, segment))).status, 404, segment);
      assert.equal(as.failure(await as.call(office.cluster.dealerB, 'GET', path(0, segment))).status, 404, segment);
      const reader = await addUser(ctx, office, { permissions: { status: false, products: { r: false, w: false } } });
      assert.equal(as.failure(await as.call(reader.id, 'GET', path(0, segment))).status, 403, segment);
      assert.equal((await office.call('GET', path(0, segment), undefined)).status, 401, segment);
    }
    const own = await as.call(g(1).sa, 'GET', path(1, 'products'));
    assert.deepEqual(names(own), ['Altro gruppo']);
    assert.equal((await as.call(g(1).sa, 'GET', `${path(1, 'products')}?ids=${hex(shampoo)}`)).body.data.length, 0);
  });
});
