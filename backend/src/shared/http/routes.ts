import express from 'express';
import type { RequestHandler, Router } from 'express';
import { isFeature } from '../../modules/groups/features.ts';
import type { Feature } from '../../modules/groups/features.ts';
import { isPermission } from '../security/rbac/permissions.ts';
import { isPublicPermission } from '../security/rbac/public-permissions.ts';
import type { PublicPermission } from '../security/rbac/public-permissions.ts';
import type { Permission } from '../security/rbac/permissions.ts';
import { STORE_PROFILE } from '../security/rbac/policy.ts';
import { requirePermission } from '../security/rbac/require-permission.ts';
import { guardAuthentication, rateLimit } from '../security/rate-limit/rate-limit.ts';
import type { RateLimitMount, RateLimitRule } from '../security/rate-limit/rate-limit.ts';
import type { NonBrowserSignal } from '../security/non-browser-signal.ts';
import { sustainedRateLimit } from '../security/rate-limit/sustained.ts';
import { requireApiKeyPermission } from '../security/scope/api-key-guards.ts';
import { reportCrossGroupAccess, requireApiKeyGroupAccess, requireGroupAccess, requireStoreGroupAccess } from '../security/scope/group-access.ts';
import type { GroupAccessDeps } from '../security/scope/group-access.ts';
import { requireFeature } from '../security/scope/require-feature.ts';
import { refuseStore, requireStore, requireStoreParams, requireStoreText, requireStorePermission, requireStorePlace } from '../security/scope/store-guards.ts';
import type { Schema } from '../validation/schema.ts';
import { AppError } from './errors.ts';

/** HTTP methods a route may declare. */
export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** An HTTP method accepted by the route builder. */
export type RouteMethod = (typeof ROUTE_METHODS)[number];

/**
 * Authentication declared by a route. No route is anonymous by omission: it must
 * say so explicitly and give the reason.
 */
export interface AnonymousAuth {
  readonly kind: 'anonymous';
  /** Why the route is reachable without credentials; must not be empty. */
  readonly reason: string;
}

/** A route reserved to authenticated backoffice users holding a permission. */
export interface UserAuth {
  readonly kind: 'user';
  /** Permission of the catalog the caller must hold. Exactly one of `permission` and `anyPermission` is declared. */
  readonly permission?: Permission;
  /** Alternative to `permission`: the caller must hold at least one of these (a non-empty list from the catalog). */
  readonly anyPermission?: readonly Permission[];
  /**
   * The path has a `:groupId` parameter: the group is verified against the caller's scope and the
   * group's state before the permission check. Must be `true` exactly when the path contains `:groupId`.
   */
  readonly group?: boolean;
  /**
   * The feature of the group the route belongs to (D-13): once the group and the permission are checked, a group that
   * does not have it turned on gets `403 FEATURE_DISABLED`, whatever the role. Allowed only with `group: true`.
   */
  readonly feature?: Feature;
  /**
   * `true` on the few routes a user who still has to replace a provisional password may call (his
   * profile, the password change, the logout). Every other `user` route answers `403 PASSWORD_CHANGE_REQUIRED` to him.
   */
  readonly allowWithPendingPasswordChange?: true;
  /**
   * Opens the route to the server of a point of sale authenticated with its store key (D-24): the opt-in is explicit, route by route, and the default is deny (`403 FORBIDDEN` to a store).
   * Allowed only on a route with `permission` (not `anyPermission`) that is in `STORE_PROFILE`, with `group: true` and a `:placeId` in the path (a store reaches its own place and nothing else), without
   * `allowWithPendingPasswordChange`, on a surface that accepts store keys. A user reaches the route as he always did.
   */
  readonly store?: true;
}

/**
 * The only path parameters a store route may have: the ids of the entries it reads or writes (the catalog `/store-context/catalog/products/:productId`, the contacts and the loyalty cards). The builder checks each one is the text of
 * an id before anything else of the route runs; the group, the company and the place are never a parameter, they come from the store key.
 */
export const STORE_PATH_PARAMETERS = Object.freeze(['productId', 'categoryId', 'brandId', 'attributeGroupId', 'contactId', 'cardId'] as const);

/**
 * The path parameters of a store route that are text, not ids: the code of a loyalty card (`/store-context/contacts/:contactId/fidelity-cards/:code/points-adjustments`). A route that has one **declares** it, with the schema
 * that judges it, in `text` of its auth: the builder validates it (`422` with the name of the parameter) next to the ids, before the body is read, and refuses at start-up a text parameter in the path that has no schema declared.
 */
