import { inject } from '@angular/core';
import { CanMatchFn, Router, UrlSegment, UrlTree } from '@angular/router';
import { SessionService } from '../session/session.service';
import { safeReturnUrl } from './return-url';

/** Location the user was heading to, used as `returnUrl` when sending an anonymous user to login. */
function targetUrl(router: Router, segments: readonly UrlSegment[]): string | null {
  const navigation = router.getCurrentNavigation();
  const target =
    navigation === null
      ? `/${segments.map((segment) => segment.path).join('/')}`
      : router.serializeUrl(navigation.extractedUrl);
  const safe = safeReturnUrl(target);
  return safe === '/' ? null : safe;
}

/**
 * Requires a signed-in user. An anonymous visitor is sent to `/login` with a validated
 * `returnUrl`, so the requested page is not matched (nor its code downloaded).
 */
export const authenticated: CanMatchFn = (_route, segments) => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.isAuthenticated()) {
    return true;
  }
  const returnUrl = targetUrl(router, segments);
  return router.createUrlTree(['/login'], { queryParams: returnUrl === null ? {} : { returnUrl } });
};

/** For the login page: a signed-in user goes to the home page instead. */
export const anonymousOnly: CanMatchFn = () => {
  const session = inject(SessionService);
  return session.isAuthenticated() ? inject(Router).createUrlTree(['/']) : true;
};

/**
 * While a temporary password is pending, every route behind it redirects to
 * `/change-password` (which is declared before it, so it stays reachable).
 */
export const passwordChangeAllowed: CanMatchFn = (): boolean | UrlTree => {
  const session = inject(SessionService);
  return session.status() === 'passwordChangeRequired'
    ? inject(Router).createUrlTree(['/change-password'])
    : true;
};

/**
 * Requires a permission. The menu hides entries, but the route is protected too: without the
 * permission the user lands on `/forbidden`. The server still decides on every call.
 *
 * @param required Permission in the form `resource:action`.
 */
export function permission(required: string): CanMatchFn {
  return () =>
    inject(SessionService).can(required) ? true : inject(Router).createUrlTree(['/forbidden']);
}
