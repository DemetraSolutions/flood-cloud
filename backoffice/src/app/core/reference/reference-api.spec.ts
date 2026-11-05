import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { REFERENCE_PAGE_SIZE, ReferenceApi } from './reference-api';

const PAGE = { data: [{ id: 'a', name: 'A' }], page: { limit: 25, next: null } };

describe('ReferenceApi', () => {
  let api: ReferenceApi;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    api = TestBed.inject(ReferenceApi);
  });
  afterEach(() => backend().verify());

  it('reads groups with the default page size and no empty parameters', async () => {
    const result = api.groups();
    const request = backend().expectOne((r) => r.url === `${API}/v1/groups`);
    expect(request.request.params.keys()).toEqual(['limit']);
    expect(request.request.params.get('limit')).toBe(String(REFERENCE_PAGE_SIZE));
    request.flush(PAGE);
    expect(await result).toEqual(PAGE);
  });

  it('sends the trimmed search text and the cursor', async () => {
    const result = api.groups({ q: '  alfa ', cursor: 'c1', limit: 5 });
    const request = backend().expectOne((r) => r.url === `${API}/v1/groups`);
    expect(request.request.params.get('q')).toBe('alfa');
    expect(request.request.params.get('cursor')).toBe('c1');
    expect(request.request.params.get('limit')).toBe('5');
    request.flush(PAGE);
    await result;
  });

  it('ignores a blank search text', async () => {
    const result = api.groups({ q: '   ', cursor: null });
    const request = backend().expectOne((r) => r.url === `${API}/v1/groups`);
    expect(request.request.params.has('q')).toBe(false);
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush(PAGE);
    await result;
  });

  it('reads the companies of a group', async () => {
    const result = api.companies('g/1');
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups/g%2F1/companies`)
      .flush(PAGE);
    await result;
  });

  it('reads the stores of a group, optionally of one company', async () => {
    const result = api.places('g1', { companyId: 'c1' });
    const request = backend().expectOne((r) => r.url === `${API}/v1/groups/g1/places`);
    expect(request.request.params.get('companyId')).toBe('c1');
    request.flush(PAGE);
    await result;
  });
});
