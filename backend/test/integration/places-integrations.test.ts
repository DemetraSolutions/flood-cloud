import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { PLACE_LEAVES } from '../../src/modules/places/place.mapper.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const P = (n: number): ObjectId => fixtureId('place', n);
const psa = () => world.office.cluster.psa;
const dealer = () => world.office.cluster.dealerA;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
const path = (id: ObjectId, rest = '') => world.placePath(0, `/${hex(id)}${rest}`);
const stored = async (id: ObjectId): Promise<Document> => (await world.storedPlace(0, id))!;
const integrationsOf = async (id: ObjectId): Promise<Record<string, Record<string, unknown>>> => (await stored(id))['integrations'] as Record<string, Record<string, unknown>>;
const tagOf = async (id: ObjectId): Promise<Record<string, string>> => ({ 'if-match': (await call(psa(), 'GET', path(id))).headers.get('etag')! });
const current = async (id: ObjectId) => (await call(psa(), 'GET', path(id))).body.data;
const put = async (actor: ObjectId, id: ObjectId, segment: string, body: unknown, headers?: Record<string, string>) => call(actor, 'PUT', path(id, `/${segment}`), body, headers ?? (await tagOf(id)));
const patch = async (actor: ObjectId, id: ObjectId, body: unknown, headers?: Record<string, string>) => call(actor, 'PATCH', path(id), body, headers ?? (await tagOf(id)));
const feed = (id: ObjectId) => ctx.databases.common().collection('reserve_with_google').findOne({ groupId: world.group(0).groupId, placeId: id });
const js = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Every credential of the integrations: where it is in the representation, a value in the form its provider gives it (all fake), and how the old backoffice and the integration service read it. */
const SECRETS: ReadonlyArray<readonly [string, string]> = [
  ['floodPay.stripe.privateKey', 'sk_test_fakeprivatekey123'], // gitleaks:allow (fake test value)
  ['floodPay.stripe.webhookPrivateKey', 'whsec_fakewebhooksecret123'], // gitleaks:allow (fake test value)
  ['easyappear.appToken', 'fake-app-token-1'],
  ['yellgo.apiKey', 'fake-yellgo-key-1'],
  ['leggimenu.apiKey', 'fake-leggimenu-key-1'],
  ['plateform.username', 'fake-plateform-user'],
  ['plateform.password', 'fake-plateform-pass'],
  ['cooperto.apiKey', 'fake-cooperto-key-1'],
  ['dojo.apiKey', 'fake-dojo-key-1'],
  ['satispay.activationCode', 'ABC123'],
  ['satispay.keyId', 'fake-satispay-key-id'],
  ['qodeup.apiKey', 'fake-qodeup-key-1'],
  ['tomatoai.apiKey', 'fake-tomatoai-key-1'],
  ['tsh.id', 'fake-tsh-id'],
  ['tsh.secret', 'fake-tsh-secret'],
  ['phlex.username', 'fake-phlex-user'],
  ['phlex.password', 'fake-phlex-pass'],
];
const nested = (dotted: string, value: unknown): Record<string, unknown> => dotted.split('.').reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;
/** Lays a tree over another, key by key. */
const deepAssign = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
  for (const [key, value] of Object.entries(source)) {
    const inner = target[key];
    target[key] = typeof value === 'object' && value !== null && typeof inner === 'object' && inner !== null ? deepAssign(inner as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return target;
};
const at = (tree: unknown, dotted: string): unknown => dotted.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree);

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 20);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('PUT …/integrations: the credentials', () => {
  it('has a credential for every secret key of the table, and no secret is ever read', () => {
    const writeOnly = PLACE_LEAVES.filter((leaf) => leaf.writeOnly === true).map((leaf) => leaf.domain.replace(/^integrations\./, ''));
    assert.deepEqual([...writeOnly].sort(), SECRETS.map(([key]) => key).sort());
  });

  it('writes each credential at its place, as the old backoffice and the integration service read it, and never returns, logs or reports it', async () => {
    await world.seedPlace(0, 300, 1);
    const mark = world.office.activity.entries.length;
    const merged: Record<string, unknown> = {};
    for (const [key, value] of SECRETS) {
      deepAssign(merged, nested(key, value));
    }
    // A PATCH with the nested object of every provider (a block with only some of its keys is fine for a modification).
    const reply = await patch(psa(), P(300), { integrations: merged });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await integrationsOf(P(300));
    for (const [key, value] of SECRETS) {
      assert.equal(at(after, key), value, key);
      assert.equal(at(reply.body.data.integrations, `${key}Set`), true, key);
      assert.equal(at(reply.body.data.integrations, key), undefined, key);
    }
    // What the integration service reads: Stripe, Satispay, Qodeup, Easy Appear.
    assert.deepEqual([after['qodeup']!['apiKey'], after['satispay']!['keyId'], after['easyappear']!['appToken']], ['fake-qodeup-key-1', 'fake-satispay-key-id', 'fake-app-token-1']);
    const everything = JSON.stringify([reply.body, world.office.activity.entries.slice(mark), world.office.logEvents]);
    for (const [, value] of SECRETS) {
      assert.ok(!everything.includes(value), value);
    }
    // The log names the block and nothing else.
    const entry = world.office.activity.entries.slice(mark).find((item) => item.action === 'place.updated')!;
    assert.deepEqual(entry.changes, [{ field: 'integrations', redacted: true }]);
  });

  it('keeps a credential that is left out, sends back the flags without effect, and clears with null or the empty text (as `$ne: null` of the integration service reads it)', async () => {
    await world.seedPlace(0, 301, 1);
    await patch(psa(), P(301), { integrations: { qodeup: { status: true, apiKey: 'fake-qodeup-key-1' }, dojo: { apiKey: 'fake-dojo-key-1' } } });
    const read = (await current(P(301))).integrations;
    assert.deepEqual([read.qodeup.apiKeySet, read.dojo.apiKeySet, read.tomatoai.apiKeySet], [true, true, false]);
    // The GET sent back as it is: nothing written, nothing lost.
    const before = await stored(P(301));
    assert.equal((await put(psa(), P(301), 'integrations', read)).status, 200);
    assert.ok(sameDocument(before, await stored(P(301))));
    // A change of another key keeps the credentials, even if the flag sent back lies.
    assert.equal((await put(psa(), P(301), 'integrations', { ...read, dojo: { ...read.dojo, status: true, apiKeySet: false } })).status, 200);
    assert.deepEqual([(await integrationsOf(P(301)))['dojo']!['apiKey'], (await integrationsOf(P(301)))['dojo']!['status']], ['fake-dojo-key-1', true]);
    const cleared = await put(psa(), P(301), 'integrations', { ...read, qodeup: { ...read.qodeup, apiKey: null }, dojo: { ...read.dojo, apiKey: '' } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual([(await integrationsOf(P(301)))['qodeup']!['apiKey'], (await integrationsOf(P(301)))['dojo']!['apiKey']], [null, null]);
    assert.deepEqual([cleared.body.data.integrations.qodeup.apiKeySet, cleared.body.data.integrations.dojo.apiKeySet], [false, false]);
  });

  it('checks the form the providers give a key where it is sent, and refuses what is too long without echoing it', async () => {
    await world.seedPlace(0, 302, 1);
    const bad = async (integrations: Document, ...expected: Array<[string, string]>) => assert.deepEqual(failure(await patch(psa(), P(302), { integrations })), issues(...expected), JSON.stringify(Object.keys(integrations)));
    await bad({ floodPay: { stripe: { privateKey: 'pk_test_xyz' } } }, ['integrations.floodPay.stripe.privateKey', 'pattern']);
    await bad({ floodPay: { stripe: { webhookPrivateKey: 'sk_test_xyz' } } }, ['integrations.floodPay.stripe.webhookPrivateKey', 'pattern']);
    await bad({ floodPay: { stripe: { publicKey: 'sk_test_xyz' } } }, ['integrations.floodPay.stripe.publicKey', 'pattern']);
    await bad({ satispay: { activationCode: 'AB 12' } }, ['integrations.satispay.activationCode', 'pattern']);
    await bad({ dojo: { apiKey: 'has a space' } }, ['integrations.dojo.apiKey', 'pattern']);
    await bad({ dojo: { apiKey: 'x'.repeat(513) } }, ['integrations.dojo.apiKey', 'maxLength']);
    await bad({ phlex: { password: 5 } }, ['integrations.phlex.password', 'type']);
    await bad({ satispay: { type: 'wire' } }, ['integrations.satispay.type', 'enum']);
    await bad({ floodPay: { qrCodePayment: { type: 'both' } } }, ['integrations.floodPay.qrCodePayment.type', 'enum']);
    await bad({ reserveWithGoogle: { geo: { latitude: 91 } } }, ['integrations.reserveWithGoogle.geo.latitude', 'maximum']);
    await bad({ reserveWithGoogle: { geo: { address: { country: 'Italia' } } } }, ['integrations.reserveWithGoogle.geo.address.country', 'maxLength']);
    await bad({ reserveWithGoogle: { geo: { address: { country: 'it' } } } }, ['integrations.reserveWithGoogle.geo.address.country', 'pattern']);
    await bad({ tsh: { categoriesMap: { 'a.b': 'x' } } }, ['integrations.tsh.categoriesMap.(key)', 'forbiddenKey']);
    await bad({ unknown: {} }, ['integrations.unknown', 'unknown']);
    const text = JSON.stringify(failure(await patch(psa(), P(302), { integrations: { dojo: { apiKey: 'has a space' } } })));
    assert.ok(!text.includes('has a space'));
    // A public key with the right form is accepted, and a historical one is kept where it does not change.
    assert.equal((await patch(psa(), P(302), { integrations: { floodPay: { stripe: { publicKey: 'pk_test_abc123' } } } })).status, 200);
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').updateOne({ _id: P(302) }, { $set: { 'integrations.floodPay.stripe.publicKey': 'historical key' } });
    assert.equal((await patch(psa(), P(302), { integrations: { floodPay: { stripe: { publicKey: 'historical key' } } } })).status, 200);
  });
});

describe('PUT …/integrations: the switches and the other keys', () => {
  it('lets only a PSA or a dealer change the switch of an integration, and any role that writes the place change its other keys', async () => {
    await world.seedPlace(0, 310, 1);
    const own = world.group(0).ownPlaceId;
    assert.equal((await patch(psa(), P(310), { integrations: { yellgo: { status: true } } })).status, 200);
    assert.equal((await patch(dealer(), P(310), { integrations: { leggimenu: { status: true } } })).status, 200);
    for (const actor of [sa(), ca()]) {
      assert.deepEqual(failure(await patch(actor, P(310), { integrations: { yellgo: { status: false }, dojo: { status: false } } })), notAllowed('integrations.yellgo.status', 'integrations.dojo.status'));
    }
    assert.deepEqual(failure(await put(pa(), own, 'integrations', { ...(await current(own)).integrations, googleMaps: { status: true } })), notAllowed('integrations.googleMaps.status'));
    // The keys of an integration are theirs: a group administrator sets the credential of a provider the dealer switched on, and the same switch sent back unchanged is not a change.
    const sent = await patch(sa(), P(310), { integrations: { yellgo: { status: true, apiKey: 'fake-yellgo-key-2' }, bizerba: { importPath: '/in', exportPath: '/out' } } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual([(await integrationsOf(P(310)))['yellgo'], (await integrationsOf(P(310)))['bizerba']], [{ status: true, apiKey: 'fake-yellgo-key-2' }, { status: false, importPath: '/in', exportPath: '/out' }]);
    assert.equal((await put(pa(), own, 'integrations', (await current(own)).integrations)).status, 200);
  });

  it('writes the other keys in the stored forms of the legacy and keeps the keys nobody owns of the integrations, the exact types and the order', async () => {
    await world.seedPlace(0, 311, 1, {
      integrations: {
        floodPay: { status: true, stripe: { publicKey: 'pk_live_abc', privateKey: 'sk_live_fakeprivate', webhookPrivateKey: null }, qrCodePayment: { status: false, type: 'static', rating: false, eReceipt: false, tips: false, postPaymentText: null }, tapToPay: { status: false, tips: false }, unknownFlood: 1 }, // gitleaks:allow (fake test value)
        plateform: { status: true, locationId: 'loc-1', username: 'u', password: 'p' },
        floodOrders: { enabled: true },
        tsh: { status: true, testMode: false, id: 'tsh-id', secret: 'tsh-secret', propertyId: 'prop', serviceName: 'svc', categoriesMap: { c1: 't1' }, tshCategories: [{ id: 't1', name: 'Bar' }, { id: 't2', name: 'Cucina' }, 'broken'] },
        reserveWithGoogle: { status: false, category: 'restaurant', name: null, telephone: null, url: null, geo: { latitude: null, longitude: null, address: { streetAddress: null, locality: null, postalCode: null, country: 'IT' } } },
      },
    });
    const read = (await current(P(311))).integrations;
    assert.deepEqual([read.floodPay.stripe.publicKey, read.floodPay.stripe.privateKeySet, read.floodPay.stripe.webhookPrivateKeySet, read.tsh.categoriesMap, read.tsh.categories], ['pk_live_abc', true, false, { c1: 't1' }, [{ id: 't1', name: 'Bar' }, { id: 't2', name: 'Cucina' }]]);
    assert.deepEqual([read.tsh.idSet, read.tsh.secretSet, read.tsh.propertyId, read.tsh.serviceName, read.floodOrders], [true, true, 'prop', 'svc', undefined]);
    const before = await stored(P(311));
    const reply = await put(psa(), P(311), 'integrations', {
      ...read,
      floodPay: { ...read.floodPay, qrCodePayment: { ...read.floodPay.qrCodePayment, status: true, type: 'dynamic', postPaymentText: 'Grazie' } },
      bizerba: { status: true, importPath: ' /in ', exportPath: '' },
      tsh: { ...read.tsh, categoriesMap: { c1: 't2' }, serviceName: 'svc2' },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await integrationsOf(P(311));
    assert.deepEqual(js(after['floodPay']), { status: true, stripe: { publicKey: 'pk_live_abc', privateKey: 'sk_live_fakeprivate', webhookPrivateKey: null }, qrCodePayment: { status: true, type: 'dynamic', rating: false, eReceipt: false, tips: false, postPaymentText: 'Grazie' }, tapToPay: { status: false, tips: false }, unknownFlood: 1 }); // gitleaks:allow (fake test value)
    assert.deepEqual(js(after['bizerba']), { status: true, importPath: '/in', exportPath: null });
    assert.deepEqual(js(after['tsh']), { status: true, testMode: false, id: 'tsh-id', secret: 'tsh-secret', propertyId: 'prop', serviceName: 'svc2', categoriesMap: { c1: 't2' }, tshCategories: [{ id: 't1', name: 'Bar' }, { id: 't2', name: 'Cucina' }, 'broken'] });
    // The integrations nobody owns and the keys of a provider nobody owns are exactly what they were.
    assert.ok(sameDocument({ v: (before['integrations'] as Document)['floodOrders'] }, { v: after['floodOrders'] }));
    assert.ok(sameDocument({ v: (before['integrations'] as Document)['plateform'] }, { v: after['plateform'] }));
    assert.ok(sameDocument({ v: (before['integrations'] as Document)['reserveWithGoogle'] }, { v: after['reserveWithGoogle'] }));
    assert.deepEqual(Object.keys(after).slice(0, 3), ['floodPay', 'plateform', 'floodOrders']);
    // The read-only list of the provider is accepted and ignored.
    assert.equal((await put(psa(), P(311), 'integrations', { ...reply.body.data.integrations, tsh: { ...reply.body.data.integrations.tsh, categories: [{ id: 'x', name: 'y' }] } })).status, 200);
    assert.deepEqual(js((await integrationsOf(P(311)))['tsh']!['tshCategories']), [{ id: 't1', name: 'Bar' }, { id: 't2', name: 'Cucina' }, 'broken']);
  });

  it('completes an integration that is missing in the stored place with the defaults of its keys', async () => {
    await world.seedPlace(0, 312, 1, { integrations: { dojo: { status: true, apiKey: 'fake-dojo-key-1' } } });
    assert.equal((await patch(psa(), P(312), { integrations: { satispay: { keyId: 'fake-satispay-key-id' } } })).status, 200);
    assert.deepEqual((await integrationsOf(P(312)))['satispay'], { status: false, activationCode: null, keyId: 'fake-satispay-key-id', type: 'checkin' });
    const read = (await current(P(312))).integrations;
    assert.deepEqual([read.satispay.type, read.floodPay.qrCodePayment.type, read.tsh.categoriesMap, read.tsh.categories, read.reserveWithGoogle.category], ['checkin', 'static', {}, [], 'restaurant']);
  });
});

describe('PUT …/integrations: Reserve with Google', () => {
  const RWG = { status: true, category: 'restaurant', name: 'Trattoria', telephone: '+39 02 1', url: 'https://example.test', geo: { latitude: 45.46, longitude: 9.19, address: { streetAddress: 'Via Roma 1', locality: 'Milano', postalCode: '20100', country: 'IT' } } };

  it('writes the feed when the integration is on and complete, updates it when it changes and removes it when it is off, in the same write', async () => {
    await world.seedPlace(0, 320, 1, { integrations: { reserveWithGoogle: { ...RWG, status: false, name: null, geo: { latitude: null, longitude: null, address: { streetAddress: null, locality: null, postalCode: null, country: 'IT' } } } } });
    await ctx.databases.common().collection('reserve_with_google').deleteMany({ placeId: P(320) });
    assert.equal(await feed(P(320)), null);
    const on = await patch(psa(), P(320), { integrations: { reserveWithGoogle: RWG } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const record = (await feed(P(320)))!;
    assert.deepEqual(js({ ...record, _id: undefined }), { groupId: hex(world.group(0).groupId), companyId: hex(fixtureId('company', 1)), placeId: hex(P(320)), category: 'restaurant', name: 'Trattoria', telephone: '+39 02 1', url: 'https://example.test', geo: { latitude: 45.46, longitude: 9.19, address: { streetAddress: 'Via Roma 1', locality: 'Milano', postalCode: '20100', country: 'IT' } } });
    assert.ok(record['geo'].latitude === 45.46);
    const document = (await integrationsOf(P(320)))['reserveWithGoogle']!;
    assert.ok((document['geo'] as Document)['latitude'] instanceof Double);
    // A change of the data is a change of the feed.
    assert.equal((await patch(psa(), P(320), { integrations: { reserveWithGoogle: { name: 'Osteria', telephone: null } } })).status, 200);
    assert.deepEqual([(await feed(P(320)))!['name'], (await feed(P(320)))!['telephone']], ['Osteria', null]);
    // A change of the company is too (the feed carries it).
    assert.equal((await patch(sa(), P(320), { companyId: hex(fixtureId('company', 2)) })).status, 200);
    assert.deepEqual((await feed(P(320)))!['companyId'], fixtureId('company', 2));
    // Off: removed; on again: written; in the trash: removed, and a change of a place in the trash does not bring it back.
    assert.equal((await patch(psa(), P(320), { integrations: { reserveWithGoogle: { status: false } } })).status, 200);
    assert.equal(await feed(P(320)), null);
    assert.equal((await patch(psa(), P(320), { integrations: { reserveWithGoogle: { status: true } } })).status, 200);
    assert.notEqual(await feed(P(320)), null);
    assert.equal((await call(psa(), 'POST', path(P(320), '/trash'), undefined, await tagOf(P(320)))).status, 200);
    assert.equal(await feed(P(320)), null);
    assert.equal((await patch(psa(), P(320), { integrations: { reserveWithGoogle: { name: 'In the trash' } } })).status, 200);
    assert.equal(await feed(P(320)), null);
    assert.equal((await call(psa(), 'POST', path(P(320), '/restore'), undefined, await tagOf(P(320)))).status, 200);
    assert.notEqual(await feed(P(320)), null);
    // The copy of the place is the same as ever.
    assert.ok(sameDocument({ ...(await stored(P(320))), groupId: world.group(0).groupId }, (await world.copyOfPlace(P(320)))!));
  });

  it('refuses an integration that is on without its data (the feed of the provider takes a complete one), and leaves one that is off as it is', async () => {
    await world.seedPlace(0, 321, 1, { integrations: { reserveWithGoogle: { status: false, category: 'restaurant', name: null, telephone: null, url: null, geo: { latitude: null, longitude: null, address: { streetAddress: null, locality: null, postalCode: null, country: 'IT' } } } } });
    assert.deepEqual(
      failure(await patch(psa(), P(321), { integrations: { reserveWithGoogle: { status: true } } })),
      issues(
        ['integrations.reserveWithGoogle.name', 'required'],
        ['integrations.reserveWithGoogle.geo.latitude', 'required'],
        ['integrations.reserveWithGoogle.geo.longitude', 'required'],
        ['integrations.reserveWithGoogle.geo.address.streetAddress', 'required'],
        ['integrations.reserveWithGoogle.geo.address.locality', 'required'],
        ['integrations.reserveWithGoogle.geo.address.postalCode', 'required'],
      ),
    );
    assert.deepEqual(failure(await patch(psa(), P(321), { integrations: { reserveWithGoogle: { ...RWG, geo: { ...RWG.geo, latitude: 0 } } } })), issues(['integrations.reserveWithGoogle.geo.latitude', 'required']));
    assert.equal((await patch(psa(), P(321), { integrations: { reserveWithGoogle: { name: 'Draft', telephone: '+39' } } })).status, 200, 'the data of an integration that is off needs nothing');
    assert.equal(await feed(P(321)), null);
    // The same rule when only a key of the data changes while the integration is on.
    assert.equal((await patch(psa(), P(321), { integrations: { reserveWithGoogle: RWG } })).status, 200);
    assert.deepEqual(failure(await patch(psa(), P(321), { integrations: { reserveWithGoogle: { name: null } } })), issues(['integrations.reserveWithGoogle.name', 'required']));
  });
});

describe('PUT …/integrations: the credentials of the payments', () => {
  it('are the PSA’s and the dealers’: any other role gets notAllowed to set, change or clear them, and can leave them out', async () => {
    await world.seedPlace(0, 350, 1);
    const own = world.group(0).ownPlaceId;
    const attempts: Array<[Document, string[]]> = [
      [{ dojo: { apiKey: 'fake-dojo-key-1' } }, ['integrations.dojo.apiKey']],
      [{ dojo: { apiKey: null } }, ['integrations.dojo.apiKey']],
      [{ floodPay: { stripe: { privateKey: 'sk_test_fakeprivatekey123' } } }, ['integrations.floodPay.stripe.privateKey']], // gitleaks:allow (fake test value)
      [{ floodPay: { stripe: { webhookPrivateKey: 'whsec_fakewebhooksecret123', publicKey: 'pk_test_abc' } } }, ['integrations.floodPay.stripe.publicKey', 'integrations.floodPay.stripe.webhookPrivateKey']], // gitleaks:allow (fake test value)
      [{ satispay: { activationCode: 'ABC123', keyId: 'fake-satispay-key-id' } }, ['integrations.satispay.activationCode', 'integrations.satispay.keyId']],
      [{ qodeup: { apiKey: 'fake-qodeup-key-1' } }, ['integrations.qodeup.apiKey']],
    ];
    for (const actor of [sa(), ca()]) {
      for (const [integrations, fields] of attempts) {
        assert.deepEqual(failure(await patch(actor, P(350), { integrations })), notAllowed(...fields), JSON.stringify(fields));
      }
    }
    assert.deepEqual(failure(await patch(pa(), own, { integrations: { dojo: { apiKey: 'fake-dojo-key-1' } } })), notAllowed('integrations.dojo.apiKey'));
    // The other credentials and the other keys are theirs, and a payment key left out is fine; the dealers set them all.
    assert.equal((await patch(sa(), P(350), { integrations: { yellgo: { apiKey: 'fake-yellgo-key-2' }, floodPay: { qrCodePayment: { tips: true } }, satispay: { type: 'qrcode' } } })).status, 200);
    for (const actor of [psa(), dealer()]) {
      assert.equal((await patch(actor, P(350), { integrations: Object.assign({}, ...attempts.map(([integrations]) => integrations).slice(0, 1)) })).status, 200);
    }
    assert.equal((await integrationsOf(P(350)))['dojo']!['apiKey'], 'fake-dojo-key-1');
  });

  it('refuses a credential that is not printable text or has a space at the ends, instead of changing it, and a device credential too', async () => {
    await world.seedPlace(0, 351, 1);
    for (const value of [' key', 'key ', 'ke\ny', 'ke\u0000y']) {
      assert.deepEqual(failure(await patch(psa(), P(351), { integrations: { yellgo: { apiKey: value } } })), issues(['integrations.yellgo.apiKey', 'pattern']), JSON.stringify(value));
      assert.deepEqual(failure(await put(psa(), P(351), 'devices', { items: [{ name: 'X', automaticCashPassword: value }] })), issues(['items.0.automaticCashPassword', 'pattern']), JSON.stringify(value));
    }
    assert.equal((await put(psa(), P(351), 'devices', { items: [{ name: 'X', automaticCashPassword: 'with inner space' }] })).status, 200);
    assert.equal((((await stored(P(351)))['devices'] as Document[])[0]!)['automaticCashPassword'], 'with inner space');
  });

  it('checks the url and the telephone that go to the feed of Google where they change', async () => {
    await world.seedPlace(0, 352, 1);
    assert.deepEqual(failure(await patch(psa(), P(352), { integrations: { reserveWithGoogle: { url: 'http://example.test' } } })), issues(['integrations.reserveWithGoogle.url', 'pattern']));
    assert.deepEqual(failure(await patch(psa(), P(352), { integrations: { reserveWithGoogle: { url: 'javascript:alert(1)', telephone: 'call me' } } })), issues(['integrations.reserveWithGoogle.telephone', 'pattern'], ['integrations.reserveWithGoogle.url', 'pattern']));
    assert.equal((await patch(psa(), P(352), { integrations: { reserveWithGoogle: { url: 'https://example.test/x', telephone: '+39 (02) 123-45' } } })).status, 200);
  });
});

describe('PUT …/settings/dealer', () => {
  it('is the PSA’s and the dealers’: the address of the server of the store and of the Connector, and the Sentry switch for the PSA alone', async () => {
    await world.seedPlace(0, 330, 1);
    const mark = world.office.activity.entries.length;
    const read = (await current(P(330))).dealerSettings;
    assert.deepEqual(read, { sentry: true, serverIp: '10.0.0.1', connectorAddress: 'http://connector.fixture.example.test' });
    const reply = await put(dealer(), P(330), 'settings/dealer', { ...read, serverIp: '192.168.1.20', connectorAddress: 'https://connector.example.test:8443/app' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.data.dealerSettings, { sentry: true, serverIp: '192.168.1.20', connectorAddress: 'https://connector.example.test:8443/app' });
    const document = await stored(P(330));
    assert.deepEqual([js(document['server']), document['connectorAddress'], js(document['platform'])], [{ ip: '192.168.1.20', port: 8080 }, 'https://connector.example.test:8443/app', { sentry: true, ip: false }]);
    assert.deepEqual(failure(await put(dealer(), P(330), 'settings/dealer', { ...read, sentry: false })), notAllowed('dealerSettings.sentry'));
    assert.equal((await put(psa(), P(330), 'settings/dealer', { sentry: false, serverIp: null, connectorAddress: '' })).status, 200);
    assert.deepEqual(js(((await stored(P(330)))['server'] as Document)), { ip: null, port: 8080 });
    assert.deepEqual([((await stored(P(330)))['platform'] as Document)['sentry'], (await stored(P(330)))['connectorAddress']], [false, '']);
    // Network data is in no log.
    const logs = JSON.stringify([world.office.activity.entries.slice(mark), world.office.logEvents]);
    for (const network of ['192.168.1.20', 'connector.example.test', '10.0.0.1']) {
      assert.ok(!logs.includes(network), network);
    }
    assert.ok(world.office.activity.entries.slice(mark).some((entry) => JSON.stringify(entry.changes) === JSON.stringify([{ field: 'dealerSettings', redacted: true }])));
  });

  it('checks the form of the address, and refuses the other roles without letting them see the block', async () => {
    await world.seedPlace(0, 331, 1);
    const bad = async (body: Document, ...expected: Array<[string, string]>) => assert.deepEqual(failure(await put(psa(), P(331), 'settings/dealer', { sentry: true, serverIp: null, connectorAddress: '', ...body })), issues(...expected), JSON.stringify(body));
    await bad({ serverIp: 'not an ip!' }, ['dealerSettings.serverIp', 'pattern']);
    await bad({ serverIp: 'x'.repeat(65) }, ['serverIp', 'maxLength']);
    await bad({ connectorAddress: 'ftp://example.test' }, ['dealerSettings.connectorAddress', 'pattern']);
    await bad({ connectorAddress: 'javascript:alert(1)' }, ['dealerSettings.connectorAddress', 'pattern']);
    await bad({ connectorAddress: 'http://a b' }, ['dealerSettings.connectorAddress', 'pattern']);
    await bad({ connectorAddress: `http://${'x'.repeat(256)}` }, ['connectorAddress', 'maxLength']);
    assert.deepEqual(failure(await put(psa(), P(331), 'settings/dealer', { sentry: true })), issues(['serverIp', 'required'], ['connectorAddress', 'required']));
    for (const actor of [sa(), ca()]) {
      assert.deepEqual(failure(await put(actor, P(331), 'settings/dealer', { sentry: true, serverIp: '1.1.1.1', connectorAddress: '' })), notAllowed('dealerSettings'));
    }
    assert.deepEqual(failure(await put(pa(), world.group(0).ownPlaceId, 'settings/dealer', { sentry: true, serverIp: '1.1.1.1', connectorAddress: '' })), notAllowed('dealerSettings'));
    // A historical address is read and sent back as it is.
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').updateOne({ _id: P(331) }, { $set: { 'server.ip': 'old host name', connectorAddress: 'legacy://x' } });
    const read = (await current(P(331))).dealerSettings;
    assert.deepEqual(read, { sentry: true, serverIp: 'old host name', connectorAddress: 'legacy://x' });
    assert.equal((await put(dealer(), P(331), 'settings/dealer', read)).status, 200);
  });
});

describe('the unique PATCH and what the JSON of the old backoffice covers', () => {
  it('takes in one request every block the legacy JSON covers (general, receipt, prebilling, ordering, roomsSettings) and the new blocks, and saves them as one write', async () => {
    await world.seedPlace(0, 340, 1);
    const read = await current(P(340));
    const reply = await patch(psa(), P(340), {
      cashSettings: { ...read.cashSettings, fastLogin: true },
      printing: { ...read.printing, receipt: { ...read.printing.receipt, giftReceipt: true } },
      tables: { ...read.tables, exits: true },
      devices: { items: [{ ...read.devices.items[0], name: 'Cassa unica' }, read.devices.items[1]] },
      printStations: { stations: [{ name: 'Bar', driver: 'ESCPOS', host: '10.0.0.9' }], productionCenters: read.printStations.productionCenters },
      storages: read.storages,
      integrations: { ...read.integrations, googleMaps: { status: true } },
      dealerSettings: { ...read.dealerSettings, connectorAddress: 'http://c.example.test' },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const document = await stored(P(340));
    assert.deepEqual([(document['general'] as Document)['fastLogin'], (document['receipt'] as Document)['giftReceipt'], (document['roomsSettings'] as Document)['exits'], ((document['devices'] as Document[])[0]!)['name'], ((document['printStations'] as Document[]).map((station) => station['name'])), (document['integrations'] as Document)['googleMaps'], document['connectorAddress']], [true, true, true, 'Cassa unica', ['Bar'], { status: true }, 'http://c.example.test']);
    const entry = world.office.activity.entries.filter((item) => item.action === 'place.updated').at(-1)!;
    assert.deepEqual(entry.changes!.map((change) => change.field).sort(), ['cashSettings', 'dealerSettings', 'devices', 'integrations', 'printStations', 'printing', 'tables']);
    assert.ok(entry.changes!.every((change) => change.redacted === true));
  });

  it('copies everything of a place, the credentials included, on the server, and returns none of them', async () => {
    await world.seedPlace(0, 341, 1);
    await patch(psa(), P(341), { integrations: { dojo: { apiKey: 'fake-dojo-key-1' } } });
    const source = await stored(P(341));
    const reply = await call(psa(), 'POST', path(P(341), '/duplicate'), undefined, { 'idempotency-key': crypto.randomUUID() });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const copy = (await world.storedPlace(0, ObjectId.createFromHexString(reply.body.data.id)))!;
    for (const key of ['devices', 'rooms', 'storages', 'printStations', 'productionCenter', 'integrations', 'server', 'connectorAddress']) {
      assert.ok(sameDocument({ v: source[key] }, { v: copy[key] }), key);
    }
    assert.ok(!JSON.stringify(reply.body).includes('fake-dojo-key-1'));
    assert.equal(reply.body.data.integrations.dojo.apiKeySet, true);
  });
});
