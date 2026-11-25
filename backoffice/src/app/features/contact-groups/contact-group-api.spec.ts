import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { ContactGroupApi } from './contact-group-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const URL = `${API}/v1/groups/${GROUP}/contact-groups`;
const RECORD = { id: ID, name: 'Regulars', priceListId: null, discountPercent: null };

function api(): ContactGroupApi {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  return TestBed.inject(ContactGroupApi);
}

afterEach(() => backend().verify());

describe('ContactGroupApi', () => {
  it('builds the URL encoding the id of the group', () => {
    expect(api().baseUrl('a/b')).toBe('/v1/groups/a%2Fb/contact-groups');
  });

  it('reads one group of contacts with its version', async () => {
    const reading = api().read(GROUP, ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('GET');
    request.flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    expect(await reading).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('creates a group of contacts with an Idempotency-Key', async () => {
    const creating = api().create(GROUP, { name: 'Regulars' }, 'key-1');
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({ name: 'Regulars' });
    request.flush(
      { data: RECORD },
      { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } },
    );
    expect(await creating).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('updates with the version in If-Match', async () => {
    const updating = api().update(GROUP, ID, { name: 'VIP' }, '"v1"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual({ name: 'VIP' });
    request.flush({ data: RECORD }, { headers: { ETag: '"v2"' } });
    expect((await updating).etag).toBe('"v2"');
  });

  it('deletes with the version in If-Match, or without it when there is none', async () => {
    const service = api();
    const first = service.remove(GROUP, ID, '"v1"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(first).resolves.toBeUndefined();
    const second = service.remove(GROUP, ID, null);
    const unconditional = backend().expectOne(`${URL}/${ID}`);
    expect(unconditional.request.headers.has('If-Match')).toBe(false);
    unconditional.flush(null, { status: 204, statusText: 'No Content' });
    await second;
  });
});
