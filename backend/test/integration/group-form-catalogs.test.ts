import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { openCatalogOffice } from '../helpers/catalogs.ts';
import type { CatalogOffice } from '../helpers/catalogs.ts';

let t: CatalogOffice;
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const notFound = { status: 404, code: 'NOT_FOUND', details: undefined };
const conflict = (...details: Array<[string, string]>) => ({ status: 409, code: 'CONFLICT', details: details.length === 0 ? undefined : details.map(([field, issue]) => ({ field, issue })) });
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const failure = (reply: Awaited<ReturnType<CatalogOffice['as']['call']>>) => t.as.failure(reply);
const events = (from: number) => t.office.activity.entries.slice(from);

before(async () => {
  t = await openCatalogOffice();
});
after(async () => {
  await t.close();
});

describe('the catalogs of the group form: access', () => {
  const segments = ['price-lists', 'taxes', 'currencies', 'measure-units', 'warehouse-rules', 'fidelity-card-rules'];

  it('are read by the PSA, the dealer and the SA of the group, and refused to CA and PA by permission', async () => {
    for (const segment of segments) {
      for (const actor of [t.office.cluster.psa, t.group(0).dealerId, t.group(0).sa]) {
        const reply = await t.as.call(actor, 'GET', t.path(0, `/${segment}`));
        assert.equal(reply.status, 200, segment);
        assert.ok(Array.isArray(reply.body.data));
        assert.equal(reply.headers.get('etag'), null);
      }
      for (const actor of [t.group(0).ca, t.group(0).pa]) {
        assert.deepEqual(failure(await t.as.call(actor, 'GET', t.path(0, `/${segment}`))), denied, segment);
      }
    }
  });

  it('do not exist outside the perimeter: other dealer, other group, unknown group', async () => {
    for (const segment of segments) {
      assert.deepEqual(failure(await t.as.call(t.office.cluster.dealerB, 'GET', t.path(0, `/${segment}`))), notFound);
      assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'GET', t.path(1, `/${segment}`))), notFound);
      assert.deepEqual(failure(await t.as.call(t.office.cluster.psa, 'GET', `/groups/${new ObjectId().toHexString()}/${segment}`)), notFound);
    }
    assert.deepEqual(failure(await t.as.call(t.office.cluster.dealerB, 'POST', t.path(0, '/price-lists'), { name: 'x' })), notFound);
    assert.deepEqual(failure(await t.as.call(t.group(0).ca, 'POST', t.path(0, '/price-lists'), { name: 'x' })), denied);
  });

  it('are for the PSA alone while the group is suspended', async () => {
    await t.as.tokenOf(t.group(2).sa);
    await t.set(2, { status: false });
    assert.deepEqual(failure(await t.as.call(t.office.cluster.dealerB, 'GET', t.path(2, '/taxes'))), notFound);
    // The users of a suspended group are not even authenticated.
    assert.deepEqual(failure(await t.as.call(t.group(2).sa, 'POST', t.path(2, '/taxes'), { rate: 4 })), { status: 401, code: 'UNAUTHENTICATED', details: undefined });
    assert.equal((await t.as.call(t.office.cluster.psa, 'POST', t.path(2, '/taxes'), { rate: 4 })).status, 201);
    await t.set(2, { status: true });
  });
});

