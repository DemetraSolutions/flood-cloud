import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { sendRevalidated } from '../../shared/http/etag.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { PatchGroupBody } from './groups.schemas.ts';
import type { GroupsService } from './groups.service.ts';

/** HTTP handlers of the group routes. */
export interface GroupsController {
  get: RequestHandler;
  update: RequestHandler;
  suspend: RequestHandler;
  reactivate: RequestHandler;
  trash: RequestHandler;
  restore: RequestHandler;
}

/**
 * Translates HTTP into {@link GroupsService} calls. The detail is sent with an `ETag` and revalidation; the
 * state actions answer with the group as it is afterwards, except the reactivation, a `DELETE`, which has no body.
 *
 * @param service The service.
 */
export function createGroupsController(service: GroupsService): GroupsController {
  return {
    get: async (req, res) => {
      sendRevalidated(req, res, await service.get(res.locals.auth!, res.locals.groupAccess!));
    },
    update: async (req, res) => {
      sendData(res, await service.update(res.locals.auth!, res.locals.groupAccess!, inputOf<PatchGroupBody>(res, 'body'), clientContextOf(req, res)));
    },
    suspend: async (req, res) => {
      sendData(res, await service.suspend(res.locals.auth!, res.locals.groupAccess!, clientContextOf(req, res)));
    },
    reactivate: async (req, res) => {
      await service.reactivate(res.locals.auth!, res.locals.groupAccess!, clientContextOf(req, res));
      res.status(204).end();
    },
    trash: async (req, res) => {
      sendData(res, await service.trash(res.locals.auth!, res.locals.groupAccess!, clientContextOf(req, res)));
    },
    restore: async (req, res) => {
      sendData(res, await service.restore(res.locals.auth!, res.locals.groupAccess!, clientContextOf(req, res)));
    },
  };
}
