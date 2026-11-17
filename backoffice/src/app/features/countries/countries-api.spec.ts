import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { Countries } from '../../core/reference/countries';
import { CountriesApi } from './countries-api';

const IT = { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }] };
const URL = `${API}/v1/countries`;

function setup() {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  const countries = TestBed.inject(Countries);
  const invalidate = vi.spyOn(countries, 'invalidate');
  return { api: TestBed.inject(CountriesApi), invalidate };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
});

describe('CountriesApi', () => {
  it('encodes the codes in the URLs', () => {
    const { api } = setup();
    expect(api.url('I/T')).toBe('/v1/countries/I%2FT');
    expect(api.url('IT', 'M/I')).toBe('/v1/countries/IT/areas/M%2FI');
  });

  it('reads a country with its version and does not invalidate the reference', async () => {
    const { api, invalidate } = setup();
    const reading = api.read('IT');
    const request = backend().expectOne(`${URL}/IT`);
    expect(request.request.method).toBe('GET');
    request.flush({ data: IT }, { headers: { ETag: '"v1"' } });
    expect(await reading).toEqual({ country: IT, etag: '"v1"' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('creates a country and invalidates the reference', async () => {
    const { api, invalidate } = setup();
    const creating = api.create({ code: 'IT', name: 'Italia' });
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ code: 'IT', name: 'Italia' });
    expect(request.request.headers.has('If-Match')).toBe(false);
    request.flush({ data: IT }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    expect(await creating).toEqual({ country: IT, etag: '"v1"' });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'rename',
      'PATCH',
      '/IT',
      { name: 'Italy' },
      (api: CountriesApi) => api.rename('IT', 'Italy', '"v1"'),
    ],
    [
      'addArea',
      'POST',
      '/IT/areas',
      { code: 'RM', name: 'Roma' },
      (api: CountriesApi) => api.addArea('IT', { code: 'RM', name: 'Roma' }, '"v1"'),
    ],
    [
      'renameArea',
      'PATCH',
      '/IT/areas/MI',
      { name: 'Milano 2' },
      (api: CountriesApi) => api.renameArea('IT', 'MI', 'Milano 2', '"v1"'),
    ],
    [
      'removeArea',
      'DELETE',
      '/IT/areas/MI',
      null,
      (api: CountriesApi) => api.removeArea('IT', 'MI', '"v1"'),
    ],
  ])(
    '%s presents the version and resolves with the new one',
    async (_name, method, path, body, call) => {
      const { api, invalidate } = setup();
      const changing = call(api);
      const request = backend().expectOne(`${URL}${path}`);
      expect(request.request.method).toBe(method);
      expect(request.request.body).toEqual(body);
      expect(request.request.headers.get('If-Match')).toBe('"v1"');
      request.flush({ data: IT }, { headers: { ETag: '"v2"' } });
      expect(await changing).toEqual({ country: IT, etag: '"v2"' });
      expect(invalidate).toHaveBeenCalledTimes(1);
    },
  );

  it('sends no If-Match when no version was read', async () => {
    const { api } = setup();
    const changing = api.rename('IT', 'Italy', null);
    const request = backend().expectOne(`${URL}/IT`);
    expect(request.request.headers.has('If-Match')).toBe(false);
    request.flush({ data: IT });
    expect((await changing).etag).toBeNull();
  });

  it('deletes a country with the version and invalidates the reference', async () => {
    const { api, invalidate } = setup();
    const removing = api.remove('IT', '"v1"');
    const request = backend().expectOne(`${URL}/IT`);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await removing;
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('sends no If-Match on a deletion without a version', async () => {
    const { api } = setup();
    const removing = api.remove('IT', null);
    const request = backend().expectOne(`${URL}/IT`);
    expect(request.request.headers.has('If-Match')).toBe(false);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await removing;
  });

  it('does not invalidate the reference when a write fails', async () => {
    const { api, invalidate } = setup();
    const changing = api.rename('IT', 'Italy', '"v1"');
    backend()
      .expectOne(`${URL}/IT`)
      .flush(
        { error: { code: 'PRECONDITION_FAILED', message: 'x' } },
        { status: 412, statusText: 'x' },
      );
    await expect(changing).rejects.toMatchObject({ status: 412 });
    await settle();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
