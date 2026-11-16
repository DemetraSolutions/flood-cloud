import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody } from '../../shared/validation/middleware.ts';
import type { OnboardingController } from './onboarding.controller.ts';
import { ONBOARDING_BODY_LIMIT, createGroupBody } from './onboarding.schemas.ts';

/**
 * The creation of a new customer (`POST /v1/groups`, area 8): for a PSA and a dealer (permission `groups:create`). The creation is idempotent, so a retry never makes a second group: it needs the
 * `Idempotency-Key` header (`shared/http/idempotency.ts`). It hashes the password of the administrator with scrypt, so it counts on the same per-user limit as the other creations of users.
 *
 * @param controller Handler.
 * @param idempotency The record of the idempotency keys.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createOnboardingRoutes(controller: OnboardingController, idempotency: IdempotencyStore, rules: RateLimitRules): RouteDefinition[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/groups',
      auth: { kind: 'user', permission: 'groups:create' },
      bodyLimit: ONBOARDING_BODY_LIMIT,
      rateLimit: [rules.userCredentialsPerUser],
      middleware: [validateBody(createGroupBody)],
      handler: idempotent(idempotency, controller.create),
    }),
  ];
}