describe('/price-lists', () => {
  const list = async (index = 0) => (await t.as.call(t.group(index).sa, 'GET', t.path(index, '/price-lists'))).body.data as Array<Document>;

  it('lists the stored lists with the domain names', async () => {
    const [first] = (await list()) as [Document];
    assert.deepEqual([first.name, first.enabled, first.isDefault, typeof first.id], ['Listino 1', true, true, 'string']);
    assert.deepEqual(Object.keys(first).sort(), ['enabled', 'id', 'isDefault', 'name']);
  });

  it('creates a list with a made id, in the legacy form, and records it', async () => {
    const before = await t.stored(0);
    const mark = t.office.activity.entries.length;
    const reply = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/price-lists'), { name: '  Asporto ', enabled: false });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const created = reply.body.data;
    assert.match(created.id, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual([created.name, created.enabled, created.isDefault], ['Asporto', false, false]);
    assert.equal(reply.headers.get('location'), `/v1${t.path(0, `/price-lists/${created.id}`)}`);
    const after = await t.stored(0);
    assert.deepEqual((after['priceLists'] as Document)[created.id], { id: created.id, name: 'Asporto', status: false, default: false });
    assert.deepEqual((after['priceLists'] as Document)[Object.keys(before['priceLists'] as Document)[0]!], Object.values(before['priceLists'] as Document)[0]);
    for (const field of ['apiKey', 'databaseHost', 'filesHost', 'type', 'plan', 'name', 'taxes', 'currencies', 'places']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.ok((after['updateDate'] as Date) > (before['updateDate'] as Date));
    const [event] = events(mark);
    assert.deepEqual([events(mark).length, event!.action, event!.category, event!.groupId?.toHexString(), event!.resource], [1, 'group.priceList.created', 'data', t.group(0).groupId.toHexString(), { type: 'group', id: t.group(0).groupId.toHexString() }]);
    assert.ok(event!.changes!.some((change) => change.field === 'name' && change.after === 'Asporto'));
  });

  it('refuses a duplicate name ignoring case, invalid bodies and a list beyond the limit', async () => {
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/price-lists'), { name: 'LISTINO 1' })), conflict(['name', 'taken']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/price-lists'), {})), invalid(['name', 'required']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/price-lists'), { name: 'a', default: true })), invalid(['default', 'unknown']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/price-lists'), { name: 'a', isDefault: false, enabled: 'yes' })), invalid(['enabled', 'type']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, '/price-lists/x'), {})), invalid(['(body)', 'required']));
    const many = Object.fromEntries(Array.from({ length: 50 }, (_unused, i) => [`p${i}`, { id: `p${i}`, name: `N${i}`, status: true, default: i === 0 }]));
    await t.set(1, { priceLists: many });
    assert.deepEqual(failure(await t.as.call(t.group(1).sa, 'POST', t.path(1, '/price-lists'), { name: 'one more' })), invalid(['(body)', 'tooMany']));
  });

  it('moves the default flag in the same write, and keeps the keys it does not manage', async () => {
    const [first] = await list(0);
    await t.set(0, { [`priceLists.${first!.id}.custom`]: 'kept' });
    const reply = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/price-lists'), { name: 'Nuovo predefinito', isDefault: true });
    assert.equal(reply.status, 201);
    const stored = (await t.stored(0))['priceLists'] as Document;
    assert.deepEqual([stored[first!.id].default, stored[first!.id].custom, stored[reply.body.data.id].default], [false, 'kept', true]);
    assert.equal((await list()).filter((item) => item.isDefault).length, 1);
    const back = await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/price-lists/${first!.id}`), { isDefault: true, name: 'Listino base' });
    assert.deepEqual([back.status, back.body.data.isDefault, back.body.data.name], [200, true, 'Listino base']);
    assert.equal(((await t.stored(0))['priceLists'] as Document)[first!.id].custom, 'kept');
    assert.equal((await list()).filter((item) => item.isDefault).length, 1);
    // The default flag cannot be taken away without giving it to another list.
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/price-lists/${first!.id}`), { isDefault: false })), invalid(['isDefault', 'incorrect']));
  });

  it('modifies and writes nothing when the request repeats the stored values', async () => {
    const [first] = await list(0);
    const mark = t.office.activity.entries.length;
    const before = await t.stored(0);
    const reply = await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/price-lists/${first!.id}`), { name: first!.name, enabled: first!.enabled });
    assert.equal(reply.status, 200);
    assert.deepEqual(await t.stored(0), before);
    assert.equal(events(mark).length, 0);
  });

  it('refuses the same name on rename, finds 404 for an unknown or malformed id', async () => {
    const [first, second] = await list(0);
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/price-lists/${second!.id}`), { name: first!.name.toUpperCase() })), conflict(['name', 'taken']));
    for (const id of ['nope', 'a.b', '%24ne', 'x'.repeat(65)]) {
      assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/price-lists/${id}`), { name: 'z' })), id.length > 64 ? invalid(['itemId', 'maxLength']) : notFound, id);
      assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/price-lists/${id}`))), id.length > 64 ? invalid(['itemId', 'maxLength']) : notFound, id);
    }
  });

  it('refuses to delete the default list, the last list and a list a card type uses; deletes any other', async () => {
    const lists = await list(0);
    const standard = lists.find((item) => item.isDefault)!;
    const other = lists.find((item) => !item.isDefault)!;
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/price-lists/${standard.id}`))), conflict(['id', 'default']));
    await t.set(0, { 'fidelity.cardsTypes': [{ id: 'ct1', status: true, name: 'Gold', priceListId: other.id }] });
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/price-lists/${other.id}`))), conflict(['cardTypes.ct1', 'referenced']));
    await t.set(0, { 'fidelity.cardsTypes': [] });
    const mark = t.office.activity.entries.length;
    const reply = await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/price-lists/${other.id}`));
    assert.deepEqual([reply.status, reply.body], [204, undefined]);
    assert.equal(Object.hasOwn((await t.stored(0))['priceLists'] as Document, other.id), false);
    assert.deepEqual(events(mark).map((entry) => entry.action), ['group.priceList.deleted']);
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/price-lists/${standard.id}`))), conflict(['id', 'default']));
    await t.set(3, { priceLists: { only: { id: 'only', name: 'Only', status: true, default: false } } });
    assert.deepEqual(failure(await t.as.call(t.group(3).sa, 'DELETE', t.path(3, '/price-lists/only'))), conflict(['id', 'last']));
  });
});

