import type { RequestHandler } from 'express';
import { object, optional, string, validate } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { objectId } from '../../shared/validation/schema.ts';

/** Body limit of the exchange: a code and two short texts. */
export const ACTIVATION_BODY_LIMIT = '2kb';

/** What an app may say about itself: letters, digits and the few signs a version or a platform name has. */
const declared = () => optional(string({ min: 1, max: 64, trim: true, pattern: /^[A-Za-z0-9._+\- ]+$/ }));

/**
 * Body of `POST /v1/store-activations`: the activation code as typed (its format is checked, and a malformed one is a `401`, by the service: a `422` would tell a guess apart from a wrong code),
 * and what the app declares about itself.
 */
export const activationBody = object({
  activationCode: string({ max: 64 }),
  installation: optional(object({ appVersion: declared(), platform: declared() })),
});

/** Validated body of the exchange. */
export type ActivationBody = Infer<typeof activationBody>;

/** Path parameters of the routes on the key of one place; the group was already verified by the route. */
export const placeKeyParams = object({ placeId: objectId() }, { allowUnknown: true });

const emptyBody = object({});

/**
 * The body of the creation of an activation code is empty: no body, or `{}`; any property is `422`. Runs as a route middleware, so it also covers the request that sends no body at all.
 */
export const requireNoBodyContent: RequestHandler = (req, _res, next) => {
  validate(emptyBody, req.body ?? {}, '(body)');
  next();
};
