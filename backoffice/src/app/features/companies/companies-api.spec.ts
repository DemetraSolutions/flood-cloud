import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { ETAG, fakeCompany, GROUP, COMPANY } from '../../../testing/companies';
import { ReferenceStore } from '../../core/reference/reference-store';
import { CompaniesApi } from './companies-api';

const BASE = `${API}/v1/groups/${GROUP}/companies`;

function setup() {
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  const invalidate = vi
    .spyOn(TestBed.inject(ReferenceStore), 'invalidate')
    .mockImplementation(() => undefined);
  return { api: TestBed.inject(CompaniesApi), invalidate };
}

const KEY = '3f2b8c1e-6a4d-4f7b-9c2e-1a5d8b7e4c90'; // gitleaks:allow (fake test value)

afterEach(() => backend().verify());

describe('CompaniesApi', () => {
  it('builds the URLs of the companies', () => {
    const { api } = setup();
    expect(api.baseUrl('a b')).toBe('/v1/groups/a%20b/companies');
    expect(api.companyUrl('g', 'c/d')).toBe('/v1/groups/g/companies/c%2Fd');
  });

  it('creates a company and tells the store', async () => {
    const { api, invalidate } = setup();
    const done = api.create(GROUP, { name: 'N' }, KEY);
    const req = backend().expectOne(BASE);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'N' });
    expect(req.request.headers.get('Idempotency-Key')).toBe(KEY);
    req.flush(
      { data: fakeCompany() },
      { status: 201, statusText: 'Created', headers: { ETag: ETAG } },
    );
    expect(await done).toEqual({ company: fakeCompany(), etag: ETAG });
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'companies');
  });

  it('patches with the version, telling the store only for a new name or status', async () => {
    const { api, invalidate } = setup();
    const before = fakeCompany();
    const same = api.patch(GROUP, COMPANY, { phone: '1' }, ETAG, before);
    const req = backend().expectOne(`${BASE}/${COMPANY}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    req.flush({ data: fakeCompany({ phone: '1' }) }, { headers: { ETag: '"v2"' } });
    expect((await same).etag).toBe('"v2"');
    expect(invalidate).not.toHaveBeenCalled();

    const renamed = api.patch(GROUP, COMPANY, { name: 'X' }, ETAG, before);
    backend()
      .expectOne(`${BASE}/${COMPANY}`)
      .flush({ data: fakeCompany({ name: 'X' }) });
    await renamed;
    expect(invalidate).toHaveBeenCalledTimes(1);

    const disabled = api.patch(GROUP, COMPANY, { status: 'disabled' }, ETAG, before);
    backend()
      .expectOne(`${BASE}/${COMPANY}`)
      .flush({ data: fakeCompany({ status: 'disabled' }) });
    await disabled;
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('sends no If-Match without a version', async () => {
    const { api } = setup();
    const done = api.patch(GROUP, COMPANY, { phone: '1' }, null, fakeCompany());
    const req = backend().expectOne(`${BASE}/${COMPANY}`);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: fakeCompany() });
    await done;
  });

  it('reads the version of a company', async () => {
    const { api } = setup();
    const done = api.version(GROUP, COMPANY);
    backend()
      .expectOne(`${BASE}/${COMPANY}`)
      .flush({ data: fakeCompany() }, { headers: { ETag: '"v7"' } });
    expect(await done).toBe('"v7"');
  });

  it.each(['trash', 'restore'] as const)(
    '%s reads the version first and presents it',
    async (action) => {
      const { api, invalidate } = setup();
      const done = api[action](GROUP, COMPANY);
      backend()
        .expectOne(`${BASE}/${COMPANY}`)
        .flush({ data: fakeCompany() }, { headers: { ETag: '"v7"' } });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve));
      const req = backend().expectOne(`${BASE}/${COMPANY}/${action}`);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('If-Match')).toBe('"v7"');
      expect(req.request.body).toBeNull();
      req.flush({ data: fakeCompany() });
      await done;
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'companies');
    },
  );

  it('deletes with the version read first', async () => {
    const { api, invalidate } = setup();
    const done = api.remove(GROUP, COMPANY);
    backend()
      .expectOne(`${BASE}/${COMPANY}`)
      .flush({ data: fakeCompany() }, { headers: { ETag: '"v7"' } });
    await new Promise((resolve) => setTimeout(resolve));
    const req = backend().expectOne(`${BASE}/${COMPANY}`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('If-Match')).toBe('"v7"');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await done;
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'companies');
  });
});
