import { ObjectId } from 'mongodb';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTshClient, tshDigest } from '../../src/integrations/tsh/tsh-client.ts';
import { createDojoClient } from '../../src/integrations/dojo/dojo-client.ts';
import { createGeocodingClient } from '../../src/integrations/geocoding/geocoding-client.ts';
import { createSatispayClient } from '../../src/integrations/satispay/satispay-client.ts';
import { CredentialFormatError, createProviderCalls } from '../../src/integrations/provider-call.ts';
import type { CallProbe, CallRequest, CallSpec } from '../../src/integrations/provider-call.ts';
import { perUserRule } from '../../src/integrations/place-call.ts';
import { ProviderHttpError } from '../../src/integrations/http/index.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { InvalidProviderDataError } from '../../src/shared/integrations/errors.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { principalOf } from '../helpers/principal.ts';

const refusing: typeof fetch = async () => {
  throw new Error('no outgoing call expected');
};

describe('the digest of TS Hospitality', () => {
  it('is sha256(lowercase(sha256(lowercase(id) + secret)) + nonce) in hexadecimal', () => {
    assert.equal(tshDigest('Fake-Id', 's3cret', 'abc'), '95f9b13c93838d9a226d6e8cc2e428771aacb26b77b6da5a8268a7416a299925');
    // The id is lower-cased and the secret is not.
    assert.equal(tshDigest('FAKE-ID', 's3cret', 'abc'), tshDigest('fake-id', 's3cret', 'abc'));
    assert.notEqual(tshDigest('fake-id', 'S3CRET', 'abc'), tshDigest('fake-id', 's3cret', 'abc'));
  });
});

describe('the clients of the providers refuse what must not be sent, before any call', () => {
  it('TS Hospitality does not build a path from a property identifier that is not in the form of the field', async () => {
    const client = createTshClient({ authBaseUrl: 'https://auth.example', apiBaseUrl: 'https://api.example', testAuthBaseUrl: null, testApiBaseUrl: null, fetch: refusing });
    for (const propertyId of ['../x', 'a/b', 'a?b', 'a#b', '', 'a b', 'x'.repeat(65)]) {
      await assert.rejects(client.listChargeCategories({ id: 'i', secret: 's', propertyId, testMode: false }), /property identifier/, propertyId);
    }
  });

  it('Dojo does not send a key that cannot travel in a header', async () => {
    const client = createDojoClient({ baseUrl: 'https://dojo.example', resellerId: 'r', softwareHouseId: 's', apiVersion: '2024-02-05', fetch: refusing });
    for (const apiKey of ['', 'a b', 'a\r\nHost: evil', 'é', 'k'.repeat(513)]) {
      await assert.rejects(client.listTerminals(apiKey), CredentialFormatError, apiKey);
    }
  });

  it('every client says it is off without its configuration, and the ones that need a pair need both', () => {
    assert.equal(createDojoClient({ baseUrl: 'https://d.example', resellerId: 'r', softwareHouseId: null, apiVersion: 'v' }).available, false);
    assert.equal(createDojoClient({ baseUrl: 'https://d.example', resellerId: null, softwareHouseId: 's', apiVersion: 'v' }).available, false);
    assert.equal(createDojoClient({ baseUrl: 'https://d.example', resellerId: 'r', softwareHouseId: 's', apiVersion: 'v' }).available, true);
    assert.equal(createSatispayClient({ authBaseUrl: 'https://a.example', publicKey: null }).available, false);
    assert.equal(createSatispayClient({ authBaseUrl: null, publicKey: 'pem' }).available, false);
    assert.equal(createSatispayClient({ authBaseUrl: 'https://a.example', publicKey: 'pem' }).available, true);
    const tsh = (auth: string | null, api: string | null, testAuth: string | null, testApi: string | null) => createTshClient({ authBaseUrl: auth, apiBaseUrl: api, testAuthBaseUrl: testAuth, testApiBaseUrl: testApi });
    assert.deepEqual([tsh('https://a.example', null, null, null).available, tsh(null, 'https://a.example', null, null).available, tsh('https://a.example', 'https://b.example', null, null).available], [false, false, true]);
    assert.deepEqual([tsh(null, null, 'https://a.example', null).testAvailable, tsh(null, null, null, 'https://a.example').testAvailable, tsh(null, null, 'https://a.example', 'https://b.example').testAvailable], [false, false, true]);
    assert.equal(createGeocodingClient({ baseUrl: 'https://g.example', apiKey: null }).available, false);
    assert.equal(createGeocodingClient({ baseUrl: 'https://g.example', apiKey: new Secret('test-google-key-0123456789') }).available, true); // gitleaks:allow (fake test value)
  });
});

