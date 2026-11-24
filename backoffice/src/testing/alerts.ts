import { computed, signal } from '@angular/core';
import { SecurityAlerts } from '../app/core/activity/security-alerts';

/**
 * A stand-in for {@link SecurityAlerts} that never calls the backend: set `count` and `capped`
 * to drive the badge; `markSeen` is a spy that clears the count.
 */
export function fakeSecurityAlerts(initial = 0, since = '2026-11-20T10:30:00.000Z') {
  const count = signal(initial);
  const capped = signal(false);
  const markSeen = vi.fn(() => count.set(0));
  const fake = {
    count: count.asReadonly(),
    capped: capped.asReadonly(),
    since: signal(since).asReadonly(),
    badge: computed(() => (count() === 0 ? null : capped() ? '99+' : String(count()))),
    markSeen,
  };
  return { count, capped, markSeen, provider: { provide: SecurityAlerts, useValue: fake } };
}
