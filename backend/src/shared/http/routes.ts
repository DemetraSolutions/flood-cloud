import express from 'express';
import type { RequestHandler, Router } from 'express';
import { AppError } from './errors.ts';

/** HTTP methods a route may declare. */
export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** An HTTP method accepted by the route builder. */
export type RouteMethod = (typeof ROUTE_METHODS)[number];

/**
 * Authentication declared by a route. No route is anonymous by omission: it must
 * say so explicitly and give the reason. Further kinds arrive with the auth steps.
 */
export interface AnonymousAuth {
  readonly kind: 'anonymous';
  /** Why the route is reachable without credentials; must not be empty. */
  readonly reason: string;
}

/** Authentication requirement of a route. */
export type RouteAuth = AnonymousAuth;

/** Declarative description of a route. */
export interface RouteDefinition {
  readonly method: RouteMethod;
  /** Path relative to the router it is mounted on. */
  readonly path: string;
  readonly auth: RouteAuth;
  /** JSON body size limit (body-parser syntax, for example `'1mb'`); defaults to {@link DEFAULT_BODY_LIMIT}. */
  readonly bodyLimit?: string | number;
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
function validateRoutes(routes: readonly RouteDefinition[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const label = `${String(route.method)} ${String(route.path)}`;
    if (!(ROUTE_METHODS as readonly unknown[]).includes(route.method)) {
      problems.push(`${label}: method not allowed`);
    }
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      problems.push(`${label}: path must be a string starting with "/"`);
    }
    const auth = route.auth as { kind?: unknown; reason?: unknown } | undefined;
    if (auth === undefined || auth === null) {
      problems.push(`${label}: missing auth declaration`);
    } else if (auth.kind !== 'anonymous') {
      problems.push(`${label}: unknown auth kind`);
    } else if (typeof auth.reason !== 'string' || auth.reason.trim() === '') {
      problems.push(`${label}: anonymous route needs a non-empty reason`);
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

/**
 * Mounts validated routes on a router. For every path it registers the declared
 * methods (with a per-route JSON parser and a 415 guard on POST/PUT/PATCH) plus a
 * catch-all answering 405 with the `Allow` header. `GET` implies `HEAD`.
 *
 * @param router Target router.
 * @param routes Route declarations.
 * @throws {Error} At startup, listing every invalid route (missing or unknown auth,
 * empty reason, disallowed method, bad path, duplicate method and path).
 */
export function mountRoutes(router: Router, routes: readonly RouteDefinition[]): void {
  const problems = validateRoutes(routes);
  if (problems.length > 0) {
    throw new Error(`Invalid route definitions:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }

  const groups = new Map<string, { path: string; methods: Set<RouteMethod> }>();
  for (const route of routes) {
    const key = normalizePath(route.path);
    const group = groups.get(key) ?? { path: route.path, methods: new Set<RouteMethod>() };
    group.methods.add(route.method);
    groups.set(key, group);

    const middleware: RequestHandler[] = [];
    if (BODY_METHODS.has(route.method)) {
      middleware.push(
        requireJsonContentType,
        express.json({ limit: route.bodyLimit ?? DEFAULT_BODY_LIMIT, strict: true, inflate: false, type: 'application/json' }),
      );
    }
    middleware.push(route.handler);
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
