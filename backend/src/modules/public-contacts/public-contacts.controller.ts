import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { PublicEntry } from '../public-catalog/public-catalog.service.ts';
import type { PublicContactsService } from './public-contacts.service.ts';
import type { PublicContactGroupsQuery, PublicContactsQuery, PublicCreateContactBody, PublicPatchContactBody } from './public-contacts.schemas.ts';

/** HTTP handlers of the contact routes of the public API. */
export interface PublicContactsController {
  listContacts: RequestHandler;
  getContact: RequestHandler;
  createContact: RequestHandler;
  updateContact: RequestHandler;
  trashContact: RequestHandler;
  restoreContact: RequestHandler;
  listContactGroups: RequestHandler;
  getContactGroup: RequestHandler;
}

const paramOf = (res: Response, name: string): ObjectId => inputOf<Record<string, ObjectId>>(res, 'params')[name]!;

/** The entry in the `{ data }` envelope with the `ETag` of its version. */
function sendEntry(res: Response, result: PublicEntry<object>, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link PublicContactsService} calls. Every response that carries a contact or a group of contacts has its `ETag`, which is the `If-Match` of the next write of a contact; the key and the group access
 * come from the locals set by the authentication and the route builder, never from the request.
 *
 * @param service The contacts service of the public API.
 */
export function createPublicContactsController(service: PublicContactsService): PublicContactsController {
  const key = (res: Response) => res.locals.apiKey!;
  const access = (res: Response) => res.locals.groupAccess!;
  return {
    listContacts: async (_req, res) => {
      const { items, page } = await service.listContacts(key(res), access(res), inputOf<PublicContactsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getContact: async (_req, res) => sendEntry(res, await service.getContact(key(res), access(res), paramOf(res, 'contactId'))),
    createContact: async (req, res) => {
      const created = await service.createContact(key(res), access(res), inputOf<PublicCreateContactBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${(created.entity as { id: string }).id}`);
      sendEntry(res, created, 201);
    },
    updateContact: async (req, res) => sendEntry(res, await service.updateContact(key(res), access(res), paramOf(res, 'contactId'), res.locals.ifMatch!, inputOf<PublicPatchContactBody>(res, 'body'), clientContextOf(req, res))),
    trashContact: async (req, res) => sendEntry(res, await service.trashContact(key(res), access(res), paramOf(res, 'contactId'), res.locals.ifMatch!, clientContextOf(req, res))),
    restoreContact: async (req, res) => sendEntry(res, await service.restoreContact(key(res), access(res), paramOf(res, 'contactId'), res.locals.ifMatch!, clientContextOf(req, res))),
    listContactGroups: async (_req, res) => {
      const { items, page } = await service.listContactGroups(key(res), access(res), inputOf<PublicContactGroupsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getContactGroup: async (_req, res) => sendEntry(res, await service.getContactGroup(key(res), access(res), paramOf(res, 'contactGroupId'))),
  };
}
