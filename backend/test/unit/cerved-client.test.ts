import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCervedClient, CervedError } from '../../src/integrations/cerved/index.ts';
import type { CervedClient, CervedHttpOptions } from '../../src/integrations/cerved/index.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { profileOf, searchOf, startFakeCerved, subject } from '../helpers/fake-cerved.ts';
import type { FakeCerved } from '../helpers/fake-cerved.ts';

const VAT = '12345678903';
// A throw-away value, only ever sent to the fake server on the loopback.
const KEY = 'test-key-0123456789abcdef'; // gitleaks:allow (fake test value)

let fake: FakeCerved;
const client = (http: CervedHttpOptions = {}, apiKey: Secret | null = new Secret(KEY)): CervedClient => createCervedClient({ apiKey, baseUrl: fake.baseUrl, ...http });

/** The reason a call failed with, or `undefined` when it did not fail. */
async function reasonOf(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof CervedError);
    return error.reason;
  }
  return undefined;
}

before(async () => {
  fake = await startFakeCerved();
});
after(() => fake.close());
afterEach(() => fake.reset());

describe('the Cerved client: the search', () => {
  it('sends the key in a header, the VAT number as the only parameter, and maps the company with every text trimmed', async () => {
    fake.onSearch = () =>
      searchOf(subject(VAT, { id_soggetto: ' 4242 ', denominazione: '  ROSSI SRL ', codice_fiscale: '', indirizzo: { descrizione: ' VIA ROMA 1 ', cap: 20100, descrizione_comune: 'MILANO', provincia: 'MI' } }));
    const company = await client().findCompanyByVat(VAT);
    assert.deepEqual(company, { subjectId: '4242', vatNumber: VAT, name: 'ROSSI SRL', fiscalCode: null, street: 'VIA ROMA 1', postcode: null, city: 'MILANO', province: 'MI' });
    assert.equal(fake.requests.length, 1);
    const [request] = fake.requests;
    assert.deepEqual([request!.method, request!.path, [...request!.query.keys()], request!.query.get('testoricerca'), request!.headers['apikey']], ['GET', '/cervedApi/v1/entitySearch/live', ['testoricerca'], VAT, KEY]);
  });

  it('takes only the subject whose VAT number is exactly the requested one, never the first of the list', async () => {
    fake.onSearch = () => searchOf(subject('99999999999', { denominazione: 'ALTRA SRL' }), { denominazione: 'SENZA PIVA' }, subject(`IT${VAT}`, { denominazione: 'PREFISSO' }), subject(` ${VAT} `, { denominazione: 'GIUSTA SRL', id_soggetto: 'abc-1' }));
    const company = await client().findCompanyByVat(VAT);
    assert.deepEqual([company?.name, company?.subjectId, company?.vatNumber], ['GIUSTA SRL', 'abc-1', VAT]);
  });

  it('answers null when no subject has that VAT number, or the list is empty', async () => {
    assert.equal(await client().findCompanyByVat(VAT), null);
    fake.onSearch = () => searchOf(subject('99999999999'), { not: 'a company' });
    assert.equal(await client().findCompanyByVat(VAT), null);
    fake.onSearch = () => ({ json: { companies: ['x', null, { dati_anagrafici: 'x' }, { dati_anagrafici: [] }, 7] } });
    assert.equal(await client().findCompanyByVat(VAT), null);
  });

  it('reads a company with no address and with an identifier it cannot use as having no subject', async () => {
    fake.onSearch = () => searchOf({ partita_iva: VAT, id_soggetto: 'a b&c', denominazione: 5, indirizzo: 'Via Roma' });
    assert.deepEqual(await client().findCompanyByVat(VAT), { subjectId: null, vatNumber: VAT, name: null, fiscalCode: null, street: null, postcode: null, city: null, province: null });
    fake.onSearch = () => searchOf({ partita_iva: VAT, id_soggetto: 1.5 });
    assert.equal((await client().findCompanyByVat(VAT))?.subjectId, null);
    fake.onSearch = () => searchOf({ partita_iva: VAT, id_soggetto: 'x'.repeat(65) });
    assert.equal((await client().findCompanyByVat(VAT))?.subjectId, null);
  });

  it('cuts a text that is too long', async () => {
    fake.onSearch = () => searchOf(subject(VAT, { denominazione: 'N'.repeat(1000) }));
    assert.equal((await client().findCompanyByVat(VAT))?.name?.length, 300);
  });

  it('encodes every parameter: a value cannot add a parameter, a fragment or a path', async () => {
    fake.onSearch = () => searchOf();
    await client().findCompanyByVat('1&apikey=x#frag/../y z');
    await client().findPec('7&testoricerca=1#x');
    const [search, profile] = fake.requests;
    assert.deepEqual([search!.path, [...search!.query.keys()], search!.query.get('testoricerca')], ['/cervedApi/v1/entitySearch/live', ['testoricerca'], '1&apikey=x#frag/../y z']);
    assert.deepEqual([profile!.path, [...profile!.query.keys()], profile!.query.get('id_soggetto')], ['/cervedApi/v1/entityProfile/live', ['id_soggetto'], '7&testoricerca=1#x']);
  });

  it('refuses an answer that is not an object with a list of companies', async () => {
    for (const json of [[], null, 'x', 7, {}, { companies: {} }, { companies: null }]) {
      fake.onSearch = () => ({ json });
      assert.equal(await reasonOf(client().findCompanyByVat(VAT)), 'malformed', JSON.stringify(json));
    }
  });
});

