import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { ETAG, fakePlace, GROUP, PLACE } from '../../../testing/places';
import { ReferenceStore } from '../../core/reference/reference-store';
import { toModel } from './place-model';
import { PlacesApi } from './places-api';
import { PlaceRecord, PlaceSection } from './place.types';

const BASE = `${API}/v1/groups/${GROUP}/places`;
const URL = `${BASE}/${PLACE}`;
const KEY = '3f2b8c1e-6a4d-4f7b-9c2e-1a5d8b7e4c90'; // gitleaks:allow (fake test value)

function setup() {
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  const invalidate = vi
    .spyOn(TestBed.inject(ReferenceStore), 'invalidate')
    .mockImplementation(() => undefined);
  return { api: TestBed.inject(PlacesApi), invalidate };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
});

describe('PlacesApi', () => {
  it('builds the URLs of the places', () => {
    const { api } = setup();
    expect(api.baseUrl('a b')).toBe('/v1/groups/a%20b/places');
    expect(api.placeUrl('g', 'p/q')).toBe('/v1/groups/g/places/p%2Fq');
  });

  it('creates a place with an Idempotency-Key and tells the store', async () => {
    const { api, invalidate } = setup();
    const done = api.create(GROUP, { name: 'N' }, KEY);
    const req = backend().expectOne(BASE);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'N' });
    expect(req.request.headers.get('Idempotency-Key')).toBe(KEY);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush(
      { data: fakePlace() },
      { status: 201, statusText: 'Created', headers: { ETag: ETAG } },
    );
    expect(await done).toEqual({ place: fakePlace(), etag: ETAG });
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
  });

  it('duplicates a place with an Idempotency-Key and tells the store', async () => {
    const { api, invalidate } = setup();
    const done = api.duplicate(GROUP, PLACE, KEY);
    const req = backend().expectOne(`${URL}/duplicate`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toBeNull();
    expect(req.request.headers.get('Idempotency-Key')).toBe(KEY);
    req.flush(
      { data: fakePlace() },
      { status: 201, statusText: 'Created', headers: { ETag: '"v9"' } },
    );
    expect((await done).etag).toBe('"v9"');
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
  });

  it('reads a place with its version', async () => {
    const { api, invalidate } = setup();
    const done = api.read(GROUP, PLACE);
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('GET');
    req.flush({ data: fakePlace() }, { headers: { ETag: '"v7"' } });
    expect(await done).toEqual({ place: fakePlace(), etag: '"v7"' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('reads a place without a version', async () => {
    const { api } = setup();
    const done = api.read(GROUP, PLACE);
    backend().expectOne(URL).flush({ data: fakePlace() });
    expect((await done).etag).toBeNull();
  });

  describe('patch', () => {
    const before = fakePlace();

    it('presents the version and sends the body', async () => {
      const { api } = setup();
      const done = api.patch(GROUP, PLACE, { email: 'x@y.it' }, ETAG, before);
      const req = backend().expectOne(URL);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({ email: 'x@y.it' });
      req.flush({ data: fakePlace({ email: 'x@y.it' }) }, { headers: { ETag: '"v2"' } });
      expect((await done).etag).toBe('"v2"');
    });

    it('sends no If-Match without a version', async () => {
      const { api } = setup();
      const done = api.patch(GROUP, PLACE, {}, null, before);
      const req = backend().expectOne(URL);
      expect(req.request.headers.has('If-Match')).toBe(false);
      req.flush({ data: before });
      await done;
    });

    const changes: [string, Partial<PlaceRecord>][] = [
      ['the name', { name: 'Altro' }],
      ['the company', { companyId: '665f1c2e9b1d4a0012ab34ff' }],
      ['the license status', { license: { ...before.license, status: 'disabled' } }],
      ['the trashed flag', { trashed: true }],
    ];

    it.each(changes)('tells the store when %s changed', async (_, change) => {
      const { api, invalidate } = setup();
      const done = api.patch(GROUP, PLACE, {}, ETAG, before);
      backend()
        .expectOne(URL)
        .flush({ data: fakePlace(change) });
      await done;
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
    });

    it('does not tell the store when nothing it shows changed', async () => {
      const { api, invalidate } = setup();
      const done = api.patch(GROUP, PLACE, {}, ETAG, before);
      backend()
        .expectOne(URL)
        .flush({
          data: fakePlace({
            phone: '1',
            license: { ...before.license, plan: 'basic', sentry: true },
          }),
        });
      await done;
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  describe('replace', () => {
    const sections: [Exclude<PlaceSection, 'general'>, string][] = [
      ['license', 'license'],
      ['openingHours', 'opening-hours'],
      ['cashSettings', 'settings/cash'],
      ['printing', 'settings/printing'],
      ['payments', 'settings/payments'],
      ['tables', 'settings/tables'],
      ['reservations', 'settings/reservations'],
      ['delivery', 'settings/delivery'],
      ['selfOrdering', 'settings/self-ordering'],
      ['kiosk', 'settings/kiosk'],
      ['appointments', 'settings/appointments'],
      ['externalDisplay', 'settings/external-display'],
      ['fidelity', 'settings/fidelity'],
      ['tobacco', 'settings/tobacco'],
      ['media', 'media'],
    ];

    it.each(sections)('puts the %s block at %s with the version', async (section, path) => {
      const { api, invalidate } = setup();
      const done = api.replace(GROUP, PLACE, section, { a: 1 }, ETAG, fakePlace());
      const req = backend().expectOne(`${URL}/${path}`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({ a: 1 });
      req.flush({ data: fakePlace() }, { headers: { ETag: '"v3"' } });
      expect((await done).etag).toBe('"v3"');
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('sends no If-Match without a version, and tells the store about a new status', async () => {
      const { api, invalidate } = setup();
      const before = fakePlace();
      const done = api.replace(GROUP, PLACE, 'license', {}, null, before);
      const req = backend().expectOne(`${URL}/license`);
      expect(req.request.headers.has('If-Match')).toBe(false);
      req.flush({ data: fakePlace({ license: { ...before.license, status: 'disabled' } }) });
      await done;
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
    });
  });

  describe('renew', () => {
    it('writes the whole license with the new date and the version just read', async () => {
      const { api, invalidate } = setup();
      const done = api.renew(GROUP, PLACE, '2032-05-06');
      backend()
        .expectOne(URL)
        .flush({ data: fakePlace() }, { headers: { ETag: '"v7"' } });
      await settle();
      const req = backend().expectOne(`${URL}/license`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe('"v7"');
      expect(req.request.body).toEqual({
        plan: 'advanced',
        expirationDate: '2032-05-06',
        status: 'active',
        sentry: false,
      });
      req.flush({ data: fakePlace() }, { headers: { ETag: '"v8"' } });
      expect((await done).etag).toBe('"v8"');
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('sends a null date for none', async () => {
      const { api } = setup();
      const done = api.renew(GROUP, PLACE, null);
      backend()
        .expectOne(URL)
        .flush({ data: fakePlace() }, { headers: { ETag: '"v7"' } });
      await settle();
      const req = backend().expectOne(`${URL}/license`);
      expect(req.request.body).toMatchObject({ expirationDate: null });
      req.flush({ data: fakePlace() });
      await done;
    });

    it('keeps the stored instant when the date is the same', async () => {
      const { api } = setup();
      const record = fakePlace();
      expect(toModel(record).license.expirationDate).toBe('2030-01-01');
      const done = api.renew(GROUP, PLACE, '2030-01-01');
      backend()
        .expectOne(URL)
        .flush({ data: record }, { headers: { ETag: '"v7"' } });
      await settle();
      const req = backend().expectOne(`${URL}/license`);
      expect(req.request.body).toMatchObject({ expirationDate: '2030-01-01T10:30:00.000Z' });
      req.flush({ data: record });
      await done;
    });
  });

  it.each(['trash', 'restore'] as const)(
    '%s reads the version first and presents it',
    async (action) => {
      const { api, invalidate } = setup();
      const done = api[action](GROUP, PLACE);
      const read = backend().expectOne(URL);
      expect(read.request.method).toBe('GET');
      read.flush({ data: fakePlace() }, { headers: { ETag: '"v7"' } });
      await settle();
      expect(invalidate).not.toHaveBeenCalled();
      const req = backend().expectOne(`${URL}/${action}`);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('If-Match')).toBe('"v7"');
      expect(req.request.body).toBeNull();
      req.flush({ data: fakePlace() });
      await done;
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
    },
  );

  it('trashes without If-Match when the read gave no version', async () => {
    const { api } = setup();
    const done = api.trash(GROUP, PLACE);
    backend().expectOne(URL).flush({ data: fakePlace() });
    await settle();
    const req = backend().expectOne(`${URL}/trash`);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: fakePlace() });
    await done;
  });

  it('removes a place reading the version first', async () => {
    const { api, invalidate } = setup();
    const done = api.remove(GROUP, PLACE);
    backend()
      .expectOne(URL)
      .flush({ data: fakePlace() }, { headers: { ETag: '"v7"' } });
    await settle();
    const req = backend().expectOne((r) => r.method === 'DELETE');
    expect(req.request.url).toBe(URL);
    expect(req.request.headers.get('If-Match')).toBe('"v7"');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await done;
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
  });

  it('does not tell the store when a write fails', async () => {
    const { api, invalidate } = setup();
    const done = api.remove(GROUP, PLACE);
    backend()
      .expectOne(URL)
      .flush({ data: fakePlace() }, { headers: { ETag: '"v7"' } });
    await settle();
    backend()
      .expectOne((r) => r.method === 'DELETE')
      .flush(
        { error: { code: 'CONFLICT', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await expect(done).rejects.toBeTruthy();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