export const STORE_TEXT_PATH_PARAMETERS = Object.freeze(['code'] as const);

/** A text path parameter a store route may declare. */
export type StoreTextParameter = (typeof STORE_TEXT_PATH_PARAMETERS)[number];

/** A path parameter a store route may declare. */
export type StoreParameter = (typeof STORE_PATH_PARAMETERS)[number];

/**
 * A route only the server of a point of sale may call, with its store key (`GET /v1/store-context`). It needs no permission of the catalog (the profile of the store is fixed), has no path parameter
 * but the ids it declares in `params` and is rate limited per store key.
 */
export interface StoreAuth {
  readonly kind: 'store';
  /**
   * The path parameters of the route: exactly the ones in its path, each of {@link STORE_PATH_PARAMETERS}. The builder checks each is the text of an id (`422` otherwise) right after the group access, so
   * a store route has no other parameter and never reads one unchecked.
   */
  readonly params?: readonly StoreParameter[];
  /**
   * The text path parameters of the route (one of {@link STORE_TEXT_PATH_PARAMETERS}) with the schema of each: exactly the ones in its path that are not ids. The builder validates them with the ids, before the body is read.
   */
  readonly text?: Readonly<Partial<Record<StoreTextParameter, Schema<unknown>>>>;
  /**
   * The check of who stands at the till, declared **exactly** by the routes that write (every method but `GET`): it runs after the group access and the declared rate limit rules and before the body is read, so the body of a store
   * that has no verified operator is never parsed. A read declares none.
   */
  readonly operator?: RequestHandler;
  /**
   * `true` for a route that reads the group database of the store: the builder then issues the verified access to the one group of the store key (`requireStoreGroupAccess`) right after the
   * authentication, so the access is never a middleware a route can place by hand, and a `user` route can never have it. Needs a surface with the group access dependencies.
   */
  readonly group?: true;
}

/**
 * A route of the public surface (`/public/v1`), reserved to an integration authenticated with a public API key (`X-Api-Key`). The only kind that surface accepts, and one the
 * backoffice surface never accepts: a user token or a store key never authenticates here, and an API key never authenticates there.
 */
export interface ApiKeyAuth {
  readonly kind: 'apiKey';
  /** Permission of the public catalog the key must hold, or `null` for a route every valid key may call (`GET /me`): it is always declared, never left out. */
  readonly permission: PublicPermission | null;
  /**
   * `true` for a route that reads or writes the group database: the builder then issues the verified access to the one group of the key (`requireApiKeyGroupAccess`) right after the permission check, so the access
   * is never a middleware a route can place by hand. Needs the group access dependencies.
   */
  readonly group?: true;
}

/** Authentication requirement of a route. */
export type RouteAuth = AnonymousAuth | UserAuth | StoreAuth | ApiKeyAuth;

/** Declarative description of a route. */
export interface RouteDefinition {
  readonly method: RouteMethod;
  /** Path relative to the router it is mounted on. */
  readonly path: string;
  readonly auth: RouteAuth;
  /** JSON body size limit (body-parser syntax, for example `'1mb'`); defaults to {@link DEFAULT_BODY_LIMIT}. */
  readonly bodyLimit?: string | number;
  /**
   * Extra rate limit rules (`createRateLimitRules`). `user` routes always get the per-user API rule
   * as well, without declaring it; an anonymous route must declare at least one rule that runs before
   * the body parser (a rule without `needsBody`), unless it is exempt.
   */
  readonly rateLimit?: readonly RateLimitRule[];
  /**
   * Exempts an anonymous route from the rate limit requirement. Accepted only by a router mounted with
   * `allowRateLimitExempt` (the health probes of the orchestrator); a `user` route can never be exempt.
   */
  readonly rateLimitExempt?: { readonly reason: string };
  /**
   * Middleware run just before the handler, after the body parser and the rules that read the body;
   * the validation of body, query and params goes here (`validateBody`, `validateParams`…).
   */
  readonly middleware?: readonly RequestHandler[];
  /**
   * For a route whose body is not JSON (an upload): the handler that reads it, which replaces the JSON guard and parser (`POST`, `PUT` and `PATCH` only). It runs after
   * authentication, the rate limit, the group check and the permission, so a body is never read for a caller who may not send it, and it is responsible for refusing a body that is
   * not of the expected type (`415`) and for its size limit; `bodyLimit` does not apply.
   */
  readonly multipart?: RequestHandler;
  /**
   * `false` for a route whose response carries credentials (access or refresh tokens): the response
   * is never compressed, which would expose the secrets to BREACH-style attacks (D-12).
   */
  readonly compress?: false;
  /**
   * `true` on a route the hourly and daily limits of `/v1` count but never refuse, even in `enforce`: the revocation of one's own sessions and the change of one's own credentials, which a
   * user who went over the limit (or whose stolen token did) must always be able to perform. Only the routes of {@link SUSTAINED_EXEMPT_ROUTES} may declare it (the check is on the exact
   * method and path, never on a pattern), and only as `user` routes.
   */
  readonly sustainedExempt?: true;
  readonly handler: RequestHandler;
}

