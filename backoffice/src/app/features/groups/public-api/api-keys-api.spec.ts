import { TestBed } from '@angular/core/testing';
import { fakeApiKey } from '../../../../testing/api-keys';
import { API, backend, provideApiTesting, settle } from '../../../../testing/api';
import { ApiKeysApi } from './api-keys-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const URL = `${API}/v1/groups/${GROUP}/api-keys`;

describe('ApiKeysApi', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: provideApiTesting() }));
  afterEach(() => backend().verify());

  it('builds the URL of the keys of a group', () => {
    expect(TestBed.inject(ApiKeysApi).url('a/b')).toBe('/v1/groups/a%2Fb/api-keys');
  });

  it('creates a key and hands the secret apart from the key', async () => {
    const created = TestBed.inject(ApiKeysApi).create(GROUP, {
      name: 'Webshop',
      permissions: ['places:read'],
    });
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Webshop', permissions: ['places:read'] });
    request.flush({ data: { ...fakeApiKey(), secret: 'fc_pk_FAKE' } }); // gitleaks:allow (fake test value)
    const { key, secret } = await created;
    expect(secret).toBe('fc_pk_FAKE'); // gitleaks:allow (fake test value)
    expect(key).toEqual(fakeApiKey());
    expect(key).not.toHaveProperty('secret');
  });

  it('updates a key with a merge patch', async () => {
    const updated = TestBed.inject(ApiKeysApi).update(GROUP, 'k/1', { name: 'Nuova' });
    const request = backend().expectOne(`${URL}/k%2F1`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ name: 'Nuova' });
    request.flush({ data: fakeApiKey({ name: 'Nuova' }) });
    expect((await updated).name).toBe('Nuova');
  });

  it('revokes a key without a body', async () => {
    const revoked = TestBed.inject(ApiKeysApi).revoke(GROUP, 'k1');
    await settle();
    const request = backend().expectOne(`${URL}/k1/revoke`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    request.flush({ data: fakeApiKey({ status: 'revoked' }) });
    expect((await revoked).status).toBe('revoked');
  });
});
