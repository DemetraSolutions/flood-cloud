import { inject } from '@angular/core';
import { CanMatchFn, Router, UrlSegment, UrlTree } from '@angular/router';
import { FeatureName } from '../groups/feature-catalog';
import { GroupContext } from '../groups/group-context';
import { GroupFeatures } from '../groups/group-features';
import { SessionService } from '../session/session.service';
import { Role } from '../session/session.types';
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

/**
 * Requires at least one of the given permissions (pages that serve several areas, each with its
 * own permission). Without any the user lands on `/forbidden`; the server still decides.
 *
 * @param required Permissions in the form `resource:action`, any of which is enough.
 */
export function anyPermission(...required: string[]): CanMatchFn {
  return () =>
    required.some((one) => inject(SessionService).can(one))
      ? true
      : inject(Router).createUrlTree(['/forbidden']);
}

/**
 * Requires one of the given roles (for areas that only make sense to them, e.g. platform
 * users). Others land on `/forbidden`; the server still decides on every call.
 *
 * @param allowed Roles admitted.
 */
export function role(...allowed: Role[]): CanMatchFn {
  return () => {
    const current = inject(SessionService).me()?.role;
    return current !== undefined && allowed.includes(current)
      ? true
      : inject(Router).createUrlTree(['/forbidden']);
  };
}

const OBJECT_ID = /^[0-9a-f]{24}$/;

/** Group of a page of the group area (`groups/{groupId}/…`), `null` for any other path. */
function groupOfSegments(segments: readonly UrlSegment[]): string | null {
  const [first, second] = segments;
  return first?.path === 'groups' && second !== undefined && OBJECT_ID.test(second.path)
    ? second.path
    : null;
}

/**
 * Requires a feature (module) of the group the page belongs to. Declare it on routes whose path
 * starts with `groups/:groupId`: users bound to a group use their own group, a PSA or dealer the
 * one in the URL (its features are read first). A module that is off lands on the
 * "feature disabled" page, like the `403 FEATURE_DISABLED` the server answers.
 *
 * @param required Feature name of the catalog.
 */
export function feature(required: FeatureName): CanMatchFn {
  return async (_route, segments) => {
    const features = inject(GroupFeatures);
    const router = inject(Router);
    return (await features.isEnabledFor(groupOfSegments(segments), required))
      ? true
      : router.createUrlTree(['/feature-disabled']);
  };
}

/**
 * Entry of the group area (`/groups`): with a working group it redirects to its users; a PSA
 * or dealer who has not chosen one yet stays on the page that asks to choose.
 */
export const groupLanding: CanMatchFn = (): boolean | UrlTree => {
  const groupId = inject(GroupContext).groupId();
  return groupId === null ? true : inject(Router).createUrlTree(['/groups', groupId, 'users']);
};

/** Query parameters of the users list that follow the working group (the others belong to the previous view). */
export const USERS_LIST_FILTERS = ['q', 'role', 'status', 'trashed', 'sort', 'limit'] as const;

/**
 * Cross-group list of users (`/users`, PSA and dealers): when a working group is chosen the
 * list is that group's, so it redirects to the group list keeping the filters of the URL
 * (never the cursor, and `groupId`/`dealerId`, which belong to the cross-group view). Without
 * a chosen group the cross-group list is shown.
 */
export const usersLanding: CanMatchFn = (): boolean | UrlTree => {
  const groupId = inject(GroupContext).groupId();
  if (groupId === null) {
    return true;
  }
  const router = inject(Router);
  const params = router.getCurrentNavigation()?.extractedUrl.queryParams ?? {};
  const queryParams = Object.fromEntries(
    USERS_LIST_FILTERS.filter((name) => params[name] !== undefined).map((name) => [
      name,
      params[name],
    ]),
  );
  return router.createUrlTree(['/groups', groupId, 'users'], { queryParams });
};

/** Query parameters of the companies list that follow the working group (the others belong to the previous view). */
export const COMPANIES_LIST_FILTERS = [
  'q',
  'status',
  'trashed',
  'country',
  'province',
  'sort',
  'limit',
] as const;

/** Same for the places list (`plan` too; never the company, which belongs to a group). */
export const PLACES_LIST_FILTERS = [...COMPANIES_LIST_FILTERS, 'plan'] as const;

/**
 * Landing of a cross-group list: with a working group chosen the list is that group's, so it
 * redirects to the group list keeping the given filters of the URL (never the cursor, nor
 * `groupId`/`dealerId`, which belong to the cross-group view).
 */
function crossGroupLanding(page: string, filters: readonly string[]): CanMatchFn {
  return (): boolean | UrlTree => {
    const groupId = inject(GroupContext).groupId();
    if (groupId === null) {
      return true;
    }
    const router = inject(Router);
    const params = router.getCurrentNavigation()?.extractedUrl.queryParams ?? {};
    const queryParams = Object.fromEntries(
      filters.filter((name) => params[name] !== undefined).map((name) => [name, params[name]]),
    );
    return router.createUrlTree(['/groups', groupId, page], { queryParams });
  };
}

/** Cross-group list of companies (`/companies`): the group's list when a group is chosen. */
export const companiesLanding: CanMatchFn = crossGroupLanding('companies', COMPANIES_LIST_FILTERS);

/** Cross-group list of places (`/places`): the group's list when a group is chosen. */
export const placesLanding: CanMatchFn = crossGroupLanding('places', PLACES_LIST_FILTERS);

/**
 * Cross-group trash (`/trash`): with a working group chosen the trash is that group's, so it
 * redirects to it keeping the tab, the search and the page size (never the cursor, `groupId` or
 * `dealerId`).
 */
export const trashLanding: CanMatchFn = crossGroupLanding('trash', ['tab', 'q', 'limit']);