/**
 * The closed set of routes (`<METHOD> <path declared on /v1>`) that may declare `sustainedExempt`: logout, logout of every session, change of the own password and of the own PIN,
 * and revocation of one of the own sessions. Adding a route here is a security decision (`doc/Security-Model.md` section 7).
 */
export const SUSTAINED_EXEMPT_ROUTES: ReadonlySet<string> = Object.freeze(new Set(['POST /auth/logout', 'POST /auth/logout-all', 'PUT /me/password', 'PUT /me/pin', 'DELETE /me/sessions/:sessionId']));

/** Body limit applied when a route does not override it. */
export const DEFAULT_BODY_LIMIT = '100kb';

const BODY_METHODS: ReadonlySet<RouteMethod> = new Set(['POST', 'PUT', 'PATCH']);
const CHARSET_PARAMETER = /;\s*charset\s*=\s*"?([^";\s]+)"?/i;

/**
 * Identity helper that gives a route literal its type.
 *
 * @param definition The route.
 * @returns The same definition.
 */
export function defineRoute(definition: RouteDefinition): RouteDefinition {
  return definition;
}

/**
 * Normalizes a path so that paths Express would match identically compare equal:
 * lower case, no trailing slash (except the root) and every `:param` replaced by `:`. A parameter name is made of word characters, so `:dealerId.csv` is a parameter followed by `.csv`.
 */
