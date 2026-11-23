import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { ProductCatalogApi } from './product-catalog-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const URL = `${API}/v1/groups/${GROUP}/product-brands`;
const RECORD = { id: ID, name: { it: 'Acme' } };

function api(): ProductCatalogApi {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  return TestBed.inject(ProductCatalogApi);
}

afterEach(() => backend().verify());

describe('ProductCatalogApi', () => {
  it('builds the URLs encoding the ids', () => {
    const service = api();
    expect(service.baseUrl('a/b', 'product-brands')).toBe('/v1/groups/a%2Fb/product-brands');
    expect(service.itemUrl('g', 'product-brands', 'i?')).toBe('/v1/groups/g/product-brands/i%3F');
  });

  it('reads one entry with its version', async () => {
    const reading = api().read(GROUP, 'product-brands', ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('GET');
    request.flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    expect(await reading).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('has no version when the response has no ETag', async () => {
    const reading = api().read(GROUP, 'product-brands', ID);
    backend().expectOne(`${URL}/${ID}`).flush({ data: RECORD });
    expect((await reading).etag).toBeNull();
  });

  it('creates an entry with an Idempotency-Key', async () => {
    const creating = api().create(GROUP, 'product-brands', { name: { it: 'Acme' } }, 'key-1');
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({ name: { it: 'Acme' } });
    request.flush({ data: RECORD }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    expect((await creating).etag).toBe('"v1"');
  });

  it('updates with the version in If-Match, and without it when there is none', async () => {
    const service = api();
    const first = service.update(GROUP, 'product-brands', ID, { enabled: false }, '"v1"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual({ enabled: false });
    request.flush({ data: RECORD }, { headers: { ETag: '"v2"' } });
    expect((await first).etag).toBe('"v2"');
    const second = service.update(GROUP, 'product-brands', ID, { enabled: true }, null);
    const unconditional = backend().expectOne(`${URL}/${ID}`);
    expect(unconditional.request.headers.has('If-Match')).toBe(false);
    unconditional.flush({ data: RECORD });
    expect((await second).etag).toBeNull();
  });

  it('deletes an entry', async () => {
    const removing = api().remove(GROUP, 'product-brands', ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(removing).resolves.toBeUndefined();
  });
});
