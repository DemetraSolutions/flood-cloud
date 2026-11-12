import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { newHex, openCatalogOffice } from '../helpers/catalogs.ts';
import type { CatalogOffice } from '../helpers/catalogs.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { send } from '../helpers/users.ts';

let t: CatalogOffice;
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const notFound = { status: 404, code: 'NOT_FOUND', details: undefined };
const conflict = (...details: Array<[string, string]>) => ({ status: 409, code: 'CONFLICT', details: details.map(([field, issue]) => ({ field, issue })) });
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const failure = (reply: Awaited<ReturnType<CatalogOffice['as']['call']>>) => t.as.failure(reply);
const sa = () => t.group(0).sa;
const call = (method: string, rest: string, body?: unknown, index = 0) => t.as.call(t.group(index).sa, method, t.path(index, rest), body);
const events = (from: number) => t.office.activity.entries.slice(from).map((entry) => entry.action);

const product = newHex();
const product2 = newHex();
const trashedProduct = newHex();
const category = newHex();
const contact = newHex();
const contactGroup = newHex();
const missing = newHex().hex;
const trashedPlace = newHex();

before(async () => {
  t = await openCatalogOffice();
  await t.insertInGroup(0, 'products', [
    { _id: product.id, trash: false },
    { _id: product2.id },
    { _id: trashedProduct.id, trash: true },
  ]);
  await t.insertInGroup(0, 'products_categories', [{ _id: category.id, trash: false }]);
  await t.insertInGroup(0, 'contacts', [{ _id: contact.id, trash: false }]);
  await t.insertInGroup(0, 'contacts_groups', [{ _id: contactGroup.id }]);
  await insertCopies(t.ctx.databases, 'places', [{ _id: trashedPlace.id, trash: true, groupId: t.group(0).groupId }]);
});
after(async () => {
  await t.close();
});

const place1 = () => t.group(0).ownPlaceId.toHexString();
const place2 = () => t.group(0).otherPlaceId.toHexString();

describe('permissions of the loyalty, favorites and promotions catalogs', () => {
  const asUser = async (permissions: Document) => {
    const { name } = await addUser(t.ctx, t.office, { permissions: { status: false, ...permissions } });
    const token = (await t.office.tokens(name)).accessToken;
    return (method: string, rest: string, body?: unknown) => send(t.office, method, t.path(0, rest), token, body);
  };

  it('follow fidelity.* for the loyalty catalogs and products.* for favorites and promotions, inside the ceiling of the role', async () => {
    const fidelityRead = await asUser({ fidelity: { r: true, w: false } });
    const productsWrite = await asUser({ products: { r: true, w: true } });
    const nothing = await asUser({ places: { r: true, w: true } });
    for (const segment of ['/fidelity/card-types', '/fidelity/points-collections', '/fidelity/prize-catalogues']) {
      assert.equal((await fidelityRead('GET', segment)).status, 200, segment);
      assert.equal((await fidelityRead('POST', segment, { name: 'x' })).status, 403, segment);
      assert.equal((await productsWrite('GET', segment)).status, 403, segment);
      assert.equal((await nothing('GET', segment)).status, 403, segment);
    }
    for (const segment of ['/product-favorites', '/promotions']) {
      assert.equal((await productsWrite('GET', segment)).status, 200, segment);
      assert.equal((await fidelityRead('GET', segment)).status, 403, segment);
      assert.equal((await nothing('POST', segment, { name: 'x' })).status, 403, segment);
    }
    assert.equal((await productsWrite('POST', '/product-favorites', { name: 'Permesso' })).status, 201);
    const readOnly = await asUser({ products: { r: true, w: false } });
    assert.equal((await readOnly('POST', '/product-favorites', { name: 'Negato' })).status, 403);
    assert.equal((await readOnly('DELETE', '/promotions/x')).status, 403);
  });

  it('are open to every role of the group within its ceiling, and not to another dealer', async () => {
    for (const actor of [t.office.cluster.psa, t.group(0).dealerId, sa(), t.group(0).ca, t.group(0).pa]) {
      assert.equal((await t.as.call(actor, 'GET', t.path(0, '/promotions'))).status, 200);
      assert.equal((await t.as.call(actor, 'GET', t.path(0, '/fidelity/card-types'))).status, 200);
    }
    assert.deepEqual(failure(await t.as.call(t.office.cluster.dealerB, 'GET', t.path(0, '/promotions'))), notFound);
    assert.deepEqual(failure(await t.as.call(sa(), 'GET', t.path(1, '/fidelity/prize-catalogues'))), notFound);
  });
});

