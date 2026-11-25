import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { flagsOf } from '../../shared/security/rbac/permission-matrix.ts';
import type { StoreContextService } from '../store-context/store-context.service.ts';
import type { OperatorAudit, OperatorRejection } from './store-catalog.audit.ts';

/** The header that names who stands at the till of the store on a write: the id of the user, 24 hexadecimal characters. */
export const OPERATOR_HEADER = 'X-Operator-Id';

const OPERATOR_ID = /^[0-9a-fA-F]{24}$/;

/** Collaborators of {@link createRequireOperator}. */
export interface RequireOperatorDeps {
  /** The reader of the users of the place of a store, the same set the store receives from `GET /store-context/users`. */
  readonly context: Pick<StoreContextService, 'findUser'>;
  readonly audit: OperatorAudit;
}

/**
 * Builds the check of the operator of a write of the server of a point of sale (the `operator` of a `store` route, which the builder runs after the group access and before the body is read). The operator
 * is **declared** by the store in `X-Operator-Id` and **verified** here: he must be a user of the very set the store reads (an `E` or `PA` of the place, the `CA` of its company, an `SA` of the group; never a
 * PSA, a dealer, a trashed user or one of another group), active, and hold the write flag of the module the route is about in his own stored matrix (`permissions.<module>.w`: `products` for the catalog, `contacts` for the contacts and the loyalty cards). Every failure is the same `403
 * OPERATOR_NOT_ALLOWED`, so the response tells nothing about the users of the group; the reason goes to the activity log (`store.operatorRejected`, throttled). The operator is not authenticated (the cloud
 * has no secret of his): he grants nothing the store key cannot do, he only has to exist and be allowed, and he is what the activity log records next to the store.
 *
 * @param deps The reader of the users of the place and the audit.
 * @param module The module of the legacy permission matrix whose write flag the operator must hold (`products` by default).
 * @returns The handler; on success it sets `res.locals.storeOperator`.
 */
export function createRequireOperator(deps: RequireOperatorDeps, module: 'products' | 'contacts' = 'products'): RequestHandler {
  return async (req, res, next) => {
    const store = res.locals.store!;
    const refuse = async (reason: OperatorRejection, declared: ObjectId | null): Promise<never> => {
      await deps.audit.rejected(store, clientContextOf(req, res), reason, declared);
      throw new AppError('OPERATOR_NOT_ALLOWED');
    };
    const raw = req.get(OPERATOR_HEADER);
    if (raw === undefined) {
      return refuse('missing', null);
    }
    if (!OPERATOR_ID.test(raw)) {
      return refuse('malformed', null);
    }
    const id = ObjectId.createFromHexString(raw.toLowerCase());
    const user = await deps.context.findUser(store, res.locals.groupAccess!, id);
    if (user === null) {
      return refuse('notFound', id);
    }
    if (user.status !== 'active') {
      return refuse('disabled', id);
    }
    if (!flagsOf(user.permissions, module).w) {
      return refuse('noPermission', id);
    }
    res.locals.storeOperator = Object.freeze({ id, language: user.language });
    next();
  };
}
