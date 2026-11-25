import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { CreateContactBody, PatchContactBody, PointsAdjustmentBody } from '../contacts/contacts.schemas.ts';
import type { AdjustmentBody, CreateCardBody, MovementsQuery, PatchCardBody } from '../fidelity-cards/fidelity-cards.schemas.ts';
import type { StoreOperator } from '../product-catalog/caller.ts';
import type { StoreCardsQuery, StoreContactGroupsQuery, StoreContactsQuery } from './store-contacts.schemas.ts';
import type { StoreContactsService } from './store-contacts.service.ts';

/** HTTP handlers of the contacts, groups of contacts and loyalty cards routes of the server of a point of sale. */
export interface StoreContactsController {
  listContacts: RequestHandler;
  getContact: RequestHandler;
  createContact: RequestHandler;
  updateContact: RequestHandler;
  trashContact: RequestHandler;
  adjustContactPoints: RequestHandler;
  listContactGroups: RequestHandler;
  listCards: RequestHandler;
  getCard: RequestHandler;
  createCard: RequestHandler;
  updateCard: RequestHandler;
  adjustCard: RequestHandler;
  listMovements: RequestHandler;
}

const contactIdOf = (res: Response): ObjectId => inputOf<{ contactId: ObjectId }>(res, 'params').contactId;
const cardIdOf = (res: Response): ObjectId => inputOf<{ cardId: ObjectId }>(res, 'params').cardId;
/** The operator the `operator` check of a write route verified (the builder guarantees it ran). */
const operatorOf = (res: Response): StoreOperator => res.locals.storeOperator!;

/** The entity in the `{ data }` envelope with the `ETag` of its version. */
function sendEntry(res: Response, result: { readonly entity: object; readonly version: string }, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link StoreContactsService} calls. Every response that carries a contact or a card has its `ETag`, which is the `If-Match` of the next write; the principal of the store, the group access and the
 * operator come from the locals set by the route builder, never from the request.
 *
 * @param service The contacts service of the store.
 */
export function createStoreContactsController(service: StoreContactsService): StoreContactsController {
  return {
    listContacts: async (req, res) => {
      const { items, page } = await service.listContacts(res.locals.store!, res.locals.groupAccess!, inputOf<StoreContactsQuery>(res, 'query'), clientContextOf(req, res));
      sendPage(res, items, page);
    },
    getContact: async (req, res) => {
      sendEntry(res, await service.getContact(res.locals.store!, res.locals.groupAccess!, contactIdOf(res), clientContextOf(req, res)));
    },
    createContact: async (req, res) => {
      const created = await service.createContact(res.locals.store!, operatorOf(res), res.locals.groupAccess!, inputOf<CreateContactBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendEntry(res, created, 201);
    },
    updateContact: async (req, res) => {
      sendEntry(res, await service.updateContact(res.locals.store!, operatorOf(res), res.locals.groupAccess!, contactIdOf(res), res.locals.ifMatch!, inputOf<PatchContactBody>(res, 'body'), clientContextOf(req, res)));
    },
    trashContact: async (req, res) => {
      sendEntry(res, await service.trashContact(res.locals.store!, operatorOf(res), res.locals.groupAccess!, contactIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    adjustContactPoints: async (req, res) => {
      const { code } = inputOf<{ code: string }>(res, 'params');
      sendData(res, await service.adjustContactPoints(res.locals.store!, operatorOf(res), res.locals.groupAccess!, contactIdOf(res), code, inputOf<PointsAdjustmentBody>(res, 'body'), clientContextOf(req, res)));
    },
    listContactGroups: async (_req, res) => {
      const { items, page } = await service.listContactGroups(res.locals.store!, res.locals.groupAccess!, inputOf<StoreContactGroupsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    listCards: async (_req, res) => {
      const { items, page } = await service.listCards(res.locals.store!, res.locals.groupAccess!, inputOf<StoreCardsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getCard: async (_req, res) => {
      sendEntry(res, await service.getCard(res.locals.store!, res.locals.groupAccess!, cardIdOf(res)));
    },
    createCard: async (req, res) => {
      const created = await service.createCard(res.locals.store!, operatorOf(res), res.locals.groupAccess!, inputOf<CreateCardBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendEntry(res, created, 201);
    },
    updateCard: async (req, res) => {
      sendEntry(res, await service.updateCard(res.locals.store!, operatorOf(res), res.locals.groupAccess!, cardIdOf(res), res.locals.ifMatch!, inputOf<PatchCardBody>(res, 'body'), clientContextOf(req, res)));
    },
    adjustCard: async (req, res) => {
      sendEntry(res, await service.adjustCard(res.locals.store!, operatorOf(res), res.locals.groupAccess!, cardIdOf(res), inputOf<AdjustmentBody>(res, 'body'), clientContextOf(req, res)));
    },
    listMovements: async (_req, res) => {
      const { items, page } = await service.listMovements(res.locals.store!, res.locals.groupAccess!, cardIdOf(res), inputOf<MovementsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
  };
}