function normalizePath(path: string): string {
  const lower = path.toLowerCase().replace(/:\w+/g, ':');
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

type AuthFields = { kind?: unknown; permission?: unknown; anyPermission?: unknown; group?: unknown; feature?: unknown; allowWithPendingPasswordChange?: unknown; store?: unknown; params?: unknown; text?: unknown; operator?: unknown };

/** The problems of a `user` route that declares `store`. */
function storeProblems(label: string, route: RouteDefinition, auth: AuthFields, options: MountOptions): string[] {
  const problems: string[] = [];
  if (auth.store !== true) {
    problems.push(`${label}: store can only be true`);
  }
  if (auth.anyPermission !== undefined || !STORE_PROFILE.has(auth.permission as Permission)) {
    problems.push(`${label}: a route open to a store key needs a single permission that is in the profile of the store`);
  }
  if (auth.group !== true || !/\/places\/:placeId(?![A-Za-z0-9_])/.test(String(route.path))) {
    problems.push(`${label}: a route open to a store key must be on a group and on a :placeId (a store reaches its own place only)`);
  }
  if (auth.allowWithPendingPasswordChange !== undefined) {
    problems.push(`${label}: a route open to a store key cannot allow a pending password change`);
  }
  if (options.storeKeys !== true) {
    problems.push(`${label}: a route open to a store key needs a surface that accepts store keys`);
  }
  return problems;
}

/** The problems of a route reserved to the server of a point of sale (`kind: 'store'`). */
function storeOnlyProblems(label: string, route: RouteDefinition, auth: AuthFields, options: MountOptions): string[] {
  const problems: string[] = [];
  if (['permission', 'anyPermission', 'feature', 'allowWithPendingPasswordChange', 'store'].some((name) => (auth as Record<string, unknown>)[name] !== undefined)) {
    problems.push(`${label}: a store route declares nothing but its kind and, when it reads the group, group: true, the ids of its path (params) and, when it writes, its operator`);
  }
  if (auth.group !== undefined && auth.group !== true) {
    problems.push(`${label}: a store route's group can only be true`);
  } else if (auth.group === true && options.groupAccess === undefined) {
    problems.push(`${label}: a store route that asks for the group needs the groupAccess dependencies`);
  }
  if ((auth.params !== undefined || auth.operator !== undefined) && auth.group !== true) {
    problems.push(`${label}: a store route with params or an operator must declare group: true`);
  }
  if (/[*{}]/.test(String(route.path))) {
    problems.push(`${label}: a store route's path has no wildcard or group (*, {, }): only literal segments and the declared ids`);
  }
  const declared: unknown = auth.params;
  if (declared !== undefined && !(Array.isArray(declared) && declared.length > 0 && new Set(declared).size === declared.length && declared.every((name) => (STORE_PATH_PARAMETERS as readonly unknown[]).includes(name)))) {
    problems.push(`${label}: a store route's params are a list, without repetitions, of ${STORE_PATH_PARAMETERS.join(', ')}`);
  }
  const text: unknown = auth.text;
  const textNames = typeof text === 'object' && text !== null ? Object.keys(text) : [];
  if (text !== undefined && (typeof text !== 'object' || text === null || textNames.length === 0 || !textNames.every((name) => (STORE_TEXT_PATH_PARAMETERS as readonly unknown[]).includes(name) && typeof (text as Record<string, { parse?: unknown }>)[name]?.parse === 'function'))) {
    problems.push(`${label}: a store route's text is a list of schemas for ${STORE_TEXT_PATH_PARAMETERS.join(', ')}`);
  }
  const inPath = [...String(route.path).matchAll(/:(\w+)/g)].map((match) => match[1]);
  const listed = [...(Array.isArray(declared) ? (declared as unknown[]) : []), ...textNames];
  if (String(route.path).replace(/:\w+/g, '').includes(':') || inPath.length !== listed.length || !inPath.every((name) => listed.includes(name))) {
    problems.push(`${label}: a store route has no path parameter other than the ids it declares in params and the text it declares in text`);
  }
  if (auth.operator !== undefined && typeof auth.operator !== 'function') {
    problems.push(`${label}: a store route's operator must be a function`);
  } else if ((auth.operator !== undefined) !== (route.method !== 'GET')) {
    problems.push(`${label}: a store route declares an operator exactly when it writes`);
  }
  if (options.authenticate === undefined || options.storeKeys !== true) {
    problems.push(`${label}: a store route needs a surface that accepts store keys, with its authenticate middleware`);
  }
  return problems;
}

/** The problems of a route of the public surface (`kind: 'apiKey'`): a permission of the public catalog or an explicit `null`, and what the chain needs. */
function apiKeyProblems(label: string, auth: AuthFields, options: MountOptions): string[] {
  const problems: string[] = [];
  if (auth.permission !== null && !isPublicPermission(auth.permission)) {
    problems.push(`${label}: an API key route declares a permission of the public catalog, or null`);
  }
  if (['anyPermission', 'feature', 'allowWithPendingPasswordChange', 'store'].some((name) => (auth as Record<string, unknown>)[name] !== undefined)) {
    problems.push(`${label}: an API key route declares nothing but its kind, its permission and, when it reads the group, group: true`);
  }
  if (auth.group !== undefined && auth.group !== true) {
    problems.push(`${label}: an API key route's group can only be true`);
  } else if (auth.group === true && options.groupAccess === undefined) {
    problems.push(`${label}: an API key route that asks for the group needs the groupAccess dependencies`);
  }
  if (options.authenticate === undefined) {
    problems.push(`${label}: API key route needs an authenticate middleware`);
  }
  if (options.rateLimit === undefined) {
    problems.push(`${label}: API key route needs the rateLimit dependencies`);
  }
  return problems;
}

/**
 * Checks every route and returns a human-readable list of problems.
 *
 * @returns One message per problem; empty when all routes are valid.
 */
function validateRoutes(routes: readonly RouteDefinition[], options: MountOptions): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const allowed: readonly string[] = options.allowedAuth ?? DEFAULT_ALLOWED_AUTH;
  for (const route of routes) {
    const label = `${String(route.method)} ${String(route.path)}`;
    if (!(ROUTE_METHODS as readonly unknown[]).includes(route.method)) {
      problems.push(`${label}: method not allowed`);
    }
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      problems.push(`${label}: path must be a string starting with "/"`);
    }
    const auth = route.auth as { kind?: unknown; reason?: unknown; permission?: unknown; anyPermission?: unknown; group?: unknown; feature?: unknown; allowWithPendingPasswordChange?: unknown; store?: unknown } | undefined;
    if (auth === undefined || auth === null) {
      problems.push(`${label}: missing auth declaration`);
    } else if (auth.kind === 'anonymous') {
      if (typeof auth.reason !== 'string' || auth.reason.trim() === '') {
        problems.push(`${label}: anonymous route needs a non-empty reason`);
      }
    } else if (auth.kind === 'user') {
      if (auth.anyPermission !== undefined) {
        const any: unknown = auth.anyPermission;
        if (auth.permission !== undefined) {
          problems.push(`${label}: declare either permission or anyPermission, not both`);
        } else if (!Array.isArray(any) || any.length === 0) {
          problems.push(`${label}: anyPermission must be a non-empty list`);
        } else if (!any.every(isPermission)) {
          problems.push(`${label}: unknown permission`);
        }
      } else if (!isPermission(auth.permission)) {
        problems.push(`${label}: unknown permission`);
      }
      if (options.authenticate === undefined) {
        problems.push(`${label}: user route needs an authenticate middleware`);
      }
      if (options.rateLimit === undefined) {
        problems.push(`${label}: user route needs the rateLimit dependencies`);
      }
      const hasGroupParam = /:groupId(?![A-Za-z0-9_])/.test(String(route.path));
      if (hasGroupParam !== (auth.group === true)) {
        problems.push(`${label}: the path has :groupId exactly when the auth declares group: true`);
      } else if (auth.group === true && options.groupAccess === undefined) {
        problems.push(`${label}: group route needs the groupAccess dependencies`);
      }
      if (auth.feature !== undefined) {
        if (!isFeature(auth.feature)) {
          problems.push(`${label}: unknown feature`);
        } else if (auth.group !== true) {
          problems.push(`${label}: a feature can only be required by a route declaring group: true`);
        }
      }
      if (auth.allowWithPendingPasswordChange !== undefined && auth.allowWithPendingPasswordChange !== true) {
        problems.push(`${label}: allowWithPendingPasswordChange can only be true`);
      }
      if (auth.store !== undefined) {
        problems.push(...storeProblems(label, route, auth, options));
      }
    } else if (auth.kind === 'store') {
      problems.push(...storeOnlyProblems(label, route, auth, options));
    } else if (auth.kind === 'apiKey') {
      problems.push(...apiKeyProblems(label, auth, options));
    } else {
      problems.push(`${label}: unknown auth kind`);
    }
    if (auth?.kind === 'anonymous' && auth.allowWithPendingPasswordChange !== undefined) {
      problems.push(`${label}: only user routes can allow a pending password change`);
    }
    if (auth?.kind === 'anonymous' && auth.store !== undefined) {
      problems.push(`${label}: only user routes can be opened to a store key`);
    }
    if ((auth?.kind === 'anonymous' || auth?.kind === 'user' || auth?.kind === 'store' || auth?.kind === 'apiKey') && !allowed.includes(auth.kind)) {
      problems.push(`${label}: auth kind "${auth.kind}" is not allowed on this surface`);
    }
    const extra: unknown = route.middleware;
    if (extra !== undefined && !(Array.isArray(extra) && extra.every((item: unknown) => typeof item === 'function'))) {
      problems.push(`${label}: middleware must be a list of functions`);
    }
    const multipart: unknown = route.multipart;
    if (multipart !== undefined && (typeof multipart !== 'function' || !BODY_METHODS.has(route.method))) {
      problems.push(`${label}: multipart must be a function and only POST, PUT and PATCH routes read a body`);
    }
    const exempt: unknown = route.sustainedExempt;
    if (exempt !== undefined && (exempt !== true || auth?.kind !== 'user' || !SUSTAINED_EXEMPT_ROUTES.has(label))) {
      problems.push(`${label}: sustainedExempt can only be true, on a user route of SUSTAINED_EXEMPT_ROUTES`);
    }
    const compress: unknown = route.compress;
    if (compress !== undefined && compress !== false) {
      problems.push(`${label}: compress can only be false`);
    }
    if (route.rateLimit !== undefined) {
      const rules: unknown = route.rateLimit;
      if (
        !Array.isArray(rules) ||
        !rules.every((rule: Partial<RateLimitRule> | null) => typeof rule?.bucket === 'string' && rule.bucket !== '' && typeof rule.key === 'function')
      ) {
        problems.push(`${label}: rateLimit must be a list of rules with a bucket and a key function`);
      } else if (options.rateLimit === undefined && rules.length > 0) {
        problems.push(`${label}: rate limit rules need the rateLimit dependencies`);
      } else if ((rules as RateLimitRule[]).some((rule) => rule.needsGroup === true) && !(auth?.kind === 'user' && auth.group === true)) {
        problems.push(`${label}: a rate limit rule that needs the group requires a user route declaring group: true`);
      }
    }
    if (auth?.kind === 'anonymous') {
      const exempt = route.rateLimitExempt as { reason?: unknown } | undefined;
      if (exempt !== undefined) {
        if (options.allowRateLimitExempt !== true) {
          problems.push(`${label}: rateLimitExempt is not allowed on this surface`);
        } else if (typeof exempt.reason !== 'string' || exempt.reason.trim() === '') {
          problems.push(`${label}: rateLimitExempt needs a non-empty reason`);
        }
      } else if (!(Array.isArray(route.rateLimit) && route.rateLimit.some((rule: Partial<RateLimitRule> | null) => rule?.needsBody !== true))) {
        problems.push(`${label}: anonymous route must declare a rate limit rule that runs before the body parser`);
      }
    } else if (route.rateLimitExempt !== undefined) {
      problems.push(`${label}: only anonymous routes can be exempt from the rate limit`);
    }
    for (const [, name] of String(route.path).matchAll(/\/groups\/:([^/]+)/g)) {
      if (name !== 'groupId') {
        problems.push(`${label}: the group parameter must be named :groupId, not :${String(name)}`);
      }
    }
    const key = `${String(route.method)} ${normalizePath(String(route.path))}`;
    if (seen.has(key)) {
      problems.push(`${label}: duplicate route`);
    }
    seen.add(key);
  }
  return problems;
}

