import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { SecurityPolicyApi } from './security-policy-api';
import { POLICY } from '../../../testing/security-policy';

const URL_ = `${API}/v1/settings/security-policy`;

afterEach(() => backend().verify());

function api(): SecurityPolicyApi {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  return TestBed.inject(SecurityPolicyApi);
}

describe('SecurityPolicyApi', () => {
  it('reads the policy with its version', async () => {
    const result = api().read();
    backend()
      .expectOne(URL_)
      .flush({ data: POLICY }, { headers: { ETag: '"v1"' } });
    expect(await result).toEqual({ value: POLICY, etag: '"v1"' });
  });

  it('writes only the fields given, presenting the version', async () => {
    const result = api().write({ sustainedLimits: 'enforce' }, '"v1"');
    const request = backend().expectOne({ method: 'PUT', url: URL_ });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual({ sustainedLimits: 'enforce' });
    request.flush({ data: POLICY }, { headers: { ETag: '"v2"' } });
    expect((await result).etag).toBe('"v2"');
  });

  it('sends no If-Match without a version', async () => {
    const result = api().write({ nonBrowserRequests: 'report' }, null);
    const request = backend().expectOne({ method: 'PUT', url: URL_ });
    expect(request.request.headers.has('If-Match')).toBe(false);
    request.flush({ data: POLICY });
    expect((await result).etag).toBeNull();
  });
});
