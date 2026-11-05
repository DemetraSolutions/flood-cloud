import { TestBed } from '@angular/core/testing';
import { API, backend, failRequest, provideApiTesting } from '../../../testing/api';
import { fakeProfile } from '../../../testing/session';
import { ProfileApi } from './profile-api';

beforeEach(() => TestBed.configureTestingModule({ providers: provideApiTesting() }));
afterEach(() => backend().verify());

describe('ProfileApi', () => {
  it('patches only the given fields and returns the stored profile', async () => {
    const done = TestBed.inject(ProfileApi).update({ phone: null, firstName: 'Luigi' });
    const request = backend().expectOne(`${API}/v1/me`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ phone: null, firstName: 'Luigi' });
    request.flush({ data: fakeProfile({ firstName: 'Luigi', phone: null }) });
    expect((await done).firstName).toBe('Luigi');
  });

  it('changes the password', async () => {
    const done = TestBed.inject(ProfileApi).changePassword('old-pass', 'new-pass-1234');
    const request = backend().expectOne(`${API}/v1/me/password`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({
      currentPassword: 'old-pass',
      newPassword: 'new-pass-1234',
    });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(done).resolves.toBeUndefined();
  });

  it('surfaces the field errors of a rejected password', async () => {
    const done = TestBed.inject(ProfileApi).changePassword('x', 'y');
    failRequest(backend(), '/v1/me/password', 'VALIDATION_ERROR', {
      details: [{ field: 'currentPassword', issue: 'incorrect' }],
    });
    await expect(done).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'currentPassword', issue: 'incorrect' }],
    });
  });

  it('revokes a session by id, encoding it in the path', async () => {
    const done = TestBed.inject(ProfileApi).revokeSession('665f/1c2e');
    const request = backend().expectOne(`${API}/v1/me/sessions/665f%2F1c2e`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(done).resolves.toBeUndefined();
  });
});
