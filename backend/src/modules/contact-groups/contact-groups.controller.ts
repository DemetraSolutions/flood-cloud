import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ContactGroupResult, ContactGroupsService } from './contact-groups.service.ts';
import type { ContactGroupsQuery, CreateContactGroupBody, PatchContactGroupBody } from './contact-groups.schemas.ts';

/** HTTP handlers of the routes of the groups of contacts. */
export interface ContactGroupsController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

const idOf = (res: Response): ObjectId => inputOf<{ contactGroupId: ObjectId }>(res, 'params').contactGroupId;

/** The group of contacts in the `{ data }` envelope with the `ETag` of its version. */
function sendGroup(res: Response, result: ContactGroupResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link ContactGroupsService} calls. Every response that carries a group of contacts has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service of the groups of contacts.
 */
export function createContactGroupsController(service: ContactGroupsService): ContactGroupsController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<ContactGroupsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendGroup(res, await service.get(res.locals.auth!, res.locals.groupAccess!, idOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<CreateContactGroupBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendGroup(res, created, 201);
    },
    update: async (req, res) => {
      sendGroup(res, await service.update(res.locals.auth!, res.locals.groupAccess!, idOf(res), res.locals.ifMatch!, inputOf<PatchContactGroupBody>(res, 'body'), clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, idOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
