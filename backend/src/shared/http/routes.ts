import express from 'express';
import type { RequestHandler, Router } from 'express';
import { isFeature } from '../../modules/groups/features.ts';
import type { Feature } from '../../modules/groups/features.ts';
import { isPermission } from '../security/rbac/permissions.ts';
import type { Permission } from '../security/rbac/permissions.ts';
import { requirePermission } from '../security/rbac/require-permission.ts';
import { guardAuthentication, rateLimit } from '../security/rate-limit/rate-limit.ts';
import type { RateLimitMount, RateLimitRule } from '../security/rate-limit/rate-limit.ts';
import { reportCrossGroupAccess, requireGroupAccess } from '../security/scope/group-access.ts';
import type { GroupAccessDeps } from '../security/scope/group-access.ts';
import { requireFeature } from '../security/scope/require-feature.ts';
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
}

/** Authentication requirement of a route. */
export type RouteAuth = AnonymousAuth | UserAuth;

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
   * `false` for a route whose response carries credentials (access or refresh tokens): the response
   * is never compressed, which would expose the secrets to BREACH-style attacks (D-12).
   */
  readonly compress?: false;
  readonly handler: RequestHandler;
}

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
 * lower case, no trailing slash (except the root) and every `:param` replaced by `:`.
 */
function normalizePath(path: string): string {
  const lower = path.toLowerCase().replace(/:[^/]+/g, ':');
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
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
    const auth = route.auth as { kind?: unknown; reason?: unknown; permission?: unknown; anyPermission?: unknown; group?: unknown; feature?: unknown; allowWithPendingPasswordChange?: unknown } | undefined;
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
    } else {
      problems.push(`${label}: unknown auth kind`);
    }
    if (auth?.kind === 'anonymous' && auth.allowWithPendingPasswordChange !== undefined) {
      problems.push(`${label}: only user routes can allow a pending password change`);
    }
    if ((auth?.kind === 'anonymous' || auth?.kind === 'user') && !allowed.includes(auth.kind)) {
      problems.push(`${label}: auth kind "${auth.kind}" is not allowed on this surface`);
    }
    const extra: unknown = route.middleware;
    if (extra !== undefined && !(Array.isArray(extra) && extra.every((item: unknown) => typeof item === 'function'))) {
      problems.push(`${label}: middleware must be a list of functions`);
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
  /** Lets anonymous routes declare `rateLimitExempt`; only the health router sets it. */
  readonly allowRateLimitExempt?: boolean;
  /** Auth kinds this surface accepts; only anonymous routes by default, so `user` must be allowed explicitly (the backoffice does). */
  readonly allowedAuth?: ReadonlyArray<RouteAuth['kind']>;
}

const DEFAULT_ALLOWED_AUTH: readonly string[] = ['anonymous'];

/**
 * Mounts validated routes on a router. For every path it registers the declared
 * methods plus a catch-all answering 405 with the `Allow` header. `GET` implies `HEAD`.
 * The chain of a `user` route is: `authenticate` (guarded by the per-IP limit on failed authentications), the rate limit (the per-user API rule, then the
 * declared rules), the refusal of a user with a provisional password (unless the route allows it), the group check (when `group: true`), `requirePermission` (which reports PSA and D
 * group requests with their outcome), the feature check (when the route declares a `feature`), then (POST/PUT/PATCH) the 415 guard and the per-route JSON parser,
 * then the declared rules that read the body (`needsBody`), then the route `middleware` (validation), then the handler. An anonymous route runs
 * its declared rules, the guard and parser, the body rules, the handler. `/health` declares none.
 *
 * @param router Target router.
 * @param routes Route declarations.
 * @param options The `authenticate` middleware and the rate limit dependencies, needed by `user` routes.
 * @throws {Error} At startup, listing every invalid route (missing or unknown auth,
 * empty reason, unknown permission, both or an empty `anyPermission`, unknown feature or a feature without `group: true`, `user` route without `authenticate` or rate limit dependencies, inconsistent `group`,
 * malformed rate limit rules, malformed `middleware` or `compress`, an anonymous route without a pre-parser rate limit rule or a misplaced exemption,
 * auth kind not allowed on the surface, disallowed method,
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
    const beforeBody = limits(declared.filter((rule) => rule.needsBody !== true));
    const afterBody = limits(declared.filter((rule) => rule.needsBody === true));
    if (route.auth.kind === 'user') {
      const grouped = route.auth.group === true;
      middleware.push(
        guardAuthentication(authenticate!, rateLimitOptions!),
        ...limits([rateLimitOptions!.apiRule]),
        ...beforeBody,
        ...(route.auth.allowWithPendingPasswordChange === true ? [] : [refusePendingPasswordChange]),
        ...(grouped ? [requireGroupAccess(groupAccess!.groups)] : []),
        requirePermission(route.auth.anyPermission ?? route.auth.permission!, grouped ? reportCrossGroupAccess(groupAccess!.onCrossGroupAccess) : undefined),
        ...(route.auth.feature === undefined ? [] : [requireFeature(route.auth.feature)]),
      );
    } else {
      middleware.push(...beforeBody);
    }
    if (BODY_METHODS.has(route.method)) {
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
