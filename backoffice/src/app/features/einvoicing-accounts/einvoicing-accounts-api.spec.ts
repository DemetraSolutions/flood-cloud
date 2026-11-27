import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { CONFIGURED, UNCONFIGURED } from '../../../testing/einvoicing';
import { EInvoicingAccountsApi } from './einvoicing-accounts-api';

const DEALER = '665f1c2e9b1d4a0012ab34d1';
const DEALER_URL = `${API}/v1/dealers/${DEALER}/integrations/aruba`;
const PLATFORM_URL = `${API}/v1/settings/integrations/aruba`;
const CHANGE = { enabled: true, username: 'u', maxPerHour: 55, maxPerYear: null };

afterEach(() => backend().verify());

function api(): EInvoicingAccountsApi {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  return TestBed.inject(EInvoicingAccountsApi);
}

describe('EInvoicingAccountsApi', () => {
  it('reads the account of a dealer or of the platform with its version', async () => {
    const service = api();
    const dealer = service.read(DEALER);
    backend()
      .expectOne(DEALER_URL)
      .flush({ data: UNCONFIGURED }, { headers: { ETag: '"v1"' } });
    expect(await dealer).toEqual({ value: UNCONFIGURED, etag: '"v1"' });
    const platform = service.read(null);
    backend()
      .expectOne(PLATFORM_URL)
      .flush({ data: CONFIGURED }, { headers: { ETag: '"p1"' } });
    expect(await platform).toEqual({ value: CONFIGURED, etag: '"p1"' });
  });

  it('writes with the version, and without one sends no If-Match', async () => {
    const service = api();
    const result = service.write(DEALER, CHANGE, '"v1"');
    const request = backend().expectOne({ method: 'PUT', url: DEALER_URL });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual(CHANGE);
    request.flush({ data: CONFIGURED }, { headers: { ETag: '"v2"' } });
    expect((await result).etag).toBe('"v2"');
    const bare = service.write(null, CHANGE, null);
    const second = backend().expectOne({ method: 'PUT', url: PLATFORM_URL });
    expect(second.request.headers.has('If-Match')).toBe(false);
    second.flush({ data: CONFIGURED });
    expect((await bare).etag).toBeNull();
  });

  it('removes with the version', async () => {
    const result = api().remove(DEALER, '"v2"');
    const request = backend().expectOne({ method: 'DELETE', url: DEALER_URL });
    expect(request.request.headers.get('If-Match')).toBe('"v2"');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(result).resolves.toBeUndefined();
  });
});
