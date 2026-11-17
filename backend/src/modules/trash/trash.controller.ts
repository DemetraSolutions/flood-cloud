import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { EmptyBody, IdsBody, TrashParams } from './trash.schemas.ts';
import type { TrashService } from './trash.service.ts';

/** HTTP handlers of the trash routes. */
export interface TrashController {
  restore: RequestHandler;
  remove: RequestHandler;
  empty: RequestHandler;
  restoreGroups: RequestHandler;
}

/**
 * Translates HTTP into {@link TrashService} calls: the group comes from the verified access, the kind and the ids from the validated input, the caller from the authentication.
 *
 * @param service The service.
 */
export function createTrashController(service: TrashService): TrashController {
  const kindOf = (res: Parameters<RequestHandler>[1]) => inputOf<TrashParams>(res, 'params').kind;
  return {
    restore: async (req, res) => {
      sendData(res, await service.restore(res.locals.auth!, res.locals.groupAccess!, kindOf(res), inputOf<IdsBody>(res, 'body').ids, clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      sendData(res, await service.remove(res.locals.auth!, res.locals.groupAccess!, kindOf(res), inputOf<IdsBody>(res, 'body').ids, clientContextOf(req, res)));
    },
    empty: async (req, res) => {
      sendData(res, await service.empty(res.locals.auth!, res.locals.groupAccess!, kindOf(res), inputOf<EmptyBody>(res, 'body').after ?? null, clientContextOf(req, res)));
    },
    restoreGroups: async (req, res) => {
      sendData(res, await service.restoreGroups(res.locals.auth!, inputOf<IdsBody>(res, 'body').ids, res.locals.groupAccesses!, clientContextOf(req, res)));
    },
  };
}
