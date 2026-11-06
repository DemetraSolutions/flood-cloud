import type { RequestHandler } from 'express';
import type { Feature } from '../../../modules/groups/features.ts';
import { AppError } from '../../http/errors.ts';

/**
 * Builds the middleware that refuses a request when the group of the path does not have a feature
 * turned on (D-13). It runs after the group check and the permission check, and applies to every role:
 * a PSA or a dealer working inside a group meets a module that group does not have like anybody else.
 *
 * @param feature The feature the route belongs to.
 * @returns A handler answering `403 FEATURE_DISABLED` when the feature is off in the group; it needs the
 * verified group access of the route (the route builder mounts it only on `group: true` routes).
 */
export function requireFeature(feature: Feature): RequestHandler {
  return (_req, res, next) => {
    if (res.locals.groupAccess!.features[feature] !== true) {
      throw new AppError('FEATURE_DISABLED');
    }
    next();
  };
}
