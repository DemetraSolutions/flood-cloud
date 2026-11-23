import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { ProductApi } from './product-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const URL = `${API}/v1/groups/${GROUP}/products`;
const RECORD = { id: ID, name: { it: 'Acqua' } };
const CREATED = { status: 201, statusText: 'Created' };

function api(): ProductApi {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  return TestBed.inject(ProductApi);
}

afterEach(() => backend().verify());

describe('ProductApi', () => {
  it('builds the URL of the products of a group', () => {
    expect(api().baseUrl('a/b')).toBe('/v1/groups/a%2Fb/products');
  });

  it('reads a product with its version', async () => {
    const reading = api().read(GROUP, ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('GET');
    request.flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    expect(await reading).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('creates a product with an Idempotency-Key', async () => {
    const creating = api().create(GROUP, { name: { it: 'Acqua' } }, 'key-1');
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({ name: { it: 'Acqua' } });
    request.flush({ data: RECORD }, { ...CREATED, headers: { ETag: '"v1"' } });
    expect(await creating).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('updates a product with its version in If-Match', async () => {
    const updating = api().update(GROUP, ID, { code: 'X' }, '"v1"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual({ code: 'X' });
    request.flush({ data: RECORD }, { headers: { ETag: '"v2"' } });
    expect((await updating).etag).toBe('"v2"');
  });

  it('turns a product on or off after reading its version', async () => {
    const turning = api().setEnabled(GROUP, ID, false);
    const read = backend().expectOne(`${URL}/${ID}`);
    expect(read.request.method).toBe('GET');
    read.flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    const write = await vi.waitFor(() => backend().expectOne(`${URL}/${ID}`));
    expect(write.request.method).toBe('PATCH');
    expect(write.request.headers.get('If-Match')).toBe('"v1"');
    expect(write.request.body).toEqual({ enabled: false });
    write.flush({ data: { ...RECORD, enabled: false } }, { headers: { ETag: '"v2"' } });
    expect((await turning).etag).toBe('"v2"');
  });

  it('duplicates a product with an Idempotency-Key and no body', async () => {
    const copying = api().duplicate(GROUP, ID, 'key-2');
    const request = backend().expectOne(`${URL}/${ID}/duplicate`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-2');
    expect(request.request.body).toBeNull();
    request.flush({ data: RECORD }, { ...CREATED, headers: { ETag: '"v1"' } });
    expect(await copying).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('restores a product with the version, and without it when there is none', async () => {
    const service = api();
    const first = service.restore(GROUP, ID, '"v3"');
    const request = backend().expectOne(`${URL}/${ID}/restore`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('If-Match')).toBe('"v3"');
    request.flush({ data: RECORD }, { headers: { ETag: '"v4"' } });
    expect((await first).etag).toBe('"v4"');
    const second = service.restore(GROUP, ID, null);
    const unconditional = backend().expectOne(`${URL}/${ID}/restore`);
    expect(unconditional.request.headers.has('If-Match')).toBe(false);
    unconditional.flush({ data: RECORD });
    expect((await second).etag).toBeNull();
  });

  it('deletes a product for good with the version, and without it when there is none', async () => {
    const service = api();
    const first = service.remove(GROUP, ID, '"v3"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('If-Match')).toBe('"v3"');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(first).resolves.toBeUndefined();
    const second = service.remove(GROUP, ID, null);
    const unconditional = backend().expectOne(`${URL}/${ID}`);
    expect(unconditional.request.headers.has('If-Match')).toBe(false);
    unconditional.flush(null, { status: 204, statusText: 'No Content' });
    await expect(second).resolves.toBeUndefined();
  });

  it('moves many products to the trash with the ids in the body and no version', async () => {
    const trashing = api().trashMany(GROUP, ['a', 'b']);
    const request = backend().expectOne(`${URL}/trash`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.has('If-Match')).toBe(false);
    expect(request.request.body).toEqual({ ids: ['a', 'b'] });
    const results = [
      { id: 'a', outcome: 'trashed' },
      { id: 'b', outcome: 'skipped', issue: 'conflict' },
    ];
    request.flush({ data: { results } });
    expect(await trashing).toEqual({ results });
  });
});