/** Rejects, with 415, a request whose body is not JSON in UTF-8. Requests with an empty body pass. */
const requireJsonContentType: RequestHandler = (req, _res, next) => {
  if (req.get('content-length') === '0') {
    next();
    return;
  }
  if (req.is('application/json') === false) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  }
  const charset = CHARSET_PARAMETER.exec(req.get('content-type') ?? '')?.[1];
  if (charset !== undefined && charset.toLowerCase() !== 'utf-8') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  }
  next();
};

/** Stops a user who has not yet replaced his provisional password from using the route. */
const refusePendingPasswordChange: RequestHandler = (_req, res, next) => {
  if (res.locals.passwordChangeRequired === true) {
    throw new AppError('PASSWORD_CHANGE_REQUIRED');
  }
  next();
};

/** Runs a list of handlers in order, as one middleware (a router, so an error in any of them, async ones included, goes to the error handler). `mergeParams` keeps the path parameters the handlers read. */
function chainOf(handlers: readonly RequestHandler[]): RequestHandler {
  const router = express.Router({ mergeParams: true });
  router.use(...handlers);
  return router;
}

/** Sends a request that carries a store principal down one chain and every other request down the other: the store chain and the user chain never mix. */
function byCaller(forStore: readonly RequestHandler[], forUser: readonly RequestHandler[]): RequestHandler {
  const store = chainOf(forStore);
  const user = chainOf(forUser);
  return (req, res, next) => (res.locals.store === undefined ? user : store)(req, res, next);
}

