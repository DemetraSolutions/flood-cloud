import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import {
  MAX_LOOKUP_IDS,
  MAX_NAME_PAGES,
  MAX_PERIMETER_PAGES,
  REFERENCE_PAGE_SIZE,
  ReferenceApi,
} from './reference-api';

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

  it('reads the services of a group', async () => {
    const result = api.services('g/1', { q: 'bar' });
    const request = backend().expectOne((r) => r.url === `${API}/v1/groups/g%2F1/services`);
    expect(request.request.params.get('q')).toBe('bar');
    request.flush(PAGE);
    expect(await result).toEqual(PAGE);
  });

  describe('serviceNames', () => {
    const SERVICES = `${API}/v1/groups/g1/services`;
    const page = (ids: string[], next: string | null) => ({
      data: ids.map((id) => ({ id, name: `Name ${id}` })),
      page: { limit: 100, next },
    });
    const expectPage = (cursor: string | null) => {
      const request = backend().expectOne((r) => r.url === SERVICES);
      expect(request.request.params.get('limit')).toBe('100');
      expect(request.request.params.get('cursor')).toBe(cursor);
      return request;
    };
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

    it('resolves the names found in one page and ignores other services', async () => {
      const result = api.serviceNames('g1', ['a', 'b']);
      expectPage(null).flush(page(['a', 'x', 'b'], 'more'));
      expect(await result).toEqual({ a: 'Name a', b: 'Name b' });
    });

    it('does not read anything when no ids are asked', async () => {
      expect(await api.serviceNames('g1', [])).toEqual({});
    });

    it('follows the cursor until every id is found', async () => {
      const result = api.serviceNames('g1', ['a', 'c']);
      expectPage(null).flush(page(['a'], 'c1'));
      await settle();
      expectPage('c1').flush(page(['b', 'c'], 'c2'));
      expect(await result).toEqual({ a: 'Name a', c: 'Name c' });
    });

    it('stops when the list ends and leaves the ids not found out', async () => {
      const result = api.serviceNames('g1', ['a', 'zzz']);
      expectPage(null).flush(page(['a'], 'c1'));
      await settle();
      expectPage('c1').flush(page(['b'], null));
      expect(await result).toEqual({ a: 'Name a' });
    });

    it('reads at most MAX_NAME_PAGES pages', async () => {
      const result = api.serviceNames('g1', ['missing']);
      for (let read = 0; read < MAX_NAME_PAGES; read++) {
        expectPage(read === 0 ? null : `c${read}`).flush(page(['other'], `c${read + 1}`));
        await settle();
      }
      backend().expectNone((r) => r.url === SERVICES);
      expect(await result).toEqual({});
    });
  });

  describe('compact lookups', () => {
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

    it('reads a page of each kind of lookup', async () => {
      for (const kind of [
        'products',
        'product-categories',
        'customers',
        'contact-groups',
      ] as const) {
        const result = api.lookup('g/1', kind, { q: 'x' });
        const request = backend().expectOne(
          (r) => r.url === `${API}/v1/groups/g%2F1/lookup/${kind}`,
        );
        expect(request.request.params.get('q')).toBe('x');
        expect(request.request.params.has('ids')).toBe(false);
        request.flush(PAGE);
        expect(await result).toEqual(PAGE);
      }
    });

    it('sends the ids to resolve, comma separated', async () => {
      const result = api.lookup('g1', 'products', { ids: ['a', 'b'] });
      const request = backend().expectOne((r) => r.url === `${API}/v1/groups/g1/lookup/products`);
      expect(request.request.params.get('ids')).toBe('a,b');
      request.flush(PAGE);
      await result;
    });

    it('does not send an empty list of ids', async () => {
      const result = api.lookup('g1', 'products', { ids: [] });
      const request = backend().expectOne((r) => r.url === `${API}/v1/groups/g1/lookup/products`);
      expect(request.request.params.has('ids')).toBe(false);
      request.flush(PAGE);
      await result;
    });

    it('resolves names with the ids filter, in requests of at most 100 ids', async () => {
      const ids = Array.from({ length: MAX_LOOKUP_IDS + 1 }, (_, n) => `id${n}`);
      const result = api.lookupNames('g1', 'customers', ids);
      const first = backend().expectOne((r) => r.url === `${API}/v1/groups/g1/lookup/customers`);
      expect(first.request.params.get('ids')?.split(',')).toHaveLength(MAX_LOOKUP_IDS);
      expect(first.request.params.get('limit')).toBe(String(MAX_LOOKUP_IDS));
      first.flush({ data: [{ id: 'id0', name: 'Zero' }], page: { limit: 100, next: null } });
      await settle();
      const second = backend().expectOne((r) => r.url === `${API}/v1/groups/g1/lookup/customers`);
      expect(second.request.params.get('ids')).toBe(`id${MAX_LOOKUP_IDS}`);
      second.flush({ data: [{ id: 'id100', name: '' }], page: { limit: 100, next: null } });
      expect(await result).toEqual({ id0: 'Zero', id100: '' });
    });

    it('asks each id once', async () => {
      const result = api.lookupNames('g1', 'products', ['a', 'a', 'b', 'a']);
      const request = backend().expectOne((r) => r.url === `${API}/v1/groups/g1/lookup/products`);
      expect(request.request.params.get('ids')).toBe('a,b');
      request.flush({ data: [], page: { limit: 100, next: null } });
      await result;
    });

    it('does not read anything when no names are asked', async () => {
      expect(await api.lookupNames('g1', 'products', [])).toEqual({});
    });
  });

  describe('placeNames and placeIds', () => {
    const PLACES = `${API}/v1/groups/g1/places`;
    const page = (ids: string[], next: string | null) => ({
      data: ids.map((id) => ({ id, name: `Place ${id}` })),
      page: { limit: 100, next },
    });
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

    it('resolves the names of stores with the ids filter, without duplicates', async () => {
      const result = api.placeNames('g1', ['p1', 'p1', 'p2']);
      const request = backend().expectOne((r) => r.url === PLACES);
      expect(request.request.params.get('ids')).toBe('p1,p2');
      request.flush(page(['p1', 'p2'], null));
      expect(await result).toEqual({ p1: 'Place p1', p2: 'Place p2' });
    });

    it('lists every store of the perimeter', async () => {
      const result = api.placeIds('g1');
      backend()
        .expectOne((r) => r.url === PLACES)
        .flush(page(['a', 'b'], 'c1'));
      await settle();
      const second = backend().expectOne((r) => r.url === PLACES);
      expect(second.request.params.get('cursor')).toBe('c1');
      second.flush(page(['c'], null));
      expect(await result).toEqual(new Set(['a', 'b', 'c']));
    });

    it('gives up (null) when the stores are more than the pages it reads', async () => {
      const result = api.placeIds('g1');
      for (let read = 0; read < MAX_PERIMETER_PAGES; read++) {
        backend()
          .expectOne((r) => r.url === PLACES)
          .flush(page([`p${read}`], `c${read}`));
        await settle();
      }
      backend().expectNone((r) => r.url === PLACES);
      expect(await result).toBeNull();
    });
  });
});
