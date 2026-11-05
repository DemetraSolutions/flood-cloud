import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { AllUsersQuery, CreateGroupUserBody, CreatePlatformUserBody, GroupUsersQuery, PatchGroupUserBody, PatchPlatformUserBody, ResetPasswordBody } from './users.schemas.ts';
import type { UserArea, UsersService } from './users.service.ts';

/** HTTP handlers of the user management routes; the same handlers serve the group and the platform routes. */
export interface UsersController {
  listGroup: RequestHandler;
  listAll: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  resetPassword: RequestHandler;
  trash: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
  usernameAvailability: RequestHandler;
}

/** The area of the request: the verified group of the path, or the platform when the route has no group. */
function areaOf(res: Response): UserArea {
  const access = res.locals.groupAccess;
  return access === undefined ? { kind: 'platform' } : { kind: 'group', access };
}

const userIdOf = (res: Response): ObjectId => inputOf<{ userId: ObjectId }>(res, 'params').userId;

/**
 * Translates HTTP into {@link UsersService} calls.
 *
 * @param service The service.
 */
export function createUsersController(service: UsersService): UsersController {
  return {
    listGroup: async (_req, res) => {
      const { items, page } = await service.listGroup(res.locals.auth!, res.locals.groupAccess!, inputOf<GroupUsersQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    listAll: async (_req, res) => {
      const { items, page } = await service.listAll(res.locals.auth!, inputOf<AllUsersQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendData(res, await service.get(res.locals.auth!, areaOf(res), userIdOf(res)));
    },
    create: async (req, res) => {
      const area = areaOf(res);
      const created = await service.create(res.locals.auth!, area, inputOf<CreateGroupUserBody | CreatePlatformUserBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.id}`);
      sendData(res, created, 201);
    },
    update: async (req, res) => {
      sendData(res, await service.update(res.locals.auth!, areaOf(res), userIdOf(res), inputOf<PatchGroupUserBody | PatchPlatformUserBody>(res, 'body'), clientContextOf(req, res)));
    },
    resetPassword: async (req, res) => {
      await service.resetPassword(res.locals.auth!, areaOf(res), userIdOf(res), inputOf<ResetPasswordBody>(res, 'body'), clientContextOf(req, res));
      res.status(204).end();
    },
    trash: async (req, res) => {
      sendData(res, await service.trash(res.locals.auth!, areaOf(res), userIdOf(res), clientContextOf(req, res)));
    },
    restore: async (req, res) => {
      sendData(res, await service.restore(res.locals.auth!, areaOf(res), userIdOf(res), clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, areaOf(res), userIdOf(res), clientContextOf(req, res));
      res.status(204).end();
    },
    usernameAvailability: async (_req, res) => {
      sendData(res, { available: await service.isUsernameAvailable(inputOf<{ username: string }>(res, 'params').username) });
    },
  };
}