/** Options of {@link mountRoutes}. */
export interface MountOptions {
  /**
   * Authentication middleware of the surface: it must set `res.locals.auth` or fail. Required as
   * soon as one route has `user` auth; without it mounting fails (deny by default).
   */
  readonly authenticate?: RequestHandler;
  /** Group existence lookup and audit callback, needed by routes declaring `group: true`. */
  readonly groupAccess?: GroupAccessDeps;
  /** Limiter, exceeded callback and the per-user API rule applied to every `user` route; required by `user` routes and by routes declaring rules. */
  readonly rateLimit?: RateLimitMount;
  /** Signal on the requests of a user that do not look like a browser's (`createNonBrowserSignal`): runs on every `user` route right after the rate limits; it reports them and, under the policy `block`, refuses them, except on the `sustainedExempt` routes. Absent: none. */
  readonly nonBrowserSignal?: NonBrowserSignal;
  /** Lets anonymous routes declare `rateLimitExempt`; only the health router sets it. */
  readonly allowRateLimitExempt?: boolean;
  /** Auth kinds this surface accepts; only anonymous routes by default, so `user` (and `store`) must be allowed explicitly (the backoffice does). */
  readonly allowedAuth?: ReadonlyArray<RouteAuth['kind']>;
  /**
   * `true` when the `authenticate` middleware of the surface also accepts store keys (it sets `res.locals.store` for them and applies the per-key rate limit itself). Without it a route
   * declaring `store: true` or `auth: { kind: 'store' }` cannot be mounted: a store key is accepted only where the surface says so.
   */
  readonly storeKeys?: true;
}

