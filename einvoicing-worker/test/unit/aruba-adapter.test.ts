import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createArubaAdapter } from '../../src/providers/aruba/adapter.ts';
import { ARUBA_LIMITS, ARUBA_TRANSMITTER } from '../../src/providers/aruba/settings.ts';
import { createArubaRig, live, memoryLimiters, testAccount, testFile } from '../helpers/aruba.ts';
import { createClock, createLogSink } from '../helpers/world.ts';

/** A `fetch` that records the URLs and answers like Aruba: no real network is used. */
function scriptedFetch() {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    return new Response(url.endsWith('/auth/signin') ? JSON.stringify({ access_token: 't', expires_in: 1800, refresh_token: 'r' }) : JSON.stringify({ errorCode: '0000', uploadFileName: 'ok.xml' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const adapterFor = (environment: 'demo' | 'production', fetchImpl: typeof fetch) => {
  const clock = createClock();
  return createArubaAdapter({
    environment,
    registry: { get: async () => testAccount() },
    limiters: memoryLimiters(),
    logger: createLogSink().logger,
    clock: clock.now,
    sleep: clock.sleep,
    fetch: fetchImpl,
  });
};

describe('Aruba adapter', () => {
  it('is the provider aruba, with its own transmitter and limits as data', () => {
    const adapter = adapterFor('demo', scriptedFetch().impl);
    assert.equal(adapter.provider, 'aruba');
    assert.equal(adapter.transmitter, ARUBA_TRANSMITTER);
    assert.equal(adapter.limits, ARUBA_LIMITS);
  });

  it('talks to the demo hosts in the demo environment and to the production hosts in production, and to nothing else', async () => {
    const demo = scriptedFetch();
    await adapterFor('demo', demo.impl).upload(testAccount(), testFile(), live());
    assert.deepEqual(demo.urls, ['https://demoauth.fatturazioneelettronica.aruba.it/auth/signin', 'https://demows.fatturazioneelettronica.aruba.it/services/invoice/upload']);
    const production = scriptedFetch();
    await adapterFor('production', production.impl).upload(testAccount(), testFile(), live());
    assert.deepEqual(production.urls, ['https://auth.fatturazioneelettronica.aruba.it/auth/signin', 'https://ws.fatturazioneelettronica.aruba.it/services/invoice/upload']);
  });

  it('routes status and findSent to their operations', async () => {
    const calls = scriptedFetch();
    const adapter = adapterFor('demo', calls.impl);
    await adapter.status(testAccount(), 'file.xml', live());
    await adapter.findSent(testAccount(), { ...testFile(), since: Date.now() }, live());
    assert.ok(calls.urls.some((url) => url.includes('/api/v2/invoices-out/detail?filename=file.xml')));
    assert.ok(calls.urls.some((url) => url.includes('/api/v2/invoices-out?senderCountry=IT')));
  });

  it('forgets the tokens of a hub: the next call signs in again', async () => {
    const rig = await createArubaRig();
    try {
      await rig.adapter.upload(rig.account, testFile(), live());
      await rig.adapter.upload(rig.account, testFile(), live());
      assert.equal(rig.fake.hits('POST /auth/signin').length, 1);
      rig.adapter.forget('aruba');
      rig.clock.advance(70_000);
      await rig.adapter.upload(rig.account, testFile(), live());
      assert.equal(rig.fake.hits('POST /auth/signin').length, 2);
    } finally {
      await rig.close();
    }
  });
});