describe('the runner of the calls to the providers', () => {
  const principal = principalOf('SA', {});
  const request = (): CallRequest => ({ principal, groupId: 'g'.repeat(24), placeId: 'p'.repeat(24), group: new ObjectId(), context: { requestId: 'req-1', ip: null, userAgent: null } });
  const spec: CallSpec = { action: 'integrations.dojoTerminalsListed', category: 'data', provider: 'Dojo', credentialField: 'integrations.dojo.apiKey' };
  const harness = () => {
    const entries: Array<Record<string, any>> = [];
    const logs: Array<Record<string, unknown>> = [];
    let clock = 1000;
    const calls = createProviderCalls({
      activityLog: { record: async (entry) => void entries.push(entry as unknown as Record<string, any>) },
      logger: { debug: () => undefined, info: () => undefined, error: () => undefined, warn: (_message, fields) => void logs.push(fields ?? {}) },
      now: () => (clock += 5),
    });
    return { calls, entries, logs };
  };

  it('records a success with the duration, the count and the mode the work reported, and returns what the work returned', async () => {
    const { calls, entries } = harness();
    const result = await calls.run(spec, request(), async (probe) => {
      probe.count = 3;
      probe.testMode = true;
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(entries[0]!['metadata'], { outcome: 'ok', providerStatus: null, durationMs: 5, count: 3, testMode: true });
    assert.deepEqual([entries[0]!['outcome'], entries[0]!['ip']], ['success', undefined]);
  });

  it('records the address of the client when there is one', async () => {
    const { calls, entries } = harness();
    await calls.run(spec, { ...request(), context: { requestId: 'r', ip: '203.0.113.7', userAgent: null } }, async () => 1);
    assert.equal(entries[0]!['ip'], '203.0.113.7');
  });

  it('answers a data refusal of the provider as a 502 and records it, and logs only who, what, why, the status and the duration', async () => {
    const { calls, entries, logs } = harness();
    await assert.rejects(
      calls.run(spec, request(), () => Promise.reject(new InvalidProviderDataError('tshCategories'))),
      (error) => error instanceof AppError && error.code === 'PROVIDER_ERROR' && error.details === undefined && Object.keys(error.headers).length === 0,
    );
    assert.deepEqual([entries[0]!['outcome'], entries[0]!['metadata'].outcome], ['failure', 'providerError']);
    await assert.rejects(calls.run(spec, request(), () => Promise.reject(new ProviderHttpError('Dojo', 'terminals', 'status', 429))), (error) => error instanceof AppError && error.code === 'PROVIDER_ERROR');
    assert.deepEqual(logs, [{ provider: 'Dojo', operation: 'terminals', reason: 'status', status: 429, durationMs: 5 }]);
    assert.equal(entries[1]!['metadata'].providerStatus, 429);
  });

  it('answers a refusal of the platform\'s own credential as a 502, never as a 422 on a field', async () => {
    const { calls, entries } = harness();
    await assert.rejects(calls.run({ ...spec, credentialField: null }, request(), () => Promise.reject(new ProviderHttpError('Google Maps', 'geocode', 'status', 403))), (error) => error instanceof AppError && error.code === 'PROVIDER_ERROR');
    assert.equal(entries[0]!['metadata'].outcome, 'providerError');
  });

  it('lets an error that is not about the provider or the core go on, unrecorded, unless the work named an outcome for it', async () => {
    const { calls, entries } = harness();
    const bug = new Error('a database failure');
    await assert.rejects(calls.run(spec, request(), () => Promise.reject(bug)), (error) => error === bug);
    assert.equal(entries.length, 0);
    await assert.rejects(
      calls.run(spec, request(), (probe: CallProbe) => {
        probe.outcome = 'saveFailed';
        return Promise.reject(bug);
      }),
      (error) => error === bug,
    );
    assert.deepEqual([entries[0]!['outcome'], entries[0]!['metadata'].outcome, entries[0]!['metadata'].providerStatus], ['failure', 'saveFailed', null]);
  });

  it('reads the closed outcomes of the errors of the core', async () => {
    const { calls, entries } = harness();
    const cases: Array<[AppError, string, string]> = [
      [new AppError('SERVICE_UNAVAILABLE'), 'notConfigured', 'denied'],
      [new AppError('VALIDATION_ERROR', { details: [{ field: 'integrations.dojo.apiKey', issue: 'required' }] }), 'notConfigured', 'denied'],
      [new AppError('VALIDATION_ERROR', { details: [{ field: 'integrations.dojo.status', issue: 'incorrect' }] }), 'disabled', 'denied'],
      [new AppError('VALIDATION_ERROR', { details: [{ field: 'street', issue: 'incorrect' }] }), 'rejected', 'denied'],
      [new AppError('VALIDATION_ERROR'), 'rejected', 'denied'],
      [new AppError('FORBIDDEN'), 'rejected', 'denied'],
      [new AppError('PRECONDITION_FAILED'), 'rejected', 'denied'],
      [new AppError('NOT_FOUND'), 'rejected', 'denied'],
    ];
    for (const [error, outcome, activity] of cases) {
      await assert.rejects(calls.run(spec, request(), () => Promise.reject(error)), (thrown) => thrown === error);
      assert.deepEqual([entries.at(-1)!['metadata'].outcome, entries.at(-1)!['outcome']], [outcome, activity]);
    }
  });
});

describe('the rate limit rule of a user', () => {
  it('counts the calls of the authenticated user, per minute unless a window is given', () => {
    const userId = new ObjectId();
    const response = { locals: { auth: { userId } } } as never;
    const minute = perUserRule('integrations-x:user', 7);
    const hour = perUserRule('integrations-y:user', 9, 3600);
    assert.deepEqual([minute.bucket, minute.limit, minute.windowSeconds, minute.key({} as never, response)], ['integrations-x:user', 7, undefined, userId.toHexString()]);
    assert.deepEqual([hour.bucket, hour.limit, hour.windowSeconds], ['integrations-y:user', 9, 3600]);
  });
});