const DEFAULT_ALLOWED_AUTH: readonly string[] = ['anonymous'];

/**
 * Mounts validated routes on a router. For every path it registers the declared
 * methods plus a catch-all answering 405 with the `Allow` header. `GET` implies `HEAD`.
 * The chain of a `user` route is: `authenticate` (guarded by the per-IP limit on failed authentications), the rate limit (the per-user API rule, then the
 * declared rules), the refusal of a user with a provisional password (unless the route allows it), the group check (when `group: true`), `requirePermission` (which reports PSA and D
 * group requests with their outcome), the feature check (when the route declares a `feature`), the rules that read the verified group (`needsGroup`), then (POST/PUT/PATCH) the 415 guard and the per-route JSON parser (or the route's `multipart` handler instead),
 * then the declared rules that read the body (`needsBody`), then the route `middleware` (validation), then the handler. An anonymous route runs
 * its declared rules, the guard and parser, the body rules, the handler. `/health` declares none.
 *
 * A caller that authenticated with a store key (`res.locals.store`, never `res.locals.auth`) is refused with `403` by every `user` route that does not declare `store: true`, right after `authenticate`;
 * on a route that does, it follows its own chain (the group check on the store principal, the place of the key, the store profile, the feature), and a user follows the chain above.
 * A route with `auth: { kind: 'store' }` runs `authenticate`, refuses whoever is not a store, issues the group access (`group: true`), checks the ids of its path (`params`), applies the declared rules, runs the check of the operator of a write (`operator`) and reads the body. The per-key rate limit is the store authentication's own.
 * A route with `auth: { kind: 'apiKey', permission }` (the public surface) runs `authenticate` (guarded by the per-IP limit on failed authentications), refuses a key that lacks the permission (`403`), issues the access to the
 * group of the key when it declares `group: true`, then applies the declared rules before the body; the per-key rate limit and the daily quota are the API key authentication's own.
 *
 * @param router Target router.
 * @param routes Route declarations.
 * @param options The `authenticate` middleware and the rate limit dependencies, needed by `user` routes.
 * @throws {Error} At startup, listing every invalid route (missing or unknown auth,
 * empty reason, unknown permission, both or an empty `anyPermission`, unknown feature or a feature without `group: true`, `user` route without `authenticate` or rate limit dependencies, inconsistent `group`,
 * malformed rate limit rules, malformed `middleware`, `multipart` or `compress`, an anonymous route without a pre-parser rate limit rule or a misplaced exemption,
 * auth kind not allowed on the surface, an `apiKey` route with a permission outside the public catalog or without `authenticate` and the rate limit dependencies, a `store` declaration that is not `true`, on an anonymous route, with `anyPermission`, outside `STORE_PROFILE`, without `group: true` and a `:placeId`, with a pending password change or on a surface that does not accept store keys, a store route with anything but its kind, its group, its ids and its operator, with a path parameter that is not a declared id, with an operator on a read or without one on a write, disallowed method,
 * bad path, duplicate method and path).
 */
