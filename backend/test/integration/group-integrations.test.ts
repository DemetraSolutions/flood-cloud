import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Document } from 'mongodb';
import { openCatalogOffice } from '../helpers/catalogs.ts';
import type { CatalogOffice } from '../helpers/catalogs.ts';

let t: CatalogOffice;
const KEY = 'K-0123456789abcdef-secret'; // gitleaks:allow (fake test value)
const failure = (reply: Awaited<ReturnType<CatalogOffice['as']['call']>>) => t.as.failure(reply);
const get = async (actor = t.office.cluster.psa, index = 0) => (await t.as.call(actor, 'GET', t.path(index))).body.data;
const patch = (actor: Parameters<CatalogOffice['as']['call']>[0], body: unknown, index = 0) => t.as.call(actor, 'PATCH', t.path(index), body);

before(async () => {
  t = await openCatalogOffice();
});
after(async () => {
  await t.close();
});

describe('the integration keys of a group', () => {
  it('are set by the PSA and the dealer, never returned, never logged, and the response says only that one is set', async () => {
    const mark = t.office.activity.entries.length;
    const before = await t.stored(0);
    const reply = await patch(t.office.cluster.psa, { integrations: { yellgo: { enabled: true, apiKey: KEY } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.data.integrations.yellgo, { enabled: true, apiKeySet: true });
    assert.deepEqual(reply.body.data.integrations.qodeup, { enabled: false, apiKeySet: false });
    const stored = (await t.stored(0))['settings'].integrations.yellgo;
    assert.deepEqual(stored, { status: true, apiKey: KEY });
    for (const field of ['apiKey', 'databaseHost', 'filesHost', 'places', 'type', 'plan', 'expirationDate']) {
      assert.deepEqual((await t.stored(0))[field], before[field], field);
    }
    const everywhere = JSON.stringify([reply.body, (await get()), t.office.activity.entries.slice(mark), t.office.logEvents]);
    assert.ok(!everywhere.includes(KEY));
    const event = t.office.activity.entries.slice(mark).find((entry) => entry.action === 'group.updated')!;
    assert.ok(event.changes!.some((change) => change.field === 'integrationKeysConfigured.yellgo' && change.before === false && change.after === true));
    // The dealer may do it too; an SA may not touch integrations at all.
    const byDealer = await patch(t.group(0).dealerId, { integrations: { cooperto: { apiKey: KEY } } });
    assert.deepEqual([byDealer.status, byDealer.body.data.integrations.cooperto], [200, { enabled: false, apiKeySet: true }]);
    assert.deepEqual(failure(await patch(t.group(0).sa, { integrations: { yellgo: { apiKey: KEY } } })), { status: 403, code: 'FORBIDDEN', details: [{ field: 'integrations', issue: 'notAllowed' }] });
  });

  it('are replaced and removed with null; removing a key that is not set changes nothing', async () => {
    const other = 'another-key-0123456789';
    const mark0 = t.office.activity.entries.length;
    assert.equal((await patch(t.office.cluster.psa, { integrations: { yellgo: { apiKey: other } } })).body.data.integrations.yellgo.apiKeySet, true);
    assert.equal((await t.stored(0))['settings'].integrations.yellgo.apiKey, other);
    // The replacement is in the log: it names the provider whose key changed, never the key, its hash or its length.
    const replaced = t.office.activity.entries.slice(mark0).filter((entry) => entry.action === 'group.updated').at(-1)!;
    assert.deepEqual(replaced.changes!.map((change) => [change.field, change.before, change.after]), [['integrationKeysChanged.yellgo', undefined, true]]);
    const logged = JSON.stringify([replaced, t.office.logEvents]);
    assert.ok(!logged.includes(other) && !logged.includes(createHash('sha256').update(other).digest('hex')));
    const removed = await patch(t.office.cluster.psa, { integrations: { yellgo: { apiKey: null } } });
    assert.deepEqual(removed.body.data.integrations.yellgo, { enabled: true, apiKeySet: false });
    assert.deepEqual((await t.stored(0))['settings'].integrations.yellgo, { status: true, apiKey: null });
    const mark = t.office.activity.entries.length;
    const again = await patch(t.office.cluster.psa, { integrations: { yellgo: { apiKey: null }, qodeup: { apiKey: null } } });
    assert.equal(again.status, 200);
    assert.equal(t.office.activity.entries.length, mark);
    // An empty string stored by the legacy is not a key.
    await t.set(0, { 'settings.integrations.leggimenu.apiKey': '' });
    assert.equal((await get()).integrations.leggimenu.apiKeySet, false);
  });

  it('are validated: 16 to 256 printable characters without spaces', async () => {
    for (const [value, issue] of [['short', 'minLength'], ['with space in the middle', 'pattern'], ['x'.repeat(257), 'maxLength'], ['tab\there-0123456789', 'pattern'], [5, 'type']] as const) {
      assert.deepEqual(failure(await patch(t.office.cluster.psa, { integrations: { yellgo: { apiKey: value } } })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'integrations.yellgo.apiKey', issue }] });
    }
  });

  it('change the tag of the detail, which is the same for the same content', async () => {
    const token = await t.as.tokenOf(t.office.cluster.psa);
    const first = await t.office.call('GET', t.path(0), token);
    const tag = first.headers.get('etag');
    await first.text();
    assert.equal((await patch(t.office.cluster.psa, { integrations: { plateform: { apiKey: KEY } } })).status, 200);
    const second = await t.office.call('GET', t.path(0), token, undefined, { 'if-none-match': tag! });
    assert.equal(second.status, 200);
    assert.notEqual(second.headers.get('etag'), tag);
    await second.text();
  });
});

