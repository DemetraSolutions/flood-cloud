import type { Request, Response } from 'express';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateBody, validateQuery } from '../../shared/validation/middleware.ts';
import type { TobaccoSyncController } from './tobacco-sync.controller.ts';
import { syncBody, syncQuery } from './tobacco-sync.schemas.ts';

/** The segment of the synchronization under `/groups/{groupId}`. */
export const TOBACCO_SYNC_SEGMENT = 'tobacco-sync';

/** Synchronizations per user per hour; a dry run runs the same transaction and aborts it, so it has its own, larger bucket. */
export const SYNCS_PER_USER_HOUR = 6;
export const DRY_RUNS_PER_USER_HOUR = 20;

const hourly = (bucket: string, limit: number, applies: (req: Request) => boolean): RateLimitRule =>
  Object.freeze({ bucket, limit, windowSeconds: 3600, key: (req: Request, res: Response) => (applies(req) ? res.locals.auth!.userId.toHexString() : null) });
const isDryRun = (req: Request): boolean => req.query['dryRun'] === 'true';

/**
 * The routes of the synchronization of the national tobacco price list (`doc/Tasks.md` step C7), on `/v1` and on every group, with the permission `tobaccos:sync` (PSA, dealers and group administrators with
 * `products.w`). The state is a `GET`; the synchronization is a `POST`, idempotent (`Idempotency-Key`: the key covers the body and `dryRun`) and limited per hour for the user. Not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createTobaccoSyncRoutes(controller: TobaccoSyncController, idempotency: IdempotencyStore): RouteDefinition[] {
  const auth = { kind: 'user' as const, permission: 'tobaccos:sync' as const, group: true as const };
  const path = `/groups/:groupId/${TOBACCO_SYNC_SEGMENT}`;
  return [
    defineRoute({ method: 'GET', path, auth, handler: controller.status }),
    defineRoute({
      method: 'POST',
      path,
      auth,
      rateLimit: [hourly('tobacco-sync:user', SYNCS_PER_USER_HOUR, (req) => !isDryRun(req)), hourly('tobacco-sync-dry-run:user', DRY_RUNS_PER_USER_HOUR, isDryRun)],
      middleware: [
        validateQuery(syncQuery),
        validateBody(syncBody),
        (req, _res, next) => {
          // The idempotency key covers the body and the mode: a dry run and the real synchronization are not the same request.
          req.body = { ...(req.body as object), dryRun: req.query['dryRun'] === 'true' };
          next();
        },
      ],
      handler: idempotent(idempotency, controller.sync),
    }),
  ];
}
