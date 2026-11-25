import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { ContactApi } from './contact-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const URL = `${API}/v1/groups/${GROUP}/contacts`;
const RECORD = { id: ID, code: 'C1' };
const CREATED = { status: 201, statusText: 'Created' };

function api(): ContactApi {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  return TestBed.inject(ContactApi);
}

afterEach(() => backend().verify());

describe('ContactApi', () => {
  it('builds the URL of the contacts of a group', () => {
    expect(api().baseUrl('a/b')).toBe('/v1/groups/a%2Fb/contacts');
  });

  it('reads a contact with its version', async () => {
    const reading = api().read(GROUP, ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('GET');
    request.flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    expect(await reading).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('creates a contact with an Idempotency-Key', async () => {
    const creating = api().create(GROUP, { code: 'C1' }, 'key-1');
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({ code: 'C1' });
    request.flush({ data: RECORD }, { ...CREATED, headers: { ETag: '"v1"' } });
    expect(await creating).toEqual({ item: RECORD, etag: '"v1"' });
  });

  it('updates a contact with its version in If-Match', async () => {
    const updating = api().update(GROUP, ID, { notes: 'x' }, '"v1"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual({ notes: 'x' });
    request.flush({ data: RECORD }, { headers: { ETag: '"v2"' } });
    expect((await updating).etag).toBe('"v2"');
  });

  it('trashes and restores a contact with the version, and without it when there is none', async () => {
    const service = api();
    const trashing = service.trash(GROUP, ID, '"v1"');
    const trash = backend().expectOne(`${URL}/${ID}/trash`);
    expect(trash.request.method).toBe('POST');
    expect(trash.request.headers.get('If-Match')).toBe('"v1"');
    trash.flush({ data: RECORD }, { headers: { ETag: '"v2"' } });
    expect(await trashing).toEqual({ item: RECORD, etag: '"v2"' });

    const restoring = service.restore(GROUP, ID, null);
    const restore = backend().expectOne(`${URL}/${ID}/restore`);
    expect(restore.request.method).toBe('POST');
    expect(restore.request.headers.has('If-Match')).toBe(false);
    restore.flush({ data: RECORD });
    expect(await restoring).toEqual({ item: RECORD, etag: null });
  });

  it('deletes a contact for good with the version, and without it when there is none', async () => {
    const service = api();
    const first = service.remove(GROUP, ID, '"v3"');
    const withVersion = backend().expectOne(`${URL}/${ID}`);
    expect(withVersion.request.method).toBe('DELETE');
    expect(withVersion.request.headers.get('If-Match')).toBe('"v3"');
    withVersion.flush(null, { status: 204, statusText: 'No Content' });
    await first;

    const second = service.remove(GROUP, ID, null);
    const without = backend().expectOne(`${URL}/${ID}`);
    expect(without.request.headers.has('If-Match')).toBe(false);
    without.flush(null, { status: 204, statusText: 'No Content' });
    await second;
  });

  it('moves many contacts to the trash in one call', async () => {
    const moving = api().trashMany(GROUP, ['a', 'b']);
    const request = backend().expectOne(`${URL}/trash`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ ids: ['a', 'b'] });
    const results = [
      { id: 'a', outcome: 'trashed' },
      { id: 'b', outcome: 'skipped', issue: 'conflict' },
    ];
    request.flush({ data: { results } });
    expect(await moving).toEqual({ results });
  });

  it('adjusts the points of a card with the code in the URL and an Idempotency-Key', async () => {
    const service = api();
    const withReason = service.adjustPoints(GROUP, ID, 'A/B 1', 5, 'gift', 'key-2');
    const first = backend().expectOne(`${URL}/${ID}/fidelity-cards/A%2FB%201/points-adjustments`);
    expect(first.request.method).toBe('POST');
    expect(first.request.headers.get('Idempotency-Key')).toBe('key-2');
    expect(first.request.body).toEqual({ delta: 5, reason: 'gift' });
    first.flush({ data: { code: 'A/B 1', points: 15 } });
    expect(await withReason).toEqual({ code: 'A/B 1', points: 15 });

    const withoutReason = service.adjustPoints(GROUP, ID, 'C1', -2, null, 'key-3');
    const second = backend().expectOne(`${URL}/${ID}/fidelity-cards/C1/points-adjustments`);
    expect(second.request.body).toEqual({ delta: -2 });
    second.flush({ data: { code: 'C1', points: 3 } });
    expect(await withoutReason).toEqual({ code: 'C1', points: 3 });
  });

  it('searches the companies, leaving out the contacts without a company name', async () => {
    const searching = api().searchCompanies(GROUP, 'Rossi');
    const request = backend().expectOne((r) => r.url === `${URL}`);
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('q')).toBe('Rossi');
    expect(request.request.params.get('limit')).toBe('25');
    request.flush({
      data: [
        { id: 'c1', company: { name: 'Rossi Srl', vatNumber: '' } },
        { id: 'c2', company: { name: '', vatNumber: '' } },
      ],
      page: { limit: 25, nextCursor: null },
    });
    expect(await searching).toEqual([{ value: 'c1', label: 'Rossi Srl' }]);
  });

  it('leaves out q when the text is empty', async () => {
    const service = api();
    const companies = service.searchCompanies(GROUP, '');
    const first = backend().expectOne((r) => r.url === URL);
    expect(first.request.params.has('q')).toBe(false);
    expect(first.request.params.get('limit')).toBe('25');
    first.flush({ data: [], page: { limit: 25, nextCursor: null } });
    expect(await companies).toEqual([]);

    const services = service.searchServices(GROUP, '');
    const second = backend().expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/products`);
    expect(second.request.params.has('q')).toBe(false);
    expect(second.request.params.get('family')).toBe('services');
    second.flush({ data: [], page: { limit: 25, nextCursor: null } });
    expect(await services).toEqual([]);
  });

  it('names the contacts that use a value, only the requested ones that have a display name', async () => {
    const naming = api().namesUsing(GROUP, 'C-1', ['a', 'b', 'c']);
    const request = backend().expectOne((r) => r.url === URL);
    expect(request.request.params.get('kind')).toBe('all');
    expect(request.request.params.get('q')).toBe('C-1');
    expect(request.request.params.get('limit')).toBe('6');
    request.flush({
      data: [
        { id: 'a', displayName: 'Anna Verdi' },
        { id: 'b', displayName: null },
        { id: 'z', displayName: 'Estranea' },
      ],
      page: { limit: 6, nextCursor: null },
    });
    expect(await naming).toEqual({ a: 'Anna Verdi' });
  });

  it('searches the contacts of any kind, labelled by display name, else code, else a short id', async () => {
    const service = api();
    const searching = service.searchContacts(GROUP, 'Anna');
    const request = backend().expectOne((r) => r.url === URL);
    expect(request.request.params.get('kind')).toBe('all');
    expect(request.request.params.get('q')).toBe('Anna');
    expect(request.request.params.get('limit')).toBe('25');
    request.flush({
      data: [
        { id: 'c1', displayName: 'Anna Verdi', code: 'C1' },
        { id: 'c2', displayName: null, code: 'C2' },
        { id: 'abcdef123456', displayName: null, code: '' },
      ],
      page: { limit: 25, nextCursor: null },
    });
    expect(await searching).toEqual([
      { value: 'c1', label: 'Anna Verdi' },
      { value: 'c2', label: 'C2' },
      { value: 'abcdef123456', label: '…123456' },
    ]);

    const first = service.searchContacts(GROUP, '');
    const page = backend().expectOne((r) => r.url === URL);
    expect(page.request.params.has('q')).toBe(false);
    expect(page.request.params.get('kind')).toBe('all');
    page.flush({ data: [], page: { limit: 25, nextCursor: null } });
    expect(await first).toEqual([]);
  });

  it('searches the service products, labelled by name, code or id', async () => {
    const searching = api().searchServices(GROUP, 'taglio');
    const request = backend().expectOne((r) => r.url === `${API}/v1/groups/${GROUP}/products`);
    expect(request.request.params.get('family')).toBe('services');
    expect(request.request.params.get('q')).toBe('taglio');
    expect(request.request.params.get('limit')).toBe('25');
    request.flush({
      data: [
        { id: 'p1', name: 'Taglio', code: 'T1' },
        { id: 'p2', name: null, code: 'T2' },
        { id: 'p3', name: null, code: null },
      ],
      page: { limit: 25, nextCursor: null },
    });
    expect(await searching).toEqual([
      { value: 'p1', label: 'Taglio' },
      { value: 'p2', label: 'T2' },
      { value: 'p3', label: 'p3' },
    ]);
  });
});
