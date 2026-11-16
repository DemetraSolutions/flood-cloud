import { HttpRequest } from '@angular/common/http';
import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { throwError } from 'rxjs';
import { TestRequest } from '@angular/common/http/testing';
import { API, backend, errorBody, provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { ApiError } from '../api/api-error';
import { GroupContext } from '../groups/group-context';
import { SessionService } from '../session/session.service';
import {
  MAX_REMEMBERED_GROUPS,
  REFERENCE_ENDPOINTS,
  ReferenceKind,
  ReferenceStore,
} from './reference-store';

const G1 = '665f1c2e9b1d4a0012ab34a1';
const G2 = '665f1c2e9b1d4a0012ab34a2';

function page(...names: string[]) {
  return {
    data: names.map((name) => ({ id: name.toLowerCase(), name })),
    page: { limit: 25, next: null },
  };
}

const urlOf = (groupId: string, path: string) => `${API}/v1/groups/${groupId}/${path}`;

/** Expects one read of a list and answers it. */
function expectRead(url: string, path = '') {
  return backend().expectOne(
    (r: HttpRequest<unknown>) => r.url === url && r.urlWithParams.endsWith(path),
  );
}

function answer(request: TestRequest, body: object, etag: string | null) {
  request.flush(body, { headers: etag === null ? {} : { ETag: etag } });
}

function notModified(request: TestRequest) {
  request.flush(null, { status: 304, statusText: 'Not Modified' });
}

describe('ReferenceStore', () => {
  let store: ReferenceStore;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    store = TestBed.inject(ReferenceStore);
  });
  afterEach(() => backend().verify());

  it('serves the lists from the endpoints of its table', () => {
    expect(Object.keys(REFERENCE_ENDPOINTS)).toEqual([
      'companies',
      'places',
      'products',
      'product-categories',
      'customers',
      'contact-groups',
      'price-lists',
      'email-templates',
    ]);
  });

  it('reads a list once and serves it from memory, without a limit unless asked', async () => {
    const first = store.page(G1, 'price-lists');
    const request = expectRead(urlOf(G1, 'lookup/price-lists'));
    expect(request.request.params.keys()).toEqual([]);
    expect(request.request.headers.has('If-None-Match')).toBe(false);
    answer(request, page('Retail'), 'W/"a"');
    expect(await first).toEqual(page('Retail'));
    expect(await store.page(G1, 'price-lists')).toEqual(page('Retail'));
  });

  it('keeps a page for each group, list and parameters, and encodes the group id', async () => {
    const reads = [
      store.page(G1, 'places', { limit: 25 }),
      store.page(G1, 'places', { limit: 25, q: 'rom' }),
      store.page(G1, 'places', { limit: 25, cursor: 'c1', companyId: 'c', ids: ['a', 'b'] }),
      store.page(G1, 'companies', { limit: 25 }),
      store.page('g/1', 'products', { limit: 25 }),
    ];
    const requests = backend().match(() => true);
    expect(requests.map((r) => r.request.urlWithParams)).toEqual([
      `${API}/v1/groups/${G1}/places?limit=25`,
      `${API}/v1/groups/${G1}/places?limit=25&q=rom`,
      `${API}/v1/groups/${G1}/places?limit=25&cursor=c1&companyId=c&ids=a,b`,
      `${API}/v1/groups/${G1}/companies?limit=25`,
      `${API}/v1/groups/g%2F1/lookup/products?limit=25`,
    ]);
    requests.forEach((request) => answer(request, page('X'), null));
    await Promise.all(reads);
  });

  it('shares one request between equal concurrent reads', async () => {
    const reads = [store.page(G1, 'companies'), store.page(G1, 'companies')];
    answer(expectRead(urlOf(G1, 'companies')), page('A'), 'W/"1"');
    expect(await Promise.all(reads)).toEqual([page('A'), page('A')]);
  });

  describe('revalidation', () => {
    async function loaded(etag: string | null = 'W/"v1"'): Promise<void> {
      const first = store.page(G1, 'price-lists');
      answer(expectRead(urlOf(G1, 'lookup/price-lists')), page('Old'), etag);
      await first;
    }

    it('keeps the data in memory on 304', async () => {
      await loaded();
      store.invalidate(G1, 'price-lists');
      const again = store.page(G1, 'price-lists');
      const request = expectRead(urlOf(G1, 'lookup/price-lists'));
      expect(request.request.headers.get('If-None-Match')).toBe('W/"v1"');
      notModified(request);
      expect(await again).toEqual(page('Old'));
      // Current again: no more requests.
      expect(await store.page(G1, 'price-lists')).toEqual(page('Old'));
    });

    it('replaces the data on 200 and keeps the new tag', async () => {
      await loaded();
      store.invalidate(G1, 'price-lists');
      const again = store.page(G1, 'price-lists');
      answer(expectRead(urlOf(G1, 'lookup/price-lists')), page('New'), 'W/"v2"');
      expect(await again).toEqual(page('New'));
      store.invalidate(G1, 'price-lists');
      const third = store.page(G1, 'price-lists');
      const request = expectRead(urlOf(G1, 'lookup/price-lists'));
      expect(request.request.headers.get('If-None-Match')).toBe('W/"v2"');
      notModified(request);
      await third;
    });

    it('does not send If-None-Match when the server gave no tag', async () => {
      await loaded(null);
      store.invalidate(G1, 'price-lists');
      const again = store.page(G1, 'price-lists');
      const request = expectRead(urlOf(G1, 'lookup/price-lists'));
      expect(request.request.headers.has('If-None-Match')).toBe(false);
      answer(request, page('New'), null);
      expect(await again).toEqual(page('New'));
    });

    it('rejects a 304 that answers a read with no tag', async () => {
      const first = store.page(G1, 'companies');
      const failure = first.catch((error: unknown) => error);
      notModified(expectRead(urlOf(G1, 'companies')));
      expect(await failure).toBeInstanceOf(ApiError);
    });
  });

  describe('invalidation', () => {
    it('makes only the pages of that list in that group stale', async () => {
      const reads = [
        store.page(G1, 'price-lists'),
        store.page(G1, 'places'),
        store.page(G1, 'companies'),
      ];
      backend()
        .match(() => true)
        .forEach((request) => answer(request, page('A'), 'W/"1"'));
      await Promise.all(reads);
      store.invalidate(G1, 'places');
      store.invalidate(G2, 'places');
      await store.page(G1, 'price-lists');
      await store.page(G1, 'companies');
      const places = store.page(G1, 'places');
      notModified(expectRead(urlOf(G1, 'places')));
      await places;
    });

    it('leaves alone the reads in flight of other lists and groups', async () => {
      const reads = [store.page(G1, 'places'), store.page(G2, 'price-lists')];
      store.invalidate(G2, 'places');
      store.invalidate(G2, 'companies');
      // Equal reads join the ones in flight: no new request is made.
      reads.push(store.page(G1, 'places'), store.page(G2, 'price-lists'));
      const requests = backend().match(() => true);
      expect(requests).toHaveLength(2);
      requests.forEach((request) => answer(request, page('A'), null));
      await Promise.all(reads);
    });

    it('does not take as current a read that started before the write', async () => {
      const early = store.page(G1, 'price-lists');
      const request = expectRead(urlOf(G1, 'lookup/price-lists'));
      store.invalidate(G1, 'price-lists');
      answer(request, page('Before'), 'W/"1"');
      // The caller of the old read still gets its page ...
      expect(await early).toEqual(page('Before'));
      // ... and the next read starts again (an equal read in flight is not joined).
      const next = store.page(G1, 'price-lists');
      const second = expectRead(urlOf(G1, 'lookup/price-lists'));
      expect(second.request.headers.get('If-None-Match')).toBe('W/"1"');
      answer(second, page('After'), 'W/"2"');
      expect(await next).toEqual(page('After'));
    });

    it('does not take as current a 304 that answers a read started before the write', async () => {
      const first = store.page(G1, 'places');
      answer(expectRead(urlOf(G1, 'places')), page('A'), 'W/"1"');
      await first;
      store.invalidate(G1, 'places');
      const early = store.page(G1, 'places');
      const request = expectRead(urlOf(G1, 'places'));
      store.invalidate(G1, 'places');
      notModified(request);
      await early;
      const next = store.page(G1, 'places');
      notModified(expectRead(urlOf(G1, 'places')));
      await next;
    });
  });

  describe('groups', () => {
    it('never serves the data of a group to another one', async () => {
      const first = store.page(G1, 'companies');
      answer(expectRead(urlOf(G1, 'companies')), page('Of one'), 'W/"1"');
      await first;
      const second = store.page(G2, 'companies');
      const request = expectRead(urlOf(G2, 'companies'));
      expect(request.request.headers.has('If-None-Match')).toBe(false);
      answer(request, page('Of two'), 'W/"2"');
      expect(await second).toEqual(page('Of two'));
    });

    it('revalidates the lists of a group when the user comes back to it', async () => {
      const first = store.page(G1, 'companies');
      answer(expectRead(urlOf(G1, 'companies')), page('A'), 'W/"1"');
      await first;
      const other = store.page(G2, 'companies');
      answer(expectRead(urlOf(G2, 'companies')), page('B'), 'W/"2"');
      await other;
      const back = store.page(G1, 'companies');
      const request = expectRead(urlOf(G1, 'companies'));
      expect(request.request.headers.get('If-None-Match')).toBe('W/"1"');
      notModified(request);
      expect(await back).toEqual(page('A'));
    });

    it('revalidates when the working group changes, without any read', async () => {
      signIn({ role: 'PSA', groupId: null, group: null });
      TestBed.tick();
      const context = TestBed.inject(GroupContext);
      context.choose({ id: G1, name: 'Alfa' });
      TestBed.tick();
      const first = store.page(G1, 'companies');
      answer(expectRead(urlOf(G1, 'companies')), page('A'), 'W/"1"');
      await first;
      context.choose({ id: G2, name: 'Beta' });
      TestBed.tick();
      context.choose({ id: G1, name: 'Alfa' });
      TestBed.tick();
      const back = store.page(G1, 'companies');
      notModified(expectRead(urlOf(G1, 'companies')));
      await back;
    });

    it('ignores the effect while no group is chosen', async () => {
      signIn({ role: 'PSA', groupId: null, group: null });
      TestBed.tick();
      const first = store.page(G1, 'companies');
      answer(expectRead(urlOf(G1, 'companies')), page('A'), 'W/"1"');
      await first;
      expect(await store.page(G1, 'companies')).toEqual(page('A'));
    });

    it('remembers only the last groups', async () => {
      const ids = Array.from({ length: MAX_REMEMBERED_GROUPS + 1 }, (_, i) => `g${i}`);
      for (const id of ids) {
        const read = store.page(id, 'companies');
        answer(expectRead(urlOf(id, 'companies')), page('A'), 'W/"1"');
        await read;
      }
      // The first one was forgotten: no tag to send.
      const forgotten = store.page(ids[0], 'companies');
      const request = expectRead(urlOf(ids[0], 'companies'));
      expect(request.request.headers.has('If-None-Match')).toBe(false);
      answer(request, page('A'), 'W/"1"');
      await forgotten;
    });

    it('does not keep a page that arrives for a group already forgotten', async () => {
      const slow = store.page('slow', 'companies');
      const request = expectRead(urlOf('slow', 'companies'));
      for (let i = 0; i < MAX_REMEMBERED_GROUPS; i++) {
        const read = store.page(`g${i}`, 'companies');
        answer(expectRead(urlOf(`g${i}`, 'companies')), page('A'), null);
        await read;
      }
      answer(request, page('Late'), 'W/"1"');
      expect(await slow).toEqual(page('Late'));
      const again = store.page('slow', 'companies');
      expect(expectRead(urlOf('slow', 'companies')).request.headers.has('If-None-Match')).toBe(
        false,
      );
      backend().match(() => true);
      void again.catch(() => undefined);
    });
  });

  describe('sign-out', () => {
    it('empties the store', async () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [...provideApiTesting(), provideRouter([{ path: 'login', children: [] }])],
      });
      store = TestBed.inject(ReferenceStore);
      const session = TestBed.inject(SessionService);
      signIn();
      TestBed.tick();
      const first = store.page(G1, 'companies');
      answer(expectRead(urlOf(G1, 'companies')), page('A'), 'W/"1"');
      await first;

      const out = session.logout();
      backend()
        .expectOne(`${API}/v1/auth/logout`)
        .flush(null, { status: 204, statusText: 'No Content' });
      await out;
      TestBed.tick();

      const again = store.page(G1, 'companies');
      const request = expectRead(urlOf(G1, 'companies'));
      expect(request.request.headers.has('If-None-Match')).toBe(false);
      answer(request, page('Other user'), 'W/"9"');
      expect(await again).toEqual(page('Other user'));
    });

    it('does not keep a page that arrives after the sign-out', async () => {
      const slow = store.page(G1, 'companies');
      const request = expectRead(urlOf(G1, 'companies'));
      store.clear();
      answer(request, page('Late'), 'W/"1"');
      expect(await slow).toEqual(page('Late'));
      const again = store.page(G1, 'companies');
      expect(expectRead(urlOf(G1, 'companies')).request.headers.has('If-None-Match')).toBe(false);
      void again.catch(() => undefined);
    });
  });

  describe('errors', () => {
    async function loaded(): Promise<void> {
      const first = store.page(G1, 'companies');
      answer(expectRead(urlOf(G1, 'companies')), page('Valid'), 'W/"1"');
      await first;
      store.invalidate(G1, 'companies');
    }

    function fail(request: TestRequest, status: number, code: string) {
      request.flush(errorBody(code), { status, statusText: code });
    }

    it.each([
      [500, 'INTERNAL_ERROR'],
      [0, 'NETWORK_ERROR'],
    ])('keeps the valid data when the read fails with %s', async (status, code) => {
      await loaded();
      const failed = store.page(G1, 'companies');
      const caught = failed.catch((error: unknown) => error);
      const request = expectRead(urlOf(G1, 'companies'));
      if (status === 0) {
        request.error(new ProgressEvent('error'));
      } else {
        fail(request, status, code);
      }
      expect(((await caught) as ApiError).code).toBe(code);

      // The data is still there: the next read revalidates it with its tag.
      const retry = store.page(G1, 'companies');
      const next = expectRead(urlOf(G1, 'companies'));
      expect(next.request.headers.get('If-None-Match')).toBe('W/"1"');
      notModified(next);
      expect(await retry).toEqual(page('Valid'));
    });

    it('lets an error that is not an HTTP failure through', async () => {
      await loaded();
      const error = new TypeError('boom');
      vi.spyOn(TestBed.inject(HttpClient), 'get').mockReturnValue(throwError(() => error));
      await expect(store.page(G1, 'companies')).rejects.toBe(error);
    });

    it.each([
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
    ])('drops the data of the group when the answer is %s', async (status, code) => {
      await loaded();
      const other = store.page(G2, 'companies');
      answer(expectRead(urlOf(G2, 'companies')), page('Other'), 'W/"2"');
      await other;
      // G1 is entered again to keep reading it as current.
      const failed = store.page(G1, 'companies');
      const caught = failed.catch((error: unknown) => error);
      fail(expectRead(urlOf(G1, 'companies')), status, code);
      expect(((await caught) as ApiError).status).toBe(status);

      const again = store.page(G1, 'companies');
      const request = expectRead(urlOf(G1, 'companies'));
      expect(request.request.headers.has('If-None-Match')).toBe(false);
      answer(request, page('Fresh'), 'W/"3"');
      expect(await again).toEqual(page('Fresh'));
    });

    it('drops the data of a group that is not the current one when it answers 404', async () => {
      await loaded();
      const failed = store.page(G1, 'places');
      const caught = failed.catch((error: unknown) => error);
      const request = expectRead(urlOf(G1, 'places'));
      const other = store.page(G2, 'companies');
      answer(expectRead(urlOf(G2, 'companies')), page('Other'), 'W/"2"');
      await other;
      fail(request, 404, 'NOT_FOUND');
      await caught;
      const again = store.page(G1, 'companies');
      expect(expectRead(urlOf(G1, 'companies')).request.headers.has('If-None-Match')).toBe(false);
      void again.catch(() => undefined);
    });
  });

  it('is typed by the kinds of its table', () => {
    const kind: ReferenceKind = 'products';
    expect(REFERENCE_ENDPOINTS[kind]).toBe('lookup/products');
  });
});