describe('/taxes', () => {
  it('creates, modifies, empties and deletes a tax rate in the legacy form', async () => {
    const created = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/taxes'), { rate: 10, department: 2, vatNature: 'N2.1', description: 'Esente' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    assert.deepEqual(created.body.data, { id, rate: 10, department: 2, description: 'Esente', vatNature: 'N2.1' });
    const stored = ((await t.stored(0))['taxes'] as Document[]).find((tax) => tax['id'] === id);
    assert.deepEqual(stored, { id, value: 10, department: 2, description: 'Esente', natura: 'N2.1' });
    // The stored tax keeps its extra keys; null empties a nullable field.
    await t.set(0, { taxes: [...((await t.stored(0))['taxes'] as Document[]).map((tax) => (tax['id'] === id ? { ...tax, legacy: 7 } : tax))] });
    const patched = await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/taxes/${id}`), { rate: 22, vatNature: null, department: null, description: null });
    assert.deepEqual(patched.body.data, { id, rate: 22, department: null, description: null, vatNature: null });
    assert.deepEqual(((await t.stored(0))['taxes'] as Document[]).find((tax) => tax['id'] === id), { id, value: 22, department: null, description: null, natura: null, legacy: 7 });
    const list = await t.as.call(t.group(0).sa, 'GET', t.path(0, '/taxes'));
    assert.ok(list.body.data.some((tax: Document) => tax['id'] === id));
    assert.equal((await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/taxes/${id}`))).status, 204);
    assert.equal(((await t.stored(0))['taxes'] as Document[]).some((tax) => tax['id'] === id), false);
  });

  it('validates the rate, the department, the description and the nature', async () => {
    const post = async (body: unknown) => failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/taxes'), body));
    assert.deepEqual(await post({}), invalid(['rate', 'required']));
    assert.deepEqual(await post({ rate: 101 }), invalid(['rate', 'maximum']));
    assert.deepEqual(await post({ rate: -1 }), invalid(['rate', 'minimum']));
    assert.deepEqual(await post({ rate: 4, department: 100 }), invalid(['department', 'maximum']));
    assert.deepEqual(await post({ rate: 4, department: 1.5 }), invalid(['department', 'type']));
    assert.deepEqual(await post({ rate: 4, vatNature: 'N9' }), invalid(['vatNature', 'enum']));
    assert.deepEqual(await post({ rate: 4, description: 'x'.repeat(201) }), invalid(['description', 'maxLength']));
  });

  it('reads a stored object instead of the array as an empty list and replaces it on the first write; keeps a stored unknown nature', async () => {
    await t.set(1, { taxes: {} });
    assert.deepEqual((await t.as.call(t.group(1).sa, 'GET', t.path(1, '/taxes'))).body.data, []);
    const reply = await t.as.call(t.group(1).sa, 'POST', t.path(1, '/taxes'), { rate: 4 });
    assert.equal(reply.status, 201);
    assert.ok(Array.isArray((await t.stored(1))['taxes']));
    await t.set(1, { taxes: [{ id: 7, value: 5, natura: 'N9.9', department: 3, description: null }, 'garbage'] });
    const shown = (await t.as.call(t.group(1).sa, 'GET', t.path(1, '/taxes'))).body.data;
    assert.deepEqual(shown, [{ id: '7', rate: 5, department: 3, description: null, vatNature: 'N9.9' }]);
    const changed = await t.as.call(t.group(1).sa, 'PATCH', t.path(1, '/taxes/7'), { rate: 6 });
    assert.equal(changed.status, 200);
    assert.deepEqual((await t.stored(1))['taxes'], [{ id: 7, value: 6, natura: 'N9.9', department: 3, description: null }, 'garbage']);
  });

  it('refuses a tax beyond the limit', async () => {
    await t.set(1, { taxes: Array.from({ length: 30 }, (_unused, i) => ({ id: `t${i}`, value: 1 })) });
    assert.deepEqual(failure(await t.as.call(t.group(1).sa, 'POST', t.path(1, '/taxes'), { rate: 4 })), invalid(['(body)', 'tooMany']));
    assert.equal((await t.as.call(t.group(1).sa, 'GET', t.path(1, '/taxes'))).body.data.length, 30);
  });
});

