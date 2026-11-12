import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { SessionService } from '../session/session.service';
import { GroupContext } from './group-context';
import { GroupFeatures } from './group-features';

const A = '665f1c2e9b1d4a0012ab34a2';
const B = '665f1c2e9b1d4a0012ab34a3';
const URL_A = `${API}/v1/groups/${A}`;

const body = (features: unknown) => ({ data: { features } });

function setup() {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  sessionStorage.clear();
}

function psa() {
  signIn({ role: 'PSA', groupId: null, group: null });
  return TestBed.inject(GroupFeatures);
}

async function flush(url: string, features: unknown, headers: Record<string, string> = {}) {
  backend().expectOne(url).flush(body(features), { headers });
  await settle();
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('GroupFeatures', () => {
  it('uses the features of the profile for users bound to a group', () => {
    setup();
    signIn({ role: 'SA', groupFeatures: fakeFeatureFlags(false, { cash: true }) });
    const features = TestBed.inject(GroupFeatures);
    expect(features.status()).toBe('ready');
    expect(features.enabled('cash')).toBe(true);
    expect(features.enabled('rooms')).toBe(false);
    expect(features.enabled('nope')).toBe(false);
  });

  it('knows nothing when the profile has no features or nobody is signed in', () => {
    setup();
    const features = TestBed.inject(GroupFeatures);
    expect(features.status()).toBe('idle');
    expect(features.enabled('cash')).toBe(false);
    signIn({ role: 'CA', groupFeatures: null });
    expect(features.flags()).toBeNull();
  });

  it('reads the group of a PSA at every change of working group', async () => {
    setup();
    const features = psa();
    TestBed.tick();
    expect(features.status()).toBe('idle');
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    expect(features.status()).toBe('loading');
    await flush(URL_A, { cash: true, junk: true }, { ETag: 'W/"1"' });
    expect(features.status()).toBe('ready');
    expect(features.enabled('cash')).toBe(true);
    expect(Object.keys(features.flags()!)).toHaveLength(15);

    TestBed.inject(GroupContext).choose({ id: B, name: 'B' });
    TestBed.tick();
    expect(features.status()).toBe('loading');
    await flush(`${API}/v1/groups/${B}`, { rooms: true });
    expect(features.enabled('rooms')).toBe(true);
    expect(features.enabled('cash')).toBe(false);

    TestBed.inject(GroupContext).clear();
    TestBed.tick();
    expect(features.status()).toBe('idle');
  });

  it('reuses the representation in memory on 304 with If-None-Match', async () => {
    setup();
    const features = psa();
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    await flush(URL_A, { cash: true }, { ETag: 'W/"1"' });
    const refreshed = features.refresh();
    const req = backend().expectOne(URL_A);
    expect(req.request.headers.get('If-None-Match')).toBe('W/"1"');
    req.flush(null, { status: 304, statusText: 'Not Modified' });
    await refreshed;
    expect(features.enabled('cash')).toBe(true);
  });

  it('takes the new features when the group changed', async () => {
    setup();
    const features = psa();
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    await flush(URL_A, { cash: true }, { ETag: 'W/"1"' });
    const refreshed = features.refresh();
    backend()
      .expectOne(URL_A)
      .flush(body({ cash: false }));
    await refreshed;
    expect(features.enabled('cash')).toBe(false);
  });

  it('keeps the error when the read fails and reads again on refresh', async () => {
    setup();
    const features = psa();
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    backend().expectOne(URL_A).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await settle();
    expect(features.status()).toBe('error');
    expect(features.error()?.code).toBe('NOT_FOUND');
    const refreshed = features.refresh();
    backend()
      .expectOne(URL_A)
      .flush(body({ cash: true }));
    await refreshed;
    expect(features.status()).toBe('ready');
    expect(features.error()).toBeNull();
  });

  it('reports an unexpected failure as an unknown error', async () => {
    setup();
    const features = psa();
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    backend().expectOne(URL_A).error(new ProgressEvent('error'));
    await settle();
    expect(features.error()?.code).toBe('NETWORK_ERROR');
  });

  it('reports a response of an unexpected shape as an unknown error', async () => {
    setup();
    const features = psa();
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    backend().expectOne(URL_A).flush({});
    await settle();
    expect(features.status()).toBe('error');
    expect(features.error()?.code).toBe('UNKNOWN_ERROR');
  });

  it('tolerates a response without a body', async () => {
    setup();
    const features = psa();
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    backend().expectOne(URL_A).flush(null);
    await settle();
    expect(features.status()).toBe('ready');
    expect(features.enabled('cash')).toBe(false);
  });

  it('does not drop the features a deep link asked for while no group is chosen', async () => {
    setup();
    const features = psa();
    const pending = features.ensure(A);
    TestBed.tick();
    await flush(URL_A, { cash: true });
    await pending;
    TestBed.tick();
    expect(features.enabled('cash')).toBe(true);
  });

  it('drops the answer of a read made obsolete by another group', async () => {
    setup();
    const features = psa();
    void features.ensure(A);
    const second = features.ensure(B);
    backend()
      .expectOne(URL_A)
      .flush(body({ cash: true }));
    await settle();
    backend()
      .expectOne(`${API}/v1/groups/${B}`)
      .flush(body({ rooms: true }));
    await second;
    expect(features.enabled('cash')).toBe(false);
    expect(features.enabled('rooms')).toBe(true);
  });

  it('forgets everything at sign-out, also the answer of a read still in flight', async () => {
    TestBed.configureTestingModule({
      providers: [...provideApiTesting(), provideRouter([{ path: 'login', children: [] }])],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const features = psa();
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    TestBed.tick();
    await flush(URL_A, { cash: true }, { ETag: 'W/"1"' });
    const pending = features.refresh();
    TestBed.inject(SessionService).expire();
    TestBed.tick();
    expect(features.flags()).toBeNull();
    backend()
      .expectOne(URL_A)
      .flush(body({ rooms: true }), { headers: { ETag: 'W/"2"' } });
    await pending;
    expect(features.flags()).toBeNull();

    signIn({ role: 'D', groupId: null, group: null });
    const next = features.ensure(A);
    const req = backend().expectOne(URL_A);
    expect(req.request.headers.has('If-None-Match')).toBe(false);
    req.flush(body({ cash: false }));
    await next;
    expect(features.enabled('cash')).toBe(false);
    expect(features.enabled('rooms')).toBe(false);
  });

  it('ensure shares the request in flight and skips the group already loaded', async () => {
    setup();
    const features = psa();
    const first = features.ensure(A);
    const second = features.ensure(A);
    expect(second).toBe(first);
    await flush(URL_A, { cash: true });
    await first;
    await features.ensure(A);
  });

  it('ensure does nothing for users bound to a group', async () => {
    setup();
    signIn({ role: 'SA', groupFeatures: fakeFeatureFlags(true) });
    await TestBed.inject(GroupFeatures).ensure(A);
  });

  it('isEnabledFor waits for the group of the URL, or uses the working group', async () => {
    setup();
    const features = psa();
    const pending = features.isEnabledFor(A, 'cash');
    await flush(URL_A, { cash: true });
    expect(await pending).toBe(true);
    expect(await features.isEnabledFor(null, 'cash')).toBe(false);
    TestBed.inject(GroupContext).choose({ id: A, name: 'A' });
    expect(await features.isEnabledFor(null, 'cash')).toBe(true);
  });

  it('isEnabledFor answers for users bound to a group without waiting', async () => {
    setup();
    signIn({ role: 'CA', groupFeatures: fakeFeatureFlags(false, { media: true }) });
    const features = TestBed.inject(GroupFeatures);
    expect(await features.isEnabledFor(null, 'media')).toBe(true);
    expect(await features.isEnabledFor(A, 'cash')).toBe(false);
  });

  it('refresh reads the profile again for users bound to a group', async () => {
    setup();
    signIn({ role: 'SA', groupFeatures: fakeFeatureFlags(false) });
    const features = TestBed.inject(GroupFeatures);
    const refreshed = features.refresh();
    backend()
      .expectOne(`${API}/v1/me`)
      .flush({ data: meBody({ cash: true }) });
    await refreshed;
    expect(features.enabled('cash')).toBe(true);
  });

  it('refresh keeps the error when the profile cannot be read', async () => {
    setup();
    signIn({ role: 'SA', groupFeatures: fakeFeatureFlags(false) });
    const features = TestBed.inject(GroupFeatures);
    const refreshed = features.refresh();
    backend().expectOne(`${API}/v1/me`).error(new ProgressEvent('error'));
    await refreshed;
    expect(features.error()?.code).toBe('NETWORK_ERROR');
  });

  it('refresh without a working group does nothing', async () => {
    setup();
    const features = psa();
    await features.refresh();
  });
});

function meBody(features: Partial<Record<string, boolean>>) {
  return {
    ...profileLike(),
    groupFeatures: { ...fakeFeatureFlags(false), ...features },
  };
}

function profileLike() {
  return {
    id: 'u',
    username: 'u',
    role: 'SA',
    permissions: [],
    passwordChangeRequired: false,
    group: null,
  };
}