describe('the detail of a group with the stored variants of the legacy', () => {
  it('reads easyAppear only when easyappear is missing, the symbol as a character, the taxes object as an empty list', async () => {
    await t.set(1, { 'settings.integrations.easyAppear': { status: true, apiKey: KEY }, taxes: {}, 'currencies.EUR.symbol': '&euro;' });
    let data = await get(t.office.cluster.psa, 1);
    assert.deepEqual([data.integrations.easyappear, data.taxes, data.currencies], [{ enabled: true, apiKeySet: false }, [], [{ code: 'EUR', symbol: '€' }]]);
    await t.set(1, { 'settings.integrations.easyappear': { status: false, apiKey: null } });
    data = await get(t.office.cluster.psa, 1);
    assert.deepEqual(data.integrations.easyappear, { enabled: false, apiKeySet: false });
    await t.set(1, { 'settings.integrations.easyappear': null });
    assert.equal((await get(t.office.cluster.psa, 1)).integrations.easyappear.enabled, true);
    // A container that is null cannot take the write (409); once removed, the write goes to the right key and never to the capitalized variant.
    assert.equal((await patch(t.office.cluster.psa, { integrations: { easyappear: { enabled: false } } }, 1)).status, 409);
    await t.ctx.databases.common().collection('groups').updateOne({ _id: t.group(1).groupId }, { $unset: { 'settings.integrations.easyappear': '' } });
    assert.equal((await patch(t.office.cluster.psa, { integrations: { easyappear: { enabled: false } } }, 1)).status, 200);
    const integrations = (await t.stored(1))['settings'].integrations;
    assert.deepEqual([integrations.easyappear, integrations.easyAppear], [{ status: false }, { status: true, apiKey: KEY }]);
  });

  it('shows the six catalogs of the group form and nothing of fidelity, favorites or promotions', async () => {
    await t.set(2, { fidelity: { cardsTypes: [{ id: 'k' }] }, productsFavorites: [{ id: 'f' }], promotions: [{ id: 'p' }] });
    const data = await get(t.office.cluster.psa, 2);
    for (const key of ['priceLists', 'taxes', 'currencies', 'measureUnits', 'warehouseRules', 'fidelityCardRules']) {
      assert.ok(Array.isArray(data[key]), key);
    }
    const text = JSON.stringify(data);
    for (const hidden of ['cardsTypes', 'productsFavorites', 'promotions', 'fidelity"', 'cardTypes']) {
      assert.ok(!text.includes(hidden), hidden);
    }
    assert.deepEqual(data.fidelityCardRules, [{ currency: 'EUR', pointValue: null, discountPercentage: null }]);
    assert.equal(data.priceLists.filter((list: Document) => list['isDefault']).length, 1);
  });

  it('shows the changes of the catalogs in the detail at once', async () => {
    const created = await t.as.call(t.office.cluster.psa, 'POST', t.path(0, '/measure-units'), { value: 'lt' });
    assert.ok((await get()).measureUnits.some((unit: Document) => unit['id'] === created.body.data.id));
  });
});

describe('the writes of every catalog stay inside what the backend owns', () => {
  it('leave apiKey, databaseHost, filesHost, places, type, plan and expirationDate alone', async () => {
    await t.set(3, { expirationDate: new Date('2030-01-01'), places: [{ _id: t.group(3).ownPlaceId, insertDate: new Date('2025-01-01') }] });
    const before = await t.stored(3);
    const psa = t.office.cluster.psa;
    const call = (method: string, rest: string, body?: unknown) => t.as.call(psa, method, t.path(3, rest), body);
    const price = (await call('POST', '/price-lists', { name: 'Extra' })).body.data.id;
    await call('PATCH', `/price-lists/${price}`, { isDefault: true });
    const tax = (await call('POST', '/taxes', { rate: 4 })).body.data.id;
    await call('PATCH', `/taxes/${tax}`, { rate: 5 });
    await call('POST', '/currencies', { code: 'CHF', symbol: 'CHF' });
    await call('PUT', '/fidelity-card-rules/CHF', { pointValue: 1, discountPercentage: 1 });
    const unit = (await call('POST', '/measure-units', { value: 'm' })).body.data.id;
    const rule = (await call('POST', '/warehouse-rules', { type: 'load', name: 'n', quantity: '+', value: '+', counterpart: 'indoor' })).body.data.id;
    const prizes = (await call('POST', '/fidelity/prize-catalogues', { name: 'P', prizes: [{ name: 'a' }] })).body.data.id;
    const collection = (await call('POST', '/fidelity/points-collections', { name: 'C', prizeCatalogueId: prizes })).body.data.id;
    const card = (await call('POST', '/fidelity/card-types', { name: 'K', priceListId: price, pointsCollect: { collectionIds: [collection] } })).body.data.id;
    const favorite = (await call('POST', '/product-favorites', { name: 'F' })).body.data.id;
    const promotion = (await call('POST', '/promotions', { name: 'Pr' })).body.data.id;
    for (const [segment, id] of [['promotions', promotion], ['product-favorites', favorite], ['fidelity/card-types', card], ['fidelity/points-collections', collection], ['fidelity/prize-catalogues', prizes], ['warehouse-rules', rule], ['measure-units', unit], ['currencies', 'CHF'], ['taxes', tax]] as const) {
      assert.equal((await call('DELETE', `/${segment}/${id}`)).status, 204, segment);
    }
    const after = await t.stored(3);
    for (const field of ['apiKey', 'databaseHost', 'filesHost', 'places', 'type', 'plan', 'expirationDate', 'name', 'description', 'status', 'demo', 'trash', 'dealerId', 'settings', 'insertDate']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'fidelity', 'productsFavorites', 'promotions'].filter((key, index, all) => all.indexOf(key) === index).sort());
  });
});