describe('/currencies and /fidelity-card-rules', () => {
  it('creates a currency with its loyalty rule, stores the symbol as the legacy entity and shows the character', async () => {
    const created = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/currencies'), { code: 'GBP', symbol: '£' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data, { code: 'GBP', symbol: '£' });
    assert.equal(created.headers.get('location'), `/v1${t.path(0, '/currencies/GBP')}`);
    const stored = await t.stored(0);
    assert.deepEqual((stored['currencies'] as Document)['GBP'], { code: 'GBP', symbol: '&pound;' });
    assert.deepEqual((stored['currencies'] as Document)['EUR'], { code: 'EUR', symbol: '&euro;' });
    assert.deepEqual((stored['fidelityCardRules'] as Document)['GBP'], { code: 'GBP', value: null, discountPercentage: null });
    const list = (await t.as.call(t.group(0).sa, 'GET', t.path(0, '/currencies'))).body.data;
    assert.deepEqual(list, [{ code: 'EUR', symbol: '€' }, { code: 'GBP', symbol: '£' }]);
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/currencies'), { code: 'GBP', symbol: '£' })), conflict(['code', 'taken']));
  });

  it('validates the code and the symbol, and refuses a currency beyond the limit', async () => {
    const post = async (body: unknown) => failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/currencies'), body));
    assert.deepEqual(await post({ code: 'eur', symbol: '€' }), invalid(['code', 'pattern']));
    assert.deepEqual(await post({ code: 'USDX', symbol: '$' }), invalid(['code', 'maxLength']));
    assert.deepEqual(await post({ code: 'USD', symbol: '<b>' }), invalid(['symbol', 'pattern']));
    assert.deepEqual(await post({ code: 'USD', symbol: '&euro;' }), invalid(['symbol', 'pattern']));
    assert.deepEqual(await post({ code: 'USD', symbol: '' }), invalid(['symbol', 'minLength']));
    await t.set(1, { currencies: Object.fromEntries(Array.from({ length: 10 }, (_unused, i) => [`C${String.fromCharCode(65 + i)}Z`, { code: `C${String.fromCharCode(65 + i)}Z`, symbol: '$' }])) });
    assert.deepEqual(failure(await t.as.call(t.group(1).sa, 'POST', t.path(1, '/currencies'), { code: 'USD', symbol: '$' })), invalid(['(body)', 'tooMany']));
  });

  it('changes a symbol, keeps an unknown stored one, and deletes a currency with its loyalty rule', async () => {
    await t.set(0, { 'currencies.GBP.symbol': '&weird;' });
    assert.deepEqual((await t.as.call(t.group(0).sa, 'GET', t.path(0, '/currencies'))).body.data[1], { code: 'GBP', symbol: '&weird;' });
    const patched = await t.as.call(t.group(0).sa, 'PATCH', t.path(0, '/currencies/GBP'), { symbol: '$' });
    assert.deepEqual(patched.body.data, { code: 'GBP', symbol: '$' });
    assert.equal(((await t.stored(0))['currencies'] as Document)['GBP'].symbol, '$');
    const mark = t.office.activity.entries.length;
    assert.equal((await t.as.call(t.group(0).sa, 'DELETE', t.path(0, '/currencies/GBP'))).status, 204);
    const stored = await t.stored(0);
    assert.deepEqual([Object.keys(stored['currencies'] as Document), Object.keys(stored['fidelityCardRules'] as Document)], [['EUR'], ['EUR']]);
    assert.deepEqual(events(mark).map((entry) => entry.action), ['group.currency.deleted']);
  });

  it('lists a loyalty rule for every currency, replaces one with PUT and refuses the rest', async () => {
    await t.set(0, { 'currencies.USD': { code: 'USD', symbol: '$' } });
    const listed = (await t.as.call(t.group(0).sa, 'GET', t.path(0, '/fidelity-card-rules'))).body.data;
    assert.deepEqual(listed, [{ currency: 'EUR', pointValue: null, discountPercentage: null }, { currency: 'USD', pointValue: null, discountPercentage: null }]);
    const mark = t.office.activity.entries.length;
    const put = await t.as.call(t.group(0).sa, 'PUT', t.path(0, '/fidelity-card-rules/EUR'), { pointValue: 0.5, discountPercentage: 3 });
    assert.deepEqual([put.status, put.body.data], [200, { currency: 'EUR', pointValue: 0.5, discountPercentage: 3 }]);
    assert.deepEqual(((await t.stored(0))['fidelityCardRules'] as Document)['EUR'], { code: 'EUR', value: 0.5, discountPercentage: 3 });
    await t.as.call(t.group(0).sa, 'PUT', t.path(0, '/fidelity-card-rules/USD'), { pointValue: 1, discountPercentage: null });
    assert.deepEqual(((await t.stored(0))['fidelityCardRules'] as Document)['USD'], { code: 'USD', value: 1, discountPercentage: null });
    assert.deepEqual(events(mark).map((entry) => entry.action), ['group.fidelityCardRule.updated', 'group.fidelityCardRule.updated']);
    const same = await t.as.call(t.group(0).sa, 'PUT', t.path(0, '/fidelity-card-rules/EUR'), { pointValue: 0.5, discountPercentage: 3 });
    assert.equal(same.status, 200);
    assert.equal(events(mark).length, 2);
    const cleared = await t.as.call(t.group(0).sa, 'PUT', t.path(0, '/fidelity-card-rules/EUR'), { pointValue: null, discountPercentage: null });
    assert.deepEqual(cleared.body.data, { currency: 'EUR', pointValue: null, discountPercentage: null });
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PUT', t.path(0, '/fidelity-card-rules/JPY'), { pointValue: 1, discountPercentage: 1 })), notFound);
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PUT', t.path(0, '/fidelity-card-rules/EUR'), { pointValue: 1 })), invalid(['discountPercentage', 'required']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PUT', t.path(0, '/fidelity-card-rules/EUR'), { pointValue: -1, discountPercentage: 101 })), invalid(['pointValue', 'minimum'], ['discountPercentage', 'maximum']));
    assert.equal((await t.as.call(t.group(0).sa, 'POST', t.path(0, '/fidelity-card-rules'), {})).status, 405);
    assert.equal((await t.as.call(t.group(0).sa, 'DELETE', t.path(0, '/fidelity-card-rules/EUR'))).status, 405);
  });
});

