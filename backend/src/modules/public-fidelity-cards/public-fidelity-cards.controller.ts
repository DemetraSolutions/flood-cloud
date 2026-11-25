import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { AdjustmentBody, CreateCardBody, MovementsQuery, PatchCardBody } from '../fidelity-cards/fidelity-cards.schemas.ts';
import type { PublicCard } from './public-fidelity-cards.mapper.ts';
import type { PublicEntry } from '../public-catalog/public-catalog.service.ts';
import type { PublicFidelityCardsService } from './public-fidelity-cards.service.ts';
import type { PublicCardsQuery } from './public-fidelity-cards.schemas.ts';

/** HTTP handlers of the advanced card routes of the public API. */
export interface PublicFidelityCardsController {
  listCards: RequestHandler;
  getCard: RequestHandler;
  createCard: RequestHandler;
  updateCard: RequestHandler;
  adjustCard: RequestHandler;
  listMovements: RequestHandler;
}

const cardIdOf = (res: Response): ObjectId => inputOf<{ cardId: ObjectId }>(res, 'params').cardId;

/** The card in the `{ data }` envelope with the `ETag` of its version. */
function sendCard(res: Response, result: PublicEntry<PublicCard>, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link PublicFidelityCardsService} calls. Every response that carries a card has its `ETag`, which is the `If-Match` of the next modification; the key and the group access come from the locals set by the
 * authentication and the route builder, never from the request.
 *
 * @param service The advanced cards service of the public API.
 */
export function createPublicFidelityCardsController(service: PublicFidelityCardsService): PublicFidelityCardsController {
  const key = (res: Response) => res.locals.apiKey!;
  const access = (res: Response) => res.locals.groupAccess!;
  return {
    listCards: async (_req, res) => {
      const { items, page } = await service.listCards(key(res), access(res), inputOf<PublicCardsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getCard: async (_req, res) => sendCard(res, await service.getCard(key(res), access(res), cardIdOf(res))),
    createCard: async (req, res) => {
      const created = await service.createCard(key(res), access(res), inputOf<CreateCardBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendCard(res, created, 201);
    },
    updateCard: async (req, res) => sendCard(res, await service.updateCard(key(res), access(res), cardIdOf(res), res.locals.ifMatch!, inputOf<PatchCardBody>(res, 'body'), clientContextOf(req, res))),
    adjustCard: async (req, res) => sendCard(res, await service.adjustCard(key(res), access(res), cardIdOf(res), inputOf<AdjustmentBody>(res, 'body'), clientContextOf(req, res))),
    listMovements: async (_req, res) => {
      const { items, page } = await service.listMovements(key(res), access(res), cardIdOf(res), inputOf<MovementsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
  };
}
