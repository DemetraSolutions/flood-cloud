import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { fakeGroup } from '../../../testing/groups';
import { GroupsApi } from './groups-api';

const ID = '665f1c2e9b1d4a0012ab34a1';

afterEach(() => backend().verify());

describe('GroupsApi', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: provideApiTesting() }));

  it('patches a group and resolves with the updated one', async () => {
    const group = fakeGroup({ name: 'Nuovo' });
    const result = TestBed.inject(GroupsApi).update(ID, { name: 'Nuovo' });
    await settle();
    const request = backend().expectOne(`${API}/v1/groups/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ name: 'Nuovo' });
    request.flush({ data: group });
    expect(await result).toEqual(group);
  });

  it.each([
    ['suspend', 'POST', '/suspension'],
    ['reactivate', 'DELETE', '/suspension'],
    ['trash', 'POST', '/trash'],
    ['restore', 'POST', '/restore'],
  ] as const)('%s calls %s %s', async (action, method, path) => {
    const done = TestBed.inject(GroupsApi).changeState(ID, action);
    await settle();
    const request = backend().expectOne(`${API}/v1/groups/${ID}${path}`);
    expect(request.request.method).toBe(method);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await done;
  });

  it('encodes the group id in the URL', async () => {
    const done = TestBed.inject(GroupsApi).changeState('a/b', 'trash');
    await settle();
    backend().expectOne(`${API}/v1/groups/a%2Fb/trash`).flush(null);
    await done;
  });
});
