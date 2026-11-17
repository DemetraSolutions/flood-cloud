import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { toApiKeyResponse } from './api-keys.mapper.ts';
import type { ApiKeysQuery, CreateApiKeyBody, PatchApiKeyBody, UsageQuery } from './api-keys.schemas.ts';
import type { ApiKeysService } from './api-keys.service.ts';

/** HTTP handlers of the public API key routes. */
export interface ApiKeysController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  revoke: RequestHandler;
  usage: RequestHandler;
}

const keyIdOf = (res: Response): ObjectId => inputOf<{ keyId: ObjectId }>(res, 'params').keyId;

/**
 * Translates HTTP into {@link ApiKeysService} calls. The response that carries the secret (the creation) is marked `no-store` here and never compressed by its route (`compress: false`): the
 * secret is in no other response and in no log.
 *
 * @param service The service.
 */
export function createApiKeysController(service: ApiKeysService): ApiKeysController {
  return {
    list: async (_req, res) => {
      const { keys, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<ApiKeysQuery>(res, 'query'));
      sendPage(res, keys.map(toApiKeyResponse), page);
    },
    get: async (_req, res) => {
      sendData(res, toApiKeyResponse(await service.get(res.locals.auth!, res.locals.groupAccess!, keyIdOf(res))));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<CreateApiKeyBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.key.id.toHexString()}`);
      sendData(res, { ...toApiKeyResponse(created.key), secret: created.secret }, 201);
    },
    update: async (req, res) => {
      sendData(res, toApiKeyResponse(await service.update(res.locals.auth!, res.locals.groupAccess!, keyIdOf(res), inputOf<PatchApiKeyBody>(res, 'body'), clientContextOf(req, res))));
    },
    revoke: async (req, res) => {
      sendData(res, toApiKeyResponse(await service.revoke(res.locals.auth!, res.locals.groupAccess!, keyIdOf(res), clientContextOf(req, res))));
    },
    usage: async (_req, res) => {
      const usage = await service.usage(res.locals.auth!, res.locals.groupAccess!, keyIdOf(res), inputOf<UsageQuery>(res, 'query'));
      sendData(res, {
        keyId: usage.keyId.toHexString(),
        from: usage.from,
        to: usage.to,
        totals: { ...usage.totals },
        rows: usage.rows.map((row) => ({ day: row.day, route: row.route, calls: row.calls, errors4xx: row.errors4xx, errors5xx: row.errors5xx, rateLimited: row.rateLimited, aborted: row.aborted })),
      });
    },
  };
}