export function mountRoutes(router: Router, routes: readonly RouteDefinition[], options: MountOptions = {}): void {
  const { authenticate, groupAccess, rateLimit: rateLimitOptions } = options;
  const problems = validateRoutes(routes, options);
  if (problems.length > 0) {
    throw new Error(`Invalid route definitions:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }

  const groups = new Map<string, { path: string; methods: Set<RouteMethod> }>();
  for (const route of routes) {
    const key = normalizePath(route.path);
    const group = groups.get(key) ?? { path: route.path, methods: new Set<RouteMethod>() };
    group.methods.add(route.method);
    groups.set(key, group);

    const middleware: RequestHandler[] = [
      (req, res, next) => {
        // Express forgets `baseUrl` once the router is left, so the error reporting reads this instead.
        res.locals.routePattern = `${req.baseUrl}${route.path}`;
        if (route.compress === false) {
          res.locals.noCompression = true;
        }
        next();
      },
    ];
    const declared = route.rateLimit ?? [];
    const limits = (rules: readonly RateLimitRule[]): RequestHandler[] => rules.map((rule) => rateLimit(rule, rateLimitOptions!));
    const beforeBody = limits(declared.filter((rule) => rule.needsBody !== true && rule.needsGroup !== true));
    const afterBody = limits(declared.filter((rule) => rule.needsBody === true));
    const afterGroup = limits(declared.filter((rule) => rule.needsGroup === true));
    if (route.auth.kind === 'user') {
      const grouped = route.auth.group === true;
      const userChain: RequestHandler[] = [
        ...limits([rateLimitOptions!.apiRule]),
        ...(rateLimitOptions!.sustained === undefined ? [] : [sustainedRateLimit(rateLimitOptions!.sustained, rateLimitOptions!.limiter, route.sustainedExempt === true)]),
        ...(options.nonBrowserSignal === undefined ? [] : [options.nonBrowserSignal(route.sustainedExempt === true)]),
        ...beforeBody,
        ...(route.auth.allowWithPendingPasswordChange === true ? [] : [refusePendingPasswordChange]),
        ...(grouped ? [requireGroupAccess(groupAccess!.groups)] : []),
        requirePermission(route.auth.anyPermission ?? route.auth.permission!, grouped ? reportCrossGroupAccess(groupAccess!.onCrossGroupAccess) : undefined),
        ...(route.auth.feature === undefined ? [] : [requireFeature(route.auth.feature)]),
        ...afterGroup,
      ];
      middleware.push(guardAuthentication(authenticate!, rateLimitOptions!));
      if (route.auth.store === true) {
        // Open to a store key: a store follows its own chain (its rate limit, the group, its place, its profile), a user the one above.
        const storeChain: RequestHandler[] = [
          ...beforeBody,
          requireGroupAccess(groupAccess!.groups, (res) => res.locals.store),
          requireStorePlace,
          requireStorePermission(route.auth.permission!),
          ...(route.auth.feature === undefined ? [] : [requireFeature(route.auth.feature)]),
          ...afterGroup,
        ];
        middleware.push(byCaller(storeChain, userChain));
      } else {
        middleware.push(refuseStore, ...userChain);
      }
    } else if (route.auth.kind === 'store') {
      middleware.push(
        guardAuthentication(authenticate!, rateLimitOptions!),
        requireStore,
        ...(route.auth.group === true ? [requireStoreGroupAccess(groupAccess!.groups)] : []),
        ...(route.auth.params === undefined ? [] : [requireStoreParams(route.auth.params)]),
        ...(route.auth.text === undefined ? [] : [requireStoreText(route.auth.text)]),
        ...beforeBody,
        ...(route.auth.operator === undefined ? [] : [route.auth.operator]),
      );
    } else if (route.auth.kind === 'apiKey') {
      // The per-key rate limit and the daily quota are the authentication's own (the limits are the key's, not a constant of the rule).
      middleware.push(guardAuthentication(authenticate!, { ...rateLimitOptions!, authFailureRule: rateLimitOptions!.apiKeyAuthFailureRule }), requireApiKeyPermission(route.auth.permission), ...(route.auth.group === true ? [requireApiKeyGroupAccess(groupAccess!.groups)] : []), ...beforeBody);
    } else {
      middleware.push(...beforeBody);
    }
    if (BODY_METHODS.has(route.method) && route.multipart !== undefined) {
      middleware.push(route.multipart);
    } else if (BODY_METHODS.has(route.method)) {
      middleware.push(
        requireJsonContentType,
        express.json({ limit: route.bodyLimit ?? DEFAULT_BODY_LIMIT, strict: true, inflate: false, type: 'application/json' }),
      );
    }
    middleware.push(...afterBody, ...(route.middleware ?? []), route.handler);
    switch (route.method) {
      case 'GET':
        router.get(route.path, ...middleware);
        break;
      case 'POST':
        router.post(route.path, ...middleware);
        break;
      case 'PUT':
        router.put(route.path, ...middleware);
        break;
      case 'PATCH':
        router.patch(route.path, ...middleware);
        break;
      case 'DELETE':
        router.delete(route.path, ...middleware);
        break;
    }
  }

  for (const { path, methods } of groups.values()) {
    const allow = [...methods].flatMap((method) => (method === 'GET' ? ['GET', 'HEAD'] : [method])).join(', ');
    router.all(path, () => {
      throw new AppError('METHOD_NOT_ALLOWED', { headers: { Allow: allow } });
    });
  }
}