describe('/fidelity/prize-catalogues', () => {
  it('creates a catalogue with its prizes, made ids and an empty image, in the legacy form', async () => {
    const mark = t.office.activity.entries.length;
    const reply = await call('POST', '/fidelity/prize-catalogues', { name: 'Premi', prizes: [{ name: 'Caffè', pointsValue: 50 }, { name: 'Cena', enabled: false, description: 'Per due', extraPrice: 9.5, redemptionConditions: 'Solo sera' }] });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { id, prizes } = reply.body.data;
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(prizes[0], { id: prizes[0].id, enabled: true, name: 'Caffè', description: null, pointsValue: 50, extraPrice: null, redemptionConditions: null, imageSet: false });
    assert.equal(reply.headers.get('location'), `/v1${t.path(0, `/fidelity/prize-catalogues/${id}`)}`);
    const stored = ((await t.stored(0))['fidelity'] as Document)['prizeCatalogues'] as Document[];
    assert.deepEqual(stored.find((item) => item['id'] === id), {
      id,
      status: true,
      name: 'Premi',
      prizes: [
        { id: prizes[0].id, status: true, name: 'Caffè', description: null, pointsValue: 50, extraPrice: null, redemptionConditions: null, medias: { images: { main: null } } },
        { id: prizes[1].id, status: false, name: 'Cena', description: 'Per due', pointsValue: null, extraPrice: 9.5, redemptionConditions: 'Solo sera', medias: { images: { main: null } } },
      ],
    });
    assert.deepEqual(events(mark), ['group.prizeCatalogue.created']);
  });

  it('modifies by id: the prize keeps its image and unknown keys, new prizes get ids, the ones left out are deleted', async () => {
    const created = (await call('POST', '/fidelity/prize-catalogues', { name: 'Con immagini', prizes: [{ name: 'A' }, { name: 'B' }] })).body.data;
    const [a, b] = created.prizes;
    const stored = ((await t.stored(0))['fidelity'] as Document)['prizeCatalogues'] as Document[];
    const withImage = stored.map((item) => (item['id'] === created.id ? { ...item, extra: 1, prizes: (item['prizes'] as Document[]).map((prize) => (prize['id'] === a.id ? { ...prize, medias: { images: { main: { file: 'x' } } }, legacy: true } : prize)) } : item));
    await t.set(0, { 'fidelity.prizeCatalogues': withImage });
    assert.equal((await call('GET', '/fidelity/prize-catalogues')).body.data.find((item: Document) => item['id'] === created.id).prizes[0].imageSet, true);
    const reply = await call('PATCH', `/fidelity/prize-catalogues/${created.id}`, { name: 'Rinominato', prizes: [{ id: a.id, pointsValue: 10 }, { name: 'C', description: null }] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = (((await t.stored(0))['fidelity'] as Document)['prizeCatalogues'] as Document[]).find((item) => item['id'] === created.id)!;
    assert.deepEqual([after['name'], after['extra'], (after['prizes'] as Document[]).length], ['Rinominato', 1, 2]);
    assert.deepEqual((after['prizes'] as Document[])[0], { id: a.id, status: true, name: 'A', description: null, pointsValue: 10, extraPrice: null, redemptionConditions: null, medias: { images: { main: { file: 'x' } } }, legacy: true });
    assert.equal(((after['prizes'] as Document[])[1] as Document)['name'], 'C');
    assert.notEqual(((after['prizes'] as Document[])[1] as Document)['id'], b.id);
    assert.deepEqual(reply.body.data.prizes.map((prize: Document) => prize['imageSet']), [true, false]);
    // Only the catalogue fields: prizes untouched.
    assert.equal((await call('PATCH', `/fidelity/prize-catalogues/${created.id}`, { enabled: false })).body.data.prizes.length, 2);
  });

  it('refuses a prize with an unknown or repeated id and a new prize without a name', async () => {
    const created = (await call('POST', '/fidelity/prize-catalogues', { name: 'Controlli', prizes: [{ name: 'A' }] })).body.data;
    const url = `/fidelity/prize-catalogues/${created.id}`;
    assert.deepEqual(failure(await call('PATCH', url, { prizes: [{ id: 'nope', name: 'x' }] })), invalid(['prizes.0.id', 'incorrect']));
    assert.deepEqual(failure(await call('PATCH', url, { prizes: [{ id: created.prizes[0].id }, { id: created.prizes[0].id }] })), invalid(['prizes.1.id', 'incorrect']));
    assert.deepEqual(failure(await call('PATCH', url, { prizes: [{ description: 'no name' }] })), invalid(['prizes.0.name', 'required']));
    assert.deepEqual(failure(await call('POST', '/fidelity/prize-catalogues', { name: 'x', prizes: [{ name: 'a', medias: {} }] })), invalid(['prizes.0.medias', 'unknown']));
    assert.deepEqual(failure(await call('POST', '/fidelity/prize-catalogues', { name: 'x', prizes: Array.from({ length: 201 }, () => ({ name: 'a' })) })), invalid(['prizes', 'tooMany']));
  });

  it('accepts a body of a few hundred kilobytes (200 prizes) and refuses one beyond the limit of the route', async () => {
    const long = 'd'.repeat(1000);
    const big = { name: 'Grande', prizes: Array.from({ length: 200 }, (_unused, i) => ({ name: `Premio ${String(i)}`, description: long, redemptionConditions: long })) };
    const reply = await call('POST', '/fidelity/prize-catalogues', big);
    assert.equal(reply.status, 201, JSON.stringify(reply.body).slice(0, 300));
    assert.equal(reply.body.data.prizes.length, 200);
    const huge = await call('POST', '/fidelity/prize-catalogues', { name: 'Enorme', pad: 'x'.repeat(1_100_000) });
    assert.equal(huge.status, 413);
  });

  it('refuses more than 20 catalogues and deletes one no collection uses', async () => {
    await t.set(1, { 'fidelity.prizeCatalogues': Array.from({ length: 20 }, (_unused, i) => ({ id: `c${i}`, status: true, name: `n${i}`, prizes: [] })) });
    assert.deepEqual(failure(await call('POST', '/fidelity/prize-catalogues', { name: 'x' }, 1)), invalid(['(body)', 'tooMany']));
    assert.equal((await call('DELETE', '/fidelity/prize-catalogues/c3', undefined, 1)).status, 204);
    assert.equal((await call('GET', '/fidelity/prize-catalogues', undefined, 1)).body.data.length, 19);
  });
});

describe('/fidelity/points-collections', () => {
  const catalogue = async () => (await call('POST', '/fidelity/prize-catalogues', { name: `Cat ${Math.random()}` })).body.data.id as string;

  it('creates a collection with Date values and a reference to a prize catalogue, and shows ISO strings', async () => {
    const prizeCatalogueId = await catalogue();
    const reply = await call('POST', '/fidelity/points-collections', { name: 'Autunno', pointConversion: 1, minAmount: 5, dateFrom: '2026-09-01T00:00:00Z', dateTo: '2026-12-31', pointsExpirationDate: null, prizeCatalogueId });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { id } = reply.body.data;
    assert.deepEqual(reply.body.data, { id, enabled: true, name: 'Autunno', pointConversion: 1, minAmount: 5, dateFrom: '2026-09-01T00:00:00.000Z', dateTo: '2026-12-31T00:00:00.000Z', pointsExpirationDate: null, prizeCatalogueId });
    const stored = (((await t.stored(0))['fidelity'] as Document)['pointsCollections'] as Document[]).find((item) => item['id'] === id)!;
    assert.deepEqual(stored, { id, status: true, name: 'Autunno', pointConversion: 1, minAmount: 5, dateFrom: new Date('2026-09-01T00:00:00Z'), dateTo: new Date('2026-12-31'), pointsExpirationDate: null, prizesCatalogId: prizeCatalogueId });
    assert.ok(stored['dateFrom'] instanceof Date);
  });

  it('refuses a missing prize catalogue, an end before the start and malformed dates', async () => {
    assert.deepEqual(failure(await call('POST', '/fidelity/points-collections', { name: 'x', prizeCatalogueId: 'nope' })), invalid(['prizeCatalogueId', 'incorrect']));
    assert.deepEqual(failure(await call('POST', '/fidelity/points-collections', { name: 'x', dateFrom: '2026-10-01', dateTo: '2026-09-01' })), invalid(['dateTo', 'incorrect']));
    assert.deepEqual(failure(await call('POST', '/fidelity/points-collections', { name: 'x', dateFrom: '2026-02-30' })), invalid(['dateFrom', 'format']));
    assert.deepEqual(failure(await call('POST', '/fidelity/points-collections', { name: 'x', minAmount: -1 })), invalid(['minAmount', 'minimum']));
  });

  it('modifies, empties with null, shows an invalid stored date as null and keeps the keys it does not manage', async () => {
    const { id } = (await call('POST', '/fidelity/points-collections', { name: 'Da modificare', dateFrom: '2026-01-01' })).body.data;
    const stored = (((await t.stored(0))['fidelity'] as Document)['pointsCollections'] as Document[]).map((item) => (item['id'] === id ? { ...item, legacy: 'x', dateTo: 'not a date', pointsExpirationDate: 5 } : item));
    await t.set(0, { 'fidelity.pointsCollections': stored });
    const shown = (await call('GET', '/fidelity/points-collections')).body.data.find((item: Document) => item['id'] === id);
    assert.deepEqual([shown.dateTo, shown.pointsExpirationDate, shown.dateFrom], [null, null, '2026-01-01T00:00:00.000Z']);
    const reply = await call('PATCH', `/fidelity/points-collections/${id}`, { dateFrom: null, name: 'Modificata', enabled: false });
    assert.deepEqual([reply.status, reply.body.data.dateFrom, reply.body.data.name, reply.body.data.enabled], [200, null, 'Modificata', false]);
    const after = ((await t.stored(0))['fidelity'] as Document)['pointsCollections'] as Document[];
    assert.equal(after.find((item) => item['id'] === id)!['legacy'], 'x');
    assert.equal(after.find((item) => item['id'] === id)!['dateFrom'], null);
  });

  it('cannot delete a collection a card type uses, nor a prize catalogue a collection uses', async () => {
    const prizeCatalogueId = await catalogue();
    const collection = (await call('POST', '/fidelity/points-collections', { name: 'Usata', prizeCatalogueId })).body.data.id as string;
    assert.deepEqual(failure(await call('DELETE', `/fidelity/prize-catalogues/${prizeCatalogueId}`)), conflict([`pointsCollections.${collection}`, 'referenced']));
    const card = (await call('POST', '/fidelity/card-types', { name: 'Con raccolta', pointsCollect: { enabled: true, collectionIds: [collection] } })).body.data.id as string;
    assert.deepEqual(failure(await call('DELETE', `/fidelity/points-collections/${collection}`)), conflict([`cardTypes.${card}`, 'referenced']));
    assert.equal((await call('DELETE', `/fidelity/card-types/${card}`)).status, 204);
    assert.equal((await call('DELETE', `/fidelity/points-collections/${collection}`)).status, 204);
    assert.equal((await call('DELETE', `/fidelity/prize-catalogues/${prizeCatalogueId}`)).status, 204);
  });

  it('refuses more than 50 collections', async () => {
    await t.set(1, { 'fidelity.pointsCollections': Array.from({ length: 50 }, (_unused, i) => ({ id: `p${i}`, status: true, name: `n${i}` })) });
    assert.deepEqual(failure(await call('POST', '/fidelity/points-collections', { name: 'x' }, 1)), invalid(['(body)', 'tooMany']));
  });
});

describe('/fidelity/card-types', () => {
  const firstList = async () => Object.keys((await t.stored(0))['priceLists'] as Document)[0]!;

  it('creates a card type in the legacy form, with ObjectId places', async () => {
    const priceListId = await firstList();
    const collection = (await call('POST', '/fidelity/points-collections', { name: 'Per carta' })).body.data.id as string;
    const mark = t.office.activity.entries.length;
    const reply = await call('POST', '/fidelity/card-types', {
      name: 'Gold',
      discountPercentage: 5,
      priceListId,
      prepaid: { enabled: true, type: 'mono', taxPercentage: 22 },
      pointsCollect: { enabled: true, collectionIds: [collection] },
      placeIds: [place1(), place2()],
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { id } = reply.body.data;
    assert.deepEqual(reply.body.data, {
      id,
      enabled: true,
      name: 'Gold',
      discountPercentage: 5,
      priceListId,
      prepaid: { enabled: true, type: 'mono', taxPercentage: 22 },
      pointsCollect: { enabled: true, collectionIds: [collection] },
      placeIds: [place1(), place2()],
    });
    const stored = (((await t.stored(0))['fidelity'] as Document)['cardsTypes'] as Document[]).find((item) => item['id'] === id)!;
    assert.deepEqual(stored, {
      id,
      status: true,
      name: 'Gold',
      discountPercentage: 5,
      priceListId,
      prepaid: { status: true, type: 'mono', taxPercentage: 22 },
      pointsCollect: { status: true, collectionIds: [collection] },
      placesAvailability: [t.group(0).ownPlaceId, t.group(0).otherPlaceId],
    });
    assert.ok((stored['placesAvailability'] as unknown[]).every((place) => place instanceof ObjectId));
    assert.deepEqual(events(mark), ['group.pointsCollection.created'].slice(0, 0).concat(['group.cardType.created']));
  });

  it('applies the defaults of a new card type', async () => {
    const reply = await call('POST', '/fidelity/card-types', { name: 'Base' });
    assert.deepEqual(
      { ...reply.body.data, id: undefined },
      { id: undefined, enabled: true, name: 'Base', discountPercentage: 0, priceListId: null, prepaid: { enabled: false, type: 'multi', taxPercentage: null }, pointsCollect: { enabled: false, collectionIds: [] }, placeIds: [] },
    );
  });

  it('checks the references it is given: price list, collections, places (trashed ones do not count)', async () => {
    const post = async (body: Document) => failure(await call('POST', '/fidelity/card-types', { name: 'x', ...body }));
    assert.deepEqual(await post({ priceListId: 'nope' }), invalid(['priceListId', 'incorrect']));
    assert.deepEqual(await post({ pointsCollect: { collectionIds: ['nope'] } }), invalid(['pointsCollect.collectionIds.0', 'incorrect']));
    assert.deepEqual(await post({ placeIds: [place1(), missing] }), invalid(['placeIds.1', 'incorrect']));
    assert.deepEqual(await post({ placeIds: [trashedPlace.hex] }), invalid(['placeIds.0', 'incorrect']));
    assert.deepEqual(await post({ placeIds: [t.group(1).ownPlaceId.toHexString()] }), invalid(['placeIds.0', 'incorrect']));
    assert.deepEqual(await post({ placeIds: [place1(), place1()] }), invalid(['placeIds.1', 'incorrect']));
    assert.deepEqual(await post({ placeIds: ['ABC'] }), invalid(['placeIds.0', 'minLength']));
    assert.deepEqual(await post({ discountPercentage: 101 }), invalid(['discountPercentage', 'maximum']));
    assert.deepEqual(await post({ prepaid: { type: 'x' } }), invalid(['prepaid.type', 'enum']));
    assert.deepEqual(await post({ placeIds: Array.from({ length: 501 }, () => place1()) }), invalid(['placeIds', 'tooMany']));
  });

  it('modifies by merge, keeps what it does not manage, does not recheck an old stale reference, and empties with null and []', async () => {
    const { id } = (await call('POST', '/fidelity/card-types', { name: 'Da modificare', placeIds: [place1()], priceListId: await firstList() })).body.data;
    const cards = ((await t.stored(0))['fidelity'] as Document)['cardsTypes'] as Document[];
    await t.set(0, {
      'fidelity.cardsTypes': cards.map((card) => (card['id'] === id ? { ...card, legacy: 1, prepaid: { ...(card['prepaid'] as Document), note: 'n' }, placesAvailability: [...(card['placesAvailability'] as unknown[]), new ObjectId()], priceListId: 'stale' } : card)),
    });
    const renamed = await call('PATCH', `/fidelity/card-types/${id}`, { name: 'Nuovo nome', prepaid: { enabled: true } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const after = (((await t.stored(0))['fidelity'] as Document)['cardsTypes'] as Document[]).find((card) => card['id'] === id)!;
    assert.deepEqual([after['legacy'], after['priceListId'], (after['placesAvailability'] as unknown[]).length, after['prepaid']], [1, 'stale', 2, { status: true, type: 'multi', taxPercentage: null, note: 'n' }]);
    assert.equal(renamed.body.data.placeIds.length, 2);
    const emptied = await call('PATCH', `/fidelity/card-types/${id}`, { priceListId: null, placeIds: [], pointsCollect: { collectionIds: [] } });
    assert.deepEqual([emptied.body.data.priceListId, emptied.body.data.placeIds], [null, []]);
    assert.deepEqual(failure(await call('PATCH', `/fidelity/card-types/${id}`, { priceListId: 'nope' })), invalid(['priceListId', 'incorrect']));
    assert.deepEqual(failure(await call('PATCH', `/fidelity/card-types/${id}`, {})), invalid(['(body)', 'required']));
    assert.deepEqual(failure(await call('PATCH', '/fidelity/card-types/unknown', { name: 'x' })), notFound);
  });

  it('refuses more than 50 card types', async () => {
    await t.set(1, { 'fidelity.cardsTypes': Array.from({ length: 50 }, (_unused, i) => ({ id: `k${i}`, status: true, name: `n${i}` })) });
    assert.deepEqual(failure(await call('POST', '/fidelity/card-types', { name: 'x' }, 1)), invalid(['(body)', 'tooMany']));
    const shown = (await call('GET', '/fidelity/card-types', undefined, 1)).body.data;
    assert.equal(shown.length, 50);
  });
});

describe('/product-favorites', () => {
  it('creates a list with the products in the order given, in the legacy form with ObjectId products', async () => {
    const reply = await call('POST', '/product-favorites', { name: 'Colazione', products: [{ productId: product.hex, position: 2 }, { productId: product2.hex }] });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { id } = reply.body.data;
    assert.deepEqual(reply.body.data, { id, name: 'Colazione', products: [{ productId: product.hex, position: 2 }, { productId: product2.hex, position: null }] });
    const stored = ((await t.stored(0))['productsFavorites'] as Document[]).find((item) => item['id'] === id)!;
    assert.deepEqual(stored, { id, name: 'Colazione', favorites: [{ _id: product.id, position: 2 }, { _id: product2.id, position: null }] });
    assert.ok((stored['favorites'] as Document[]).every((favorite) => favorite['_id'] instanceof ObjectId));
  });

  it('refuses unknown, trashed and repeated products and a list beyond the limits', async () => {
    const post = async (products: unknown[]) => failure(await call('POST', '/product-favorites', { name: 'x', products }));
    assert.deepEqual(await post([{ productId: product.hex }, { productId: missing }]), invalid(['products.1.productId', 'incorrect']));
    assert.deepEqual(await post([{ productId: trashedProduct.hex }]), invalid(['products.0.productId', 'incorrect']));
    assert.deepEqual(await post([{ productId: product.hex }, { productId: product.hex }]), invalid(['products.1.productId', 'incorrect']));
    assert.deepEqual(await post([{ productId: 'nope' }]), invalid(['products.0.productId', 'minLength']));
    assert.deepEqual(await post([{ productId: product.hex, position: -1 }]), invalid(['products.0.position', 'minimum']));
    assert.deepEqual(await post(Array.from({ length: 501 }, () => ({ productId: product.hex }))), invalid(['products', 'tooMany']));
  });

  it('modifies the name or the products, keeping the keys the backend does not manage (count, and per product)', async () => {
    const { id } = (await call('POST', '/product-favorites', { name: 'Con extra', products: [{ productId: product.hex, position: 1 }] })).body.data;
    const lists = (await t.stored(0))['productsFavorites'] as Document[];
    await t.set(0, { productsFavorites: lists.map((list) => (list['id'] === id ? { ...list, count: 4, favorites: (list['favorites'] as Document[]).map((favorite) => ({ ...favorite, note: 'n' })) } : list)) });
    const renamed = await call('PATCH', `/product-favorites/${id}`, { name: 'Rinominata' });
    assert.deepEqual([renamed.status, renamed.body.data.products], [200, [{ productId: product.hex, position: 1 }]]);
    const changed = await call('PATCH', `/product-favorites/${id}`, { products: [{ productId: product2.hex, position: 1 }, { productId: product.hex, position: 2 }] });
    assert.equal(changed.status, 200);
    const after = ((await t.stored(0))['productsFavorites'] as Document[]).find((list) => list['id'] === id)!;
    assert.deepEqual(after, { id, name: 'Rinominata', count: 4, favorites: [{ _id: product2.id, position: 1 }, { _id: product.id, position: 2, note: 'n' }] });
    const cleared = await call('PATCH', `/product-favorites/${id}`, { products: [] });
    assert.deepEqual(cleared.body.data.products, []);
    assert.equal((await call('DELETE', `/product-favorites/${id}`)).status, 204);
    assert.deepEqual(failure(await call('DELETE', `/product-favorites/${id}`)), notFound);
  });

  it('shows a stored list with products that are not ObjectIds without them, and refuses more than 50 lists', async () => {
    await t.set(1, { productsFavorites: [{ id: 'f', name: 'Strana', favorites: [{ _id: 'text', position: 1 }, { _id: new ObjectId(), position: 'x' }] }] });
    assert.equal((await call('GET', '/product-favorites', undefined, 1)).body.data[0].products.length, 1);
    await t.set(1, { productsFavorites: Array.from({ length: 50 }, (_unused, i) => ({ id: `f${i}`, name: `n${i}`, favorites: [] })) });
    assert.deepEqual(failure(await call('POST', '/product-favorites', { name: 'x' }, 1)), invalid(['(body)', 'tooMany']));
  });
});

describe('/promotions', () => {
  const full = (extra: Document = {}): Document => ({
    name: 'Estate',
    description: 'Sconto estivo',
    code: 'SUMMER',
    conditions: {
      placeIds: [place1()],
      startDate: '2026-06-01T00:00:00Z',
      endDate: '2026-08-31T23:59:59.000Z',
      customerIds: [contact.hex],
      contactGroupIds: [contactGroup.hex],
      maxUsesPerUser: 2,
      maxUsesTotal: 100,
      minAmount: 10,
      amountTax: 'tax_excluded',
      seatExcluded: true,
      products: { type: 'only_n', n: 2, qt: 3, productIds: [product.hex] },
      categories: { type: 'only_n', n: 1, categoryIds: [category.hex] },
    },
    actions: { discountType: 'on_products', discountValue: 15, discountValueType: 'percentage', productIds: [product2.hex], categoryIds: [category.hex], freeShipping: true },
    ...extra,
  });

  it('creates a promotion in the legacy form: string ids, ISO string dates, the names of the legacy', async () => {
    const mark = t.office.activity.entries.length;
    const reply = await call('POST', '/promotions', full());
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { id } = reply.body.data;
    assert.equal(reply.body.data.conditions.startDate, '2026-06-01T00:00:00.000Z');
    assert.deepEqual(reply.body.data.conditions.products, { type: 'only_n', n: 2, qt: 3, productIds: [product.hex] });
    const stored = ((await t.stored(0))['promotions'] as Document[]).find((item) => item['id'] === id)!;
    assert.deepEqual(stored, {
      id,
      status: true,
      name: 'Estate',
      description: 'Sconto estivo',
      code: 'SUMMER',
      conditions: {
        placesIds: [place1()],
        startDate: '2026-06-01T00:00:00.000Z',
        endDate: '2026-08-31T23:59:59.000Z',
        customersIds: [contact.hex],
        contactsGroupsIds: [contactGroup.hex],
        useForUsers: 2,
        totalAvailableNumber: 100,
        minAmount: 10,
        currency: 'EUR',
        amountTax: 'tax_excluded',
        seatExcluded: true,
        serviceExcluded: false,
        tipExcluded: false,
        deliveryExcluded: false,
        products: { type: 'only_n', n: 2, qt: 3, ids: [product.hex] },
        categories: { type: 'only_n', n: 1, ids: [category.hex] },
      },
      actions: { discountType: 'on_products', discountValue: 15, discountValueType: 'percentage', productsIds: [product2.hex], categoriesIds: [category.hex], freeShipping: true },
    });
    assert.deepEqual(events(mark), ['group.promotion.created']);
  });

  it('applies the defaults of the legacy form to a bare promotion', async () => {
    const reply = await call('POST', '/promotions', { name: 'Vuota' });
    assert.equal(reply.status, 201);
    const { id, ...rest } = reply.body.data;
    assert.deepEqual(rest.conditions.products, { type: null, n: 1, qt: 1, productIds: [] });
    assert.deepEqual([rest.enabled, rest.description, rest.code, rest.conditions.currency, rest.conditions.amountTax, rest.actions.discountValueType, rest.actions.discountType], [true, null, null, 'EUR', 'tax_included', 'percentage', null]);
    assert.ok(id);
  });

  it('verifies every reference it is given, in its own collection, and names the field', async () => {
    const post = async (patch: Document) => failure(await call('POST', '/promotions', { name: 'x', ...patch }));
    assert.deepEqual(await post({ conditions: { placeIds: [place1(), missing] } }), invalid(['conditions.placeIds.1', 'incorrect']));
    assert.deepEqual(await post({ conditions: { products: { productIds: [trashedProduct.hex] } } }), invalid(['conditions.products.productIds.0', 'incorrect']));
    assert.deepEqual(await post({ conditions: { categories: { categoryIds: [missing] } } }), invalid(['conditions.categories.categoryIds.0', 'incorrect']));
    assert.deepEqual(await post({ conditions: { customerIds: [missing] } }), invalid(['conditions.customerIds.0', 'incorrect']));
    assert.deepEqual(await post({ conditions: { contactGroupIds: [missing] } }), invalid(['conditions.contactGroupIds.0', 'incorrect']));
    assert.deepEqual(await post({ actions: { productIds: [missing] } }), invalid(['actions.productIds.0', 'incorrect']));
    assert.deepEqual(await post({ actions: { categoryIds: [missing] } }), invalid(['actions.categoryIds.0', 'incorrect']));
    // An id of another collection is not a reference.
    assert.deepEqual(await post({ conditions: { customerIds: [product.hex] } }), invalid(['conditions.customerIds.0', 'incorrect']));
  });

  it('checks the dates, the percentage and the shape of the body', async () => {
    const post = async (patch: Document) => failure(await call('POST', '/promotions', { name: 'x', ...patch }));
    assert.deepEqual(await post({ conditions: { startDate: '2026-09-01', endDate: '2026-08-01' } }), invalid(['conditions.endDate', 'incorrect']));
    assert.deepEqual(await post({ actions: { discountValue: 101 } }), invalid(['actions.discountValue', 'incorrect']));
    assert.equal((await call('POST', '/promotions', { name: 'x', actions: { discountValue: 101, discountValueType: 'amount' } })).status, 201);
    assert.deepEqual(await post({ conditions: { currency: 'eur' } }), invalid(['conditions.currency', 'pattern']));
    assert.deepEqual(await post({ conditions: { products: { n: 0 } } }), invalid(['conditions.products.n', 'minimum']));
    assert.deepEqual(await post({ actions: { discountType: 'on_all' } }), invalid(['actions.discountType', 'enum']));
    assert.deepEqual(await post({ conditions: { seats: true } }), invalid(['conditions.seats', 'unknown']));
    assert.deepEqual(await post({ conditions: { placeIds: Array.from({ length: 501 }, () => place1()) } }), invalid(['conditions.placeIds', 'tooMany']));
  });

  it('merges a partial modification into the nested objects and keeps the keys it does not manage', async () => {
    const { id } = (await call('POST', '/promotions', full())).body.data;
    const all = (await t.stored(0))['promotions'] as Document[];
    await t.set(0, { promotions: all.map((item) => (item['id'] === id ? { ...item, legacy: 'x', conditions: { ...(item['conditions'] as Document), note: 'n', products: { ...((item['conditions'] as Document)['products'] as Document), extra: 1 } } } : item)) });
    const reply = await call('PATCH', `/promotions/${id}`, { enabled: false, conditions: { minAmount: null, products: { n: 5 } }, actions: { freeShipping: false } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.enabled, reply.body.data.conditions.minAmount, reply.body.data.conditions.products, reply.body.data.conditions.seatExcluded, reply.body.data.actions.freeShipping, reply.body.data.actions.discountValue], [false, null, { type: 'only_n', n: 5, qt: 3, productIds: [product.hex] }, true, false, 15]);
    const after = ((await t.stored(0))['promotions'] as Document[]).find((item) => item['id'] === id)!;
    assert.deepEqual([after['legacy'], (after['conditions'] as Document)['note'], ((after['conditions'] as Document)['products'] as Document)['extra'], (after['conditions'] as Document)['minAmount']], ['x', 'n', 1, null]);
    // The stale references that are already there are not checked again; only what the request carries.
    assert.equal((await call('PATCH', `/promotions/${id}`, { conditions: { endDate: '2026-12-31' } })).status, 200);
    assert.deepEqual(failure(await call('PATCH', `/promotions/${id}`, { conditions: { startDate: '2027-01-01' } })), invalid(['conditions.endDate', 'incorrect']));
    assert.deepEqual(failure(await call('PATCH', `/promotions/${id}`, { actions: { productIds: [missing] } })), invalid(['actions.productIds.0', 'incorrect']));
    assert.equal((await call('DELETE', `/promotions/${id}`)).status, 204);
  });

  it('reads a promotion stored by the old client with its irregularities, and accepts a body of 150 kB', async () => {
    await t.set(1, {
      promotions: [
        { id: 'old', status: 1, name: 5, conditions: { placesIds: 'x', startDate: 'T', endDate: null, products: 'p', categories: { type: 'weird', ids: [1, 'a'] }, amountTax: 'zzz' }, actions: { discountType: 'other', discountValue: 'x' } },
        { id: 7 },
        'junk',
      ],
    });
    const shown = (await call('GET', '/promotions', undefined, 1)).body.data;
    assert.equal(shown.length, 2);
    assert.deepEqual([shown[0].enabled, shown[0].name, shown[0].conditions.placeIds, shown[0].conditions.startDate, shown[0].conditions.amountTax, shown[0].conditions.categories, shown[0].actions.discountType, shown[0].actions.discountValue], [false, '', [], null, 'tax_included', { type: null, n: 1, categoryIds: ['a'] }, null, 0]);
    // The route takes up to 256 kB: a body of 150 kB is read (and refused for what it says), one of 300 kB is too large.
    assert.deepEqual(failure(await call('POST', '/promotions', { name: 'Grande', pad: 'x'.repeat(150_000) })), invalid(['pad', 'unknown']));
    assert.equal((await call('POST', '/promotions', { name: 'Enorme', pad: 'x'.repeat(300_000) })).status, 413);
    assert.equal((await call('POST', '/product-favorites', { name: 'Enorme', pad: 'x'.repeat(150_000) })).status, 413);
    const many = Array.from({ length: 500 }, () => new ObjectId().toHexString());
    assert.deepEqual(failure(await call('POST', '/promotions', { name: 'Molti', conditions: { placeIds: many } })).details, Array.from({ length: 20 }, (_unused, i) => ({ field: `conditions.placeIds.${String(i)}`, issue: 'incorrect' })));
  });

  it('refuses more than 200 promotions', async () => {
    await t.set(1, { promotions: Array.from({ length: 200 }, (_unused, i) => ({ id: `p${i}`, status: true, name: `n${i}` })) });
    assert.deepEqual(failure(await call('POST', '/promotions', { name: 'x' }, 1)), invalid(['(body)', 'tooMany']));
    assert.deepEqual(failure(await t.as.call(t.group(0).ca, 'DELETE', t.path(0, '/promotions/zzz'))), notFound);
  });
});

describe('concurrency and ownership of the writes', () => {
  it('answers 409 when the document changed between the read and the write, and writes nothing', async () => {
    const { createCatalogsService } = await import('../../src/modules/groups/catalogs/catalogs.service.ts');
    const { createCatalogsRepository } = await import('../../src/modules/groups/catalogs/catalogs.repository.ts');
    const { createReferencesRepository } = await import('../../src/modules/groups/catalogs/references.repository.ts');
    const { CATALOGS } = await import('../../src/modules/groups/catalogs/registry.ts');
    const { memoryLogger } = await import('../helpers/app.ts');
    const { principalOf } = await import('../helpers/principal.ts');
    const real = createCatalogsRepository(t.ctx.databases);
    const racing = {
      ...real,
      read: async (...args: Parameters<typeof real.read>) => {
        const stored = await real.read(...args);
        await t.set(3, { name: 'changed by someone else', updateDate: new Date() });
        return stored;
      },
    };
    const service = createCatalogsService({ catalogs: racing, references: createReferencesRepository(t.ctx.databases), activityLog: t.office.activity, logger: memoryLogger().logger, newId: () => 'fixed-id', now: () => Date.now() });
    const before = await t.stored(3);
    const principal = principalOf('PSA', { matrix: undefined as never });
    const access = { groupId: t.group(3).groupId } as never;
    const taxes = CATALOGS.find((catalog) => catalog.name === 'tax')!;
    await assert.rejects(service.create(principal, access, taxes, { rate: 4, department: null, description: null, vatNature: null }, { requestId: 'r', ip: null } as never), (error: Document) => error['code'] === 'CONFLICT');
    assert.deepEqual((await t.stored(3))['taxes'], before['taxes']);
  });
});