describe('/measure-units', () => {
  it('creates, renames and deletes a unit; the value is unique ignoring case', async () => {
    const created = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/measure-units'), { value: ' kg ' });
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    assert.deepEqual(((await t.stored(0))['measureUnits'] as Document)[id], { id, value: 'kg' });
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/measure-units'), { value: 'KG' })), conflict(['value', 'taken']));
    assert.equal((await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/measure-units/${id}`), { value: 'g' })).body.data.value, 'g');
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/measure-units/${id}`), { value: 'PZ' })), conflict(['value', 'taken']));
    assert.equal((await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/measure-units/${id}`))).status, 204);
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/measure-units'), { value: 'x'.repeat(21) })), invalid(['value', 'maxLength']));
    await t.set(1, { measureUnits: Object.fromEntries(Array.from({ length: 50 }, (_unused, i) => [`u${i}`, { id: `u${i}`, value: `v${i}` }])) });
    assert.deepEqual(failure(await t.as.call(t.group(1).sa, 'POST', t.path(1, '/measure-units'), { value: 'more' })), invalid(['(body)', 'tooMany']));
  });
});

describe('/warehouse-rules', () => {
  const body = (extra: Document = {}) => ({ type: 'load', name: 'Carico merce', quantity: '+', value: '+', counterpart: 'suppliers', ...extra });

  it('creates a load rule in the legacy form, keeps the keys it does not manage and records it', async () => {
    const created = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ cashLoad: true }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    assert.deepEqual(created.body.data, { id, type: 'load', name: 'Carico merce', quantity: '+', value: '+', useLoadUnit: false, counterpart: 'suppliers', isDefault: false, cashLoad: true, cashUnload: false });
    assert.deepEqual(((await t.stored(0))['warehouseRules'] as Document)[id], { id, type: 'L', name: 'Carico merce', quantity: '+', value: '+', useLoadUnit: false, counterpart: 'suppliers', default: false, cashL: true });
    await t.set(0, { [`warehouseRules.${id}.priceType`]: 'cost' });
    const patched = await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/warehouse-rules/${id}`), { name: 'Carico', counterpart: 'indoor', cashLoad: false });
    assert.deepEqual([patched.body.data.name, patched.body.data.counterpart, patched.body.data.cashLoad], ['Carico', 'indoor', false]);
    assert.deepEqual(((await t.stored(0))['warehouseRules'] as Document)[id], { id, type: 'L', name: 'Carico', quantity: '+', value: '+', useLoadUnit: false, counterpart: 'indoor', default: false, cashL: false, priceType: 'cost' });
    const unload = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ type: 'unload', quantity: '-', value: '-', counterpart: 'customers', useLoadUnit: true }));
    assert.deepEqual(((await t.stored(0))['warehouseRules'] as Document)[unload.body.data.id], { id: unload.body.data.id, type: 'D', name: 'Carico merce', quantity: '-', value: '-', useLoadUnit: true, counterpart: 'customers', default: false, cashD: false });
    assert.equal((await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/warehouse-rules/${id}`))).status, 204);
  });

  it('allows one cash rule per kind and only on the right type', async () => {
    const standardCashUnload = Object.values((await t.stored(0))['warehouseRules'] as Document).find((rule) => rule['cashD'] === true)!;
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ type: 'unload', cashUnload: true }))), conflict(['cashUnload', 'taken']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ cashUnload: true }))), invalid(['cashUnload', 'notAllowed']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ type: 'unload', cashLoad: true }))), invalid(['cashLoad', 'notAllowed']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ useLoadUnit: true }))), invalid(['useLoadUnit', 'notAllowed']));
    const first = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ cashLoad: true }));
    assert.equal(first.status, 201);
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body({ cashLoad: true }))), conflict(['cashLoad', 'taken']));
    const second = await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), body());
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/warehouse-rules/${second.body.data.id}`), { cashLoad: true })), conflict(['cashLoad', 'taken']));
    assert.equal(standardCashUnload['default'], true);
  });

  it('does not modify or delete a default rule, validates the body and the limit', async () => {
    const standard = Object.values((await t.stored(0))['warehouseRules'] as Document).find((rule) => rule['default'] === true)!;
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, `/warehouse-rules/${standard['id']}`), { name: 'x' })), conflict(['id', 'default']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'DELETE', t.path(0, `/warehouse-rules/${standard['id']}`))), conflict(['id', 'default']));
    const post = async (extra: Document) => failure(await t.as.call(t.group(0).sa, 'POST', t.path(0, '/warehouse-rules'), extra));
    assert.deepEqual(await post({}), invalid(['type', 'required'], ['name', 'required'], ['quantity', 'required'], ['value', 'required'], ['counterpart', 'required']));
    assert.deepEqual(await post(body({ quantity: '*' })), invalid(['quantity', 'enum']));
    assert.deepEqual(await post(body({ default: true })), invalid(['default', 'unknown']));
    assert.deepEqual(failure(await t.as.call(t.group(0).sa, 'PATCH', t.path(0, '/warehouse-rules/x'), { type: 'unload' })), invalid(['type', 'unknown']));
    await t.set(1, { warehouseRules: Object.fromEntries(Array.from({ length: 50 }, (_unused, i) => [`r${i}`, { id: `r${i}`, type: 'L', name: 'n', quantity: '=', value: '=', counterpart: 'indoor', default: false }])) });
    assert.deepEqual(failure(await t.as.call(t.group(1).sa, 'POST', t.path(1, '/warehouse-rules'), body())), invalid(['(body)', 'tooMany']));
  });

  it('shows a stored rule with values outside the allowed ones as null, and keeps them on a change', async () => {
    await t.set(3, { warehouseRules: { odd: { id: 'odd', type: 'X', name: 'Odd', quantity: '*', value: 5, counterpart: 'moon', priceType: 'last' } } });
    const shown = (await t.as.call(t.group(3).sa, 'GET', t.path(3, '/warehouse-rules'))).body.data[0];
    assert.deepEqual(shown, { id: 'odd', type: null, name: 'Odd', quantity: null, value: null, useLoadUnit: false, counterpart: null, isDefault: false, cashLoad: false, cashUnload: false });
    assert.equal((await t.as.call(t.group(3).sa, 'PATCH', t.path(3, '/warehouse-rules/odd'), { name: 'Renamed' })).status, 200);
    assert.deepEqual(((await t.stored(3))['warehouseRules'] as Document)['odd'], { id: 'odd', type: 'X', name: 'Renamed', quantity: '*', value: 5, counterpart: 'moon', priceType: 'last' });
  });
});
