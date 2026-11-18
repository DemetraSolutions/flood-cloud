import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { PriceListApi } from './price-list-api';

const LIST = { plans: { basic: 2000 }, services: { kiosk: 1500 } };

afterEach(() => backend().verify());

function api(): PriceListApi {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  return TestBed.inject(PriceListApi);
}

describe('PriceListApi', () => {
  it('reads the price list with its version', async () => {
    const result = api().read();
    backend()
      .expectOne(`${API}/v1/settings/price-list`)
      .flush({ data: LIST }, { headers: { ETag: '"v1"' } });
    expect(await result).toEqual({ value: LIST, etag: '"v1"' });
  });

  it('replaces the price list presenting the version, and returns the new one', async () => {
    const result = api().write(LIST, '"v1"');
    const request = backend().expectOne({ method: 'PUT', url: `${API}/v1/settings/price-list` });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual(LIST);
    request.flush({ data: LIST }, { headers: { ETag: '"v2"' } });
    expect(await result).toEqual({ value: LIST, etag: '"v2"' });
  });

  it('sends no If-Match without a version', async () => {
    const result = api().write(LIST, null);
    const request = backend().expectOne({ method: 'PUT', url: `${API}/v1/settings/price-list` });
    expect(request.request.headers.has('If-Match')).toBe(false);
    request.flush({ data: LIST });
    expect((await result).etag).toBeNull();
  });

  it('reads and replaces the overrides of a dealer', async () => {
    const prices = { overrides: { plans: { basic: 1800 } }, effective: LIST };
    const service = api();
    const read = service.readOverrides('d/1');
    backend()
      .expectOne(`${API}/v1/dealers/d%2F1/price-overrides`)
      .flush({ data: prices }, { headers: { ETag: '"o1"' } });
    expect(await read).toEqual({ value: prices, etag: '"o1"' });

    const write = service.writeOverrides('d/1', { services: { kiosk: 1 } }, '"o1"');
    const request = backend().expectOne({
      method: 'PUT',
      url: `${API}/v1/dealers/d%2F1/price-overrides`,
    });
    expect(request.request.headers.get('If-Match')).toBe('"o1"');
    expect(request.request.body).toEqual({ services: { kiosk: 1 } });
    request.flush({ data: prices }, { headers: { ETag: '"o2"' } });
    expect((await write).etag).toBe('"o2"');
  });
});
