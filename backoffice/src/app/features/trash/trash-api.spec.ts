import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { GROUP, result } from '../../../testing/trash';
import { ReferenceStore } from '../../core/reference/reference-store';
import { TrashApi } from './trash-api';

const BASE = `${API}/v1/groups/${GROUP}/trash`;

function setup() {
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  const invalidate = vi
    .spyOn(TestBed.inject(ReferenceStore), 'invalidate')
    .mockImplementation(() => undefined);
  return { api: TestBed.inject(TrashApi), invalidate };
}

afterEach(() => backend().verify());

describe('TrashApi', () => {
  it('restores companies and tells the store', async () => {
    const { api, invalidate } = setup();
    const done = api.restore(GROUP, 'companies', ['a', 'b']);
    const req = backend().expectOne(`${BASE}/companies/restore`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ ids: ['a', 'b'] });
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: { results: [result('a', 'restored'), result('b', 'skipped', 'taken')] } });
    expect((await done).results).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'companies');
  });

  it('deletes places for good and tells the store', async () => {
    const { api, invalidate } = setup();
    const done = api.remove(GROUP, 'places', ['a']);
    const req = backend().expectOne(`${BASE}/places/delete`);
    expect(req.request.body).toEqual({ ids: ['a'] });
    req.flush({ data: { results: [result('a', 'deleted')] } });
    await done;
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
  });

  it('restores, deletes and empties contacts and tells the store about customers and suppliers', async () => {
    const { api, invalidate } = setup();
    const restored = api.restore(GROUP, 'contacts', ['a']);
    backend()
      .expectOne(`${BASE}/contacts/restore`)
      .flush({ data: { results: [result('a', 'restored')] } });
    await restored;
    expect(invalidate.mock.calls).toEqual([
      [GROUP, 'customers'],
      [GROUP, 'suppliers'],
    ]);
    invalidate.mockClear();
    const removed = api.remove(GROUP, 'contacts', ['a']);
    backend()
      .expectOne(`${BASE}/contacts/delete`)
      .flush({ data: { results: [result('a', 'deleted')] } });
    await removed;
    const emptied = api.empty(GROUP, 'contacts');
    backend()
      .expectOne(`${BASE}/contacts/empty`)
      .flush({ data: { results: [], remaining: 0, next: null } });
    await emptied;
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).not.toHaveBeenCalledWith(GROUP, 'companies');
  });

  it('does not touch the store for the users', async () => {
    const { api, invalidate } = setup();
    const done = api.restore(GROUP, 'users', ['a']);
    backend()
      .expectOne(`${BASE}/users/restore`)
      .flush({ data: { results: [result('a', 'restored')] } });
    await done;
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('empties a kind with no body and reports what remains', async () => {
    const { api } = setup();
    const done = api.empty(GROUP, 'users');
    const req = backend().expectOne(`${BASE}/users/empty`);
    expect(req.request.body).toBeNull();
    req.flush({ data: { results: [result('a', 'deleted')], remaining: 3, next: 'a' } });
    expect(await done).toEqual({ results: [result('a', 'deleted')], remaining: 3, next: 'a' });
  });

  it('continues an emptying after the id the server gave', async () => {
    const { api } = setup();
    const done = api.empty(GROUP, 'users', 'a');
    const req = backend().expectOne(`${BASE}/users/empty`);
    expect(req.request.body).toEqual({ after: 'a' });
    req.flush({ data: { results: [], remaining: 0, next: null } });
    expect((await done).next).toBeNull();
  });

  it('restores groups from the platform trash', async () => {
    const { api, invalidate } = setup();
    const done = api.restoreGroups(['g1']);
    const req = backend().expectOne(`${API}/v1/trash/groups/restore`);
    expect(req.request.body).toEqual({ ids: ['g1'] });
    req.flush({ data: { results: [result('g1', 'restored')] } });
    await done;
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('escapes the group in the URL', async () => {
    const { api } = setup();
    const done = api.empty('a b', 'companies');
    backend()
      .expectOne(`${API}/v1/groups/a%20b/trash/companies/empty`)
      .flush({ data: { results: [], remaining: 0, next: null } });
    await done;
  });
});