describe('the Cerved client: the profile', () => {
  it('reads the first PEC address and sends the identifier as the only parameter', async () => {
    fake.onProfile = () => profileOf(' pec@rossi.example ', 'second@rossi.example');
    assert.equal(await client().findPec('4242'), 'pec@rossi.example');
    const [request] = fake.requests;
    assert.deepEqual([request!.path, request!.query.get('id_soggetto'), request!.headers['apikey']], ['/cervedApi/v1/entityProfile/live', '4242', KEY]);
  });

  it('answers null when the profile has no usable address, whatever its shape', async () => {
    for (const json of [{}, [], null, { dati_anagrafici: null }, { dati_anagrafici: { pec: null } }, { dati_anagrafici: { pec: {} } }, { dati_anagrafici: { pec: { email: 'a@b.it' } } }, { dati_anagrafici: { pec: { email: [] } } }, { dati_anagrafici: { pec: { email: [5] } } }, { dati_anagrafici: { pec: { email: ['no at sign'] } } }, { dati_anagrafici: { pec: { email: [`${'a'.repeat(250)}@b.it`] } } }]) {
      fake.onProfile = () => ({ json });
      assert.equal(await client().findPec('4242'), null, JSON.stringify(json));
    }
  });
});

describe('the Cerved client: failures', () => {
  it('says the provider refused with a status, whatever the body, and never reads or keeps the body', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      fake.onSearch = () => ({ status, raw: 'provider secret detail' });
      assert.equal(await reasonOf(client().findCompanyByVat(VAT)), 'status', String(status));
    }
    fake.onProfile = () => ({ status: 500 });
    assert.equal(await reasonOf(client().findPec('1')), 'status');
    fake.onProfile = () => ({ status: 304 });
    assert.equal(await reasonOf(client().findPec('1')), 'status');
    try {
      fake.onSearch = () => ({ status: 500, raw: 'provider secret detail' });
      await client().findCompanyByVat(VAT);
      assert.fail('did not fail');
    } catch (error) {
      assert.ok(error instanceof CervedError);
      assert.deepEqual([error.name, error.operation, error.status, error.message], ['CervedError', 'search', 500, 'Cerved search failed: status (HTTP 500)']);
      assert.doesNotMatch(error.message, /secret|127\.0\.0\.1|testoricerca/);
    }
  });

  it('retries nothing: one call, one request', async () => {
    fake.onSearch = () => ({ status: 503 });
    await reasonOf(client().findCompanyByVat(VAT));
    assert.equal(fake.requests.length, 1);
  });

  it('refuses a body that is not JSON, or that is missing', async () => {
    for (const raw of ['', 'not json', '<html>', '{"companies":[']) {
      fake.onSearch = () => ({ raw });
      assert.equal(await reasonOf(client().findCompanyByVat(VAT)), 'malformed', raw);
    }
    fake.onSearch = () => ({ status: 204 });
    assert.equal(await reasonOf(client().findCompanyByVat(VAT)), 'malformed');
  });

  it('times out when the provider never answers, and when it stops in the middle of the body', async () => {
    fake.onSearch = () => ({ hang: true });
    assert.equal(await reasonOf(client({ timeoutMs: 100 }).findCompanyByVat(VAT)), 'timeout');
    fake.onSearch = () => ({ stallBody: true });
    assert.equal(await reasonOf(client({ timeoutMs: 100 }).findCompanyByVat(VAT)), 'timeout');
  });

  it('reports a network error when the connection is dropped, refused, or redirected', async () => {
    fake.onSearch = () => ({ drop: true });
    assert.equal(await reasonOf(client().findCompanyByVat(VAT)), 'network');
    fake.onSearch = () => ({ status: 302, headers: { location: 'http://127.0.0.1:1/elsewhere' } });
    assert.equal(await reasonOf(client().findCompanyByVat(VAT)), 'network');
    assert.equal(fake.requests.length, 2, 'the redirect is not followed');
    const refused = createCervedClient({ apiKey: new Secret(KEY), baseUrl: 'http://127.0.0.1:1' });
    assert.equal(await reasonOf(refused.findCompanyByVat(VAT)), 'network');
  });

  it('refuses a body that is too large, declared or streamed, and stops reading it', async () => {
    fake.onSearch = () => ({ raw: ' '.repeat(2000), json: undefined });
    assert.equal(await reasonOf(client({ maxBodyBytes: 1000 }).findCompanyByVat(VAT)), 'tooLarge');
    fake.onSearch = () => ({ streamMegabytes: 3 });
    assert.equal(await reasonOf(client().findCompanyByVat(VAT)), 'tooLarge');
    fake.onSearch = () => ({ json: { companies: [] } });
    assert.equal(await client({ maxBodyBytes: 1000 }).findCompanyByVat(VAT), null);
  });

  it('has no key: it says so, asks the provider nothing and never reveals anything', async () => {
    const keyless = client({}, null);
    assert.equal(keyless.available, false);
    assert.equal(client().available, true);
    assert.equal(await reasonOf(keyless.findCompanyByVat(VAT)), 'configuration');
    assert.equal(await reasonOf(keyless.findPec('1')), 'configuration');
    assert.equal(fake.requests.length, 0);
  });

  it('does not let a body that cannot be cancelled change the outcome: a refused answer is still a status, anything else a network error', async () => {
    const stubborn = (init: ResponseInit, size = 0): Response => new Response(new ReadableStream({ start: (controller) => size > 0 && controller.enqueue(new Uint8Array(size)), cancel: () => Promise.reject(new Error('cannot cancel')) }), init);
    assert.equal(await reasonOf(client({ fetch: async () => stubborn({ status: 500 }) }).findCompanyByVat(VAT)), 'status');
    assert.equal(await reasonOf(client({ fetch: async () => stubborn({ status: 500 }) }).findPec('1')), 'status');
    assert.equal(await reasonOf(client({ fetch: async () => stubborn({ status: 200, headers: { 'content-length': '5000' } }), maxBodyBytes: 1000 }).findCompanyByVat(VAT)), 'network');
    assert.equal(await reasonOf(client({ fetch: async () => stubborn({ status: 200 }, 2000), maxBodyBytes: 1000 }).findCompanyByVat(VAT)), 'network');
  });

  it('uses the injected fetch', async () => {
    const seen: string[] = [];
    const stub: typeof fetch = async (input, init) => {
      seen.push(`${String(input)} ${JSON.stringify(init?.headers)}`);
      return Response.json({ companies: [] });
    };
    assert.equal(await client({ fetch: stub }).findCompanyByVat(VAT), null);
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, new RegExp(`^${fake.baseUrl}/cervedApi/v1/entitySearch/live\\?testoricerca=${VAT} `));
  });
});
