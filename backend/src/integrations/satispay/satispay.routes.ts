import type { Request, Response } from 'express';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateBody, validateParams } from '../../shared/validation/middleware.ts';
import { perUserRule, placeCallParams } from '../place-call.ts';
import type { SatispayController } from './satispay.controller.ts';
import { activationBody, SATISPAY_BODY_LIMIT } from './satispay.schemas.ts';

/** Activations per user per hour: the code is single use, so a handful is plenty. */
export const SATISPAY_ACTIVATIONS_PER_USER_HOUR = 5;

/** Activations per place per day, whoever makes them. */
export const SATISPAY_ACTIVATIONS_PER_PLACE_DAY = 10;

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;

/** Activations per place per day: it runs after the group is verified and counts the place of the path (a value that is not the id of a place is refused by the validation and counts for nobody, and so does a caller that is neither PSA nor D). */
const perPlaceDaily: RateLimitRule = Object.freeze({
  bucket: 'integrations-satispay-day:place',
  limit: SATISPAY_ACTIVATIONS_PER_PLACE_DAY,
  windowSeconds: DAY_SECONDS,
  needsGroup: true,
  key: (req: Request, res: Response) => {
    // Only a PSA or a dealer can activate (the port refuses the others with a 403 before the provider): the others must not use up the cap of the place.
    const role = res.locals.auth?.role;
    if (role !== 'PSA' && role !== 'D') {
      return null;
    }
    const placeId = req.params['placeId'];
    return typeof placeId === 'string' && /^[0-9a-f]{24}$/.test(placeId) ? `${res.locals.groupAccess!.groupId.toHexString()}:${placeId}` : null;
  },
});

/**
 * `POST /v1/groups/{groupId}/places/{placeId}/integrations/satispay/activation`: activates a place on Satispay with the code the shop owner generated. For who can change the place (`places:update`), on a
 * user token only; the core then asks for a PSA or a dealer, as for every payment key. Idempotent (`Idempotency-Key`: a replay answers again without calling Satispay), conditional on the version of the
 * place (`If-Match`, checked before the provider is called) and limited per user per hour and per place per day.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createSatispayRoutes(controller: SatispayController, idempotency: IdempotencyStore): RouteDefinition[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/groups/:groupId/places/:placeId/integrations/satispay/activation',
      auth: { kind: 'user', permission: 'places:update', group: true },
      bodyLimit: SATISPAY_BODY_LIMIT,
      rateLimit: [perUserRule('integrations-satispay:user', SATISPAY_ACTIVATIONS_PER_USER_HOUR, HOUR_SECONDS), perPlaceDaily],
      middleware: [validateParams(placeCallParams), requireIfMatch, validateBody(activationBody)],
      handler: idempotent(idempotency, controller.activate),
    }),
  ];
}
