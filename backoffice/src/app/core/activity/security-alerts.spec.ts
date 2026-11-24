import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  API,
  backend,
  errorBody,
  provideApiTesting,
  settle,
  signInViaApi,
} from '../../../testing/api';
import { fakeProfile } from '../../../testing/session';
import { SessionService } from '../session/session.service';
import {
  ALERTS_FIRST_VISIT_DAYS,
  ALERTS_POLL_MS,
  ALERTS_SEEN_KEY_PREFIX,
  SecurityAlerts,
} from './security-alerts';

const URL = `${API}/v1/activity-log/alerts/count`;
const NOW = new Date('2026-11-23T10:00:00.000Z');
const DAY = 86_400_000;
const USER = fakeProfile({ permissions: ['activityLog:read'] }).id;
const KEY = `${ALERTS_SEEN_KEY_PREFIX}${USER}`;

function setup() {
  TestBed.configureTestingModule({
    providers: [...provideApiTesting(), provideRouter([{ path: 'login', children: [] }])],
  });
  return TestBed.inject(SecurityAlerts);
}

async function start(profile = fakeProfile({ permissions: ['activityLog:read'] })) {
  const alerts = setup();
  const session = await signInViaApi(profile);
  TestBed.tick();
  return { alerts, session };
}

/** The pending count read; asserts there is exactly one. */
const pending = () => backend().expectOne((r) => r.url === URL);
const since = (req: ReturnType<typeof pending>) => req.request.params.get('since');
async function answer(count: number, capped = false) {
  pending().flush({ data: { count, capped } });
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  backend().verify();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.replaceChildren();
});

describe('SecurityAlerts', () => {
  it('reads the count at sign-in, looking back 7 days the first time', async () => {
    const { alerts } = await start();
    const req = pending();
    expect(since(req)).toBe(new Date(NOW.getTime() - ALERTS_FIRST_VISIT_DAYS * DAY).toISOString());
    req.flush({ data: { count: 3, capped: false } });
    await settle();
    expect(alerts.count()).toBe(3);
    expect(alerts.badge()).toBe('3');
  });

  it('does nothing for a user who cannot read the log', async () => {
    const { alerts } = await start(fakeProfile({ permissions: ['profile:read'] }));
    vi.advanceTimersByTime(ALERTS_POLL_MS * 2);
    expect(alerts.badge()).toBeNull();
    backend().expectNone(URL);
  });

  it('shows 99+ when capped or above 99, and nothing at zero', async () => {
    const { alerts } = await start();
    await answer(100, true);
    expect(alerts.badge()).toBe('99+');
    expect(alerts.capped()).toBe(true);
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    await answer(120);
    expect(alerts.badge()).toBe('99+');
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    await answer(99);
    expect(alerts.badge()).toBe('99');
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    await answer(0);
    expect(alerts.badge()).toBeNull();
  });

  it('uses the last visit of this user and never asks for more than 29 days back', async () => {
    const seen = new Date(NOW.getTime() - 2 * DAY).toISOString();
    localStorage.setItem(KEY, seen);
    localStorage.setItem(`${ALERTS_SEEN_KEY_PREFIX}other`, 'x');
    await start();
    const req = pending();
    expect(since(req)).toBe(seen);
    req.flush({ data: { count: 0, capped: false } });
    await settle();
    // Thirty days later the stored date is too old for the server: it is moved forward.
    vi.setSystemTime(new Date(NOW.getTime() + 30 * DAY));
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    const next = pending();
    expect(since(next)).toBe(
      new Date(NOW.getTime() + 30 * DAY + ALERTS_POLL_MS - 29 * DAY).toISOString(),
    );
    next.flush({ data: { count: 0, capped: false } });
    await settle();
  });

  it.each(['not a date', new Date(NOW.getTime() + DAY).toISOString()])(
    'starts over from 7 days ago when the stored date is %s',
    async (stored) => {
      localStorage.setItem(KEY, stored);
      await start();
      const req = pending();
      expect(since(req)).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
      req.flush({ data: { count: 0, capped: false } });
      await settle();
    },
  );

  it('works when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { alerts } = await start();
    await answer(2);
    alerts.markSeen();
    expect(alerts.count()).toBe(0);
  });

  it('reads again every 5 minutes, only while the tab is visible', async () => {
    const { alerts } = await start();
    await answer(1);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    backend().expectNone(URL);
    visibility.mockReturnValue('visible');
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    await answer(2);
    expect(alerts.count()).toBe(2);
    vi.advanceTimersByTime(ALERTS_POLL_MS - 1);
    backend().expectNone(URL);
  });

  it('catches up when the tab becomes visible and a read is due, but never sooner', async () => {
    await start();
    await answer(1);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue('visible');
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    document.dispatchEvent(new Event('visibilitychange'));
    backend().expectNone(URL);
    vi.setSystemTime(new Date(NOW.getTime() + ALERTS_POLL_MS));
    document.dispatchEvent(new Event('visibilitychange'));
    await answer(5);
  });

  it('keeps the last count and warns when a read fails or answers nonsense', async () => {
    const { alerts } = await start();
    await answer(4);
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    pending().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await settle();
    expect(alerts.count()).toBe(4);
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    pending().flush({ data: { count: -1, capped: false } });
    await settle();
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    pending().flush({ data: { count: 2, capped: 'no' } });
    await settle();
    expect(alerts.count()).toBe(4);
    const warned = vi
      .mocked(console.warn)
      .mock.calls.filter(([text]) => text === 'Cannot read the security alerts');
    expect(warned).toHaveLength(3);
  });

  it('records the visit per user, clears the count and counts from then on', async () => {
    const { alerts } = await start();
    await answer(6);
    alerts.markSeen();
    expect(alerts.count()).toBe(0);
    expect(alerts.badge()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(NOW.toISOString());
    expect(alerts.since()).toBe(NOW.toISOString());
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    const req = pending();
    expect(since(req)).toBe(NOW.toISOString());
    req.flush({ data: { count: 1, capped: false } });
    await settle();
  });

  it('ignores the answer of a read that was in flight when the alerts were seen', async () => {
    const { alerts } = await start();
    const req = pending();
    alerts.markSeen();
    req.flush({ data: { count: 9, capped: false } });
    await settle();
    expect(alerts.count()).toBe(0);
  });

  it('does not record a visit when nobody is watched', () => {
    const alerts = setup();
    alerts.markSeen();
    expect(localStorage.length).toBe(0);
  });

  it('stops, clears the count and leaves no timer at sign-out', async () => {
    const { alerts, session } = await start();
    await answer(3);
    const out = session.logout();
    backend()
      .expectOne(`${API}/v1/auth/logout`)
      .flush(null, { status: 204, statusText: 'No Content' });
    await out;
    TestBed.tick();
    expect(alerts.count()).toBe(0);
    expect(alerts.badge()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(ALERTS_POLL_MS * 3);
    backend().expectNone(URL);
  });
});
