import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { UserArea } from './user.types';
import { UsersApi } from './users-api';
import { fakeUser } from '../../../testing/users';

const GROUP: UserArea = { kind: 'group', groupId: 'g1' };
const PLATFORM: UserArea = { kind: 'platform' };

describe('UsersApi', () => {
  let api: UsersApi;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    api = TestBed.inject(UsersApi);
  });
  afterEach(() => backend().verify());

  it('builds the URLs of both areas', () => {
    expect(api.baseUrl(GROUP)).toBe('/v1/groups/g1/users');
    expect(api.baseUrl(PLATFORM)).toBe('/v1/users');
    expect(api.userUrl(GROUP, 'u/1')).toBe('/v1/groups/g1/users/u%2F1');
  });

  it('creates a user', async () => {
    const body = { username: 'new.user', password: 'x'.repeat(12), role: 'PA' as const };
    const result = api.create(GROUP, body);
    const request = backend().expectOne(`${API}/v1/groups/g1/users`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(body);
    request.flush({ data: fakeUser() }, { status: 201, statusText: 'Created' });
    expect((await result).username).toBe('luca.bianchi');
  });

  it('updates a user with a patch', async () => {
    const result = api.update(PLATFORM, 'u1', { status: 'disabled' });
    const request = backend().expectOne(`${API}/v1/users/u1`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ status: 'disabled' });
    request.flush({ data: fakeUser() });
    await result;
  });

  it('sets a temporary password', async () => {
    const result = api.setPassword(GROUP, 'u1', 'secret-secret');
    const request = backend().expectOne(`${API}/v1/groups/g1/users/u1/password`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ password: 'secret-secret' });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await result;
  });

  it.each(['trash', 'restore'] as const)('%s returns the updated user', async (action) => {
    const result = api[action](GROUP, 'u1');
    const request = backend().expectOne(`${API}/v1/groups/g1/users/u1/${action}`);
    expect(request.request.method).toBe('POST');
    request.flush({ data: fakeUser({ trashed: action === 'trash' }) });
    expect((await result).trashed).toBe(action === 'trash');
  });

  it('deletes a user for good', async () => {
    const result = api.remove(GROUP, 'u1');
    const request = backend().expectOne(`${API}/v1/groups/g1/users/u1`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await result;
  });

  it('checks the availability of a username', async () => {
    const result = api.isUsernameAvailable('a+b@c');
    backend()
      .expectOne(`${API}/v1/usernames/a%2Bb%40c/availability`)
      .flush({ data: { available: false } });
    expect(await result).toBe(false);
  });
});
