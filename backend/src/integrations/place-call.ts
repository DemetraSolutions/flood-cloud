import type { Request, Response } from 'express';
import { clientContextOf } from '../shared/http/client-context.ts';
import type { PlaceIntegrationTarget } from '../shared/integrations/ports.ts';
import type { RateLimitRule } from '../shared/security/rate-limit/rate-limit.ts';
import { inputOf } from '../shared/validation/middleware.ts';
import { object, string } from '../shared/validation/schema.ts';
import type { Infer } from '../shared/validation/schema.ts';
import type { CallRequest } from './provider-call.ts';

/** Path parameters of the routes on one place: the id as the port takes it (24 lower case hexadecimal characters). The group was already verified by the route. */
export const placeCallParams = object({ placeId: string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ }) }, { allowUnknown: true });

/** Validated path parameters of a call on a place. */
export type PlaceCallParams = Infer<typeof placeCallParams>;

/**
 * Who calls and on which place, from a request of a route that is on a group and validated with {@link placeCallParams}. The group is the one the route verified; the port verifies it again.
 *
 * @param req The request.
 * @param res The response, whose locals hold the principal and the verified group.
 * @returns The target for the port and the context of the log.
 */
export function callRequestOf(req: Request, res: Response): CallRequest {
  const placeId = inputOf<PlaceCallParams>(res, 'params').placeId;
  return { principal: res.locals.auth!, groupId: String(req.params['groupId']), placeId, group: res.locals.groupAccess!.groupId, context: clientContextOf(req, res) };
}

/**
 * What the port takes of a call: the caller, the group of the path and the place, and nothing else.
 *
 * @param request The call.
 */
export function targetOf(request: CallRequest): PlaceIntegrationTarget {
  return { principal: request.principal, groupId: request.groupId, placeId: request.placeId };
}

/**
 * A rate limit rule on the calls of one user to a route, in a window of the given length.
 *
 * @param bucket The name of the counter family.
 * @param limit Calls allowed in the window.
 * @param windowSeconds Length of the window in seconds, one minute when absent.
 */
export function perUserRule(bucket: string, limit: number, windowSeconds?: number): RateLimitRule {
  return Object.freeze({ bucket, limit, ...(windowSeconds === undefined ? {} : { windowSeconds }), key: (_req: Request, res: Response) => res.locals.auth!.userId.toHexString() });
}
