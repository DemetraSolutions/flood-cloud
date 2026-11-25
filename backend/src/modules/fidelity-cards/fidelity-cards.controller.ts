import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { AdjustmentBody, CardsQuery, CreateCardBody, MovementsQuery, PatchCardBody } from './fidelity-cards.schemas.ts';
import type { CardResult, CardsService } from './fidelity-cards.service.ts';

/** HTTP handlers of the routes of the advanced cards. */
export interface CardsController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  adjust: RequestHandler;
  movements: RequestHandler;
  remove: RequestHandler;
}

const cardIdOf = (res: Response): ObjectId => inputOf<{ cardId: ObjectId }>(res, 'params').cardId;

/** The card in the `{ data }` envelope with the `ETag` of its version. */
function sendCard(res: Response, result: CardResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link CardsService} calls. Every response that carries a card has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service of the cards.
 */
export function createCardsController(service: CardsService): CardsController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<CardsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendCard(res, await service.get(res.locals.auth!, res.locals.groupAccess!, cardIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<CreateCardBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendCard(res, created, 201);
    },
    update: async (req, res) => {
      sendCard(res, await service.update(res.locals.auth!, res.locals.groupAccess!, cardIdOf(res), res.locals.ifMatch!, inputOf<PatchCardBody>(res, 'body'), clientContextOf(req, res)));
    },
    adjust: async (req, res) => {
      sendCard(res, await service.adjust(res.locals.auth!, res.locals.groupAccess!, cardIdOf(res), inputOf<AdjustmentBody>(res, 'body'), clientContextOf(req, res)));
    },
    movements: async (_req, res) => {
      const { items, page } = await service.movements(res.locals.auth!, res.locals.groupAccess!, cardIdOf(res), inputOf<MovementsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, cardIdOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
