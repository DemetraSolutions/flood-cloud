import type { Feature } from '../groups/features.ts';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { Schema } from '../../shared/validation/schema.ts';
import { ENTRY_PARAM } from './entity.controller.ts';
import type { EntityController } from './entity.controller.ts';
import { entryParams } from './entity.schemas.ts';

/** Largest body of a write: the names and descriptions in up to twenty languages, and up to two hundred places, fit with a wide margin. */
export const ENTITY_BODY_LIMIT = '64kb';

/** What distinguishes the routes of the departments from the ones of the brands. */
export interface EntityRoutesOptions {
  /** The URL segment under `/groups/{groupId}`. */
  readonly segment: string;
  /** The feature the group must have (otherwise `403 FEATURE_DISABLED`, whatever the role). */
  readonly feature?: Feature;
  readonly query: Schema<unknown>;
  readonly create: Schema<unknown>;
  readonly patch: Schema<unknown>;
  /** Largest body of a write ({@link ENTITY_BODY_LIMIT} by default). */
  readonly bodyLimit?: string;
}

/**
 * The routes of a collection of the product catalog (the departments or the brands): reading is for whoever reads the products (`products:read`), creating, changing and deleting for whoever updates
 * them (`products:update`). A modification needs `If-Match`; the creation is idempotent (`Idempotency-Key`). The routes are not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param options Segment, feature and schemas.
 * @returns The route definitions to mount on `/v1`.
 */
export function createEntityRoutes(controller: EntityController, idempotency: IdempotencyStore, options: EntityRoutesOptions): RouteDefinition[] {
  const auth = (permission: 'products:read' | 'products:update') => ({ kind: 'user' as const, permission, group: true, ...(options.feature === undefined ? {} : { feature: options.feature }) });
  const all = `/groups/:groupId/${options.segment}`;
  const one = `${all}/:${ENTRY_PARAM}`;
  const bodyLimit = options.bodyLimit ?? ENTITY_BODY_LIMIT;
  return [
    defineRoute({ method: 'GET', path: all, auth: auth('products:read'), middleware: [validateQuery(options.query)], handler: controller.list }),
    defineRoute({ method: 'POST', path: all, auth: auth('products:update'), bodyLimit, middleware: [validateBody(options.create)], handler: idempotent(idempotency, controller.create) }),
    defineRoute({ method: 'GET', path: one, auth: auth('products:read'), middleware: [validateParams(entryParams)], handler: controller.get }),
    defineRoute({ method: 'PATCH', path: one, auth: auth('products:update'), bodyLimit, middleware: [validateParams(entryParams), requireIfMatch, validateBody(options.patch)], handler: controller.update }),
    defineRoute({ method: 'DELETE', path: one, auth: auth('products:update'), middleware: [validateParams(entryParams)], handler: controller.remove }),
  ];
}
