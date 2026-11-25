import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { IdsBody } from '../trash/trash.schemas.ts';
import type { ContactResult, ContactsService } from './contacts.service.ts';
import type { ContactsQuery, CreateContactBody, PatchContactBody, PointsAdjustmentBody } from './contacts.schemas.ts';

/** HTTP handlers of the contact routes. */
export interface ContactsController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  trash: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
  trashMany: RequestHandler;
  adjustPoints: RequestHandler;
}

const contactIdOf = (res: Response): ObjectId => inputOf<{ contactId: ObjectId }>(res, 'params').contactId;

/** The contact in the `{ data }` envelope with the `ETag` of its version. */
function sendContact(res: Response, result: ContactResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link ContactsService} calls. Every response that carries a contact has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service of the contacts.
 */
export function createContactsController(service: ContactsService): ContactsController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<ContactsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendContact(res, await service.get(res.locals.auth!, res.locals.groupAccess!, contactIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<CreateContactBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendContact(res, created, 201);
    },
    update: async (req, res) => {
      sendContact(res, await service.update(res.locals.auth!, res.locals.groupAccess!, contactIdOf(res), res.locals.ifMatch!, inputOf<PatchContactBody>(res, 'body'), clientContextOf(req, res)));
    },
    trash: async (req, res) => {
      sendContact(res, await service.trash(res.locals.auth!, res.locals.groupAccess!, contactIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    restore: async (req, res) => {
      sendContact(res, await service.restore(res.locals.auth!, res.locals.groupAccess!, contactIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, contactIdOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
    trashMany: async (req, res) => {
      sendData(res, await service.trashMany(res.locals.auth!, res.locals.groupAccess!, inputOf<IdsBody>(res, 'body').ids, clientContextOf(req, res)));
    },
    adjustPoints: async (req, res) => {
      const { code } = inputOf<{ code: string }>(res, 'params');
      sendData(res, await service.adjustPoints(res.locals.auth!, res.locals.groupAccess!, contactIdOf(res), code, inputOf<PointsAdjustmentBody>(res, 'body'), clientContextOf(req, res)));
    },
  };
}
