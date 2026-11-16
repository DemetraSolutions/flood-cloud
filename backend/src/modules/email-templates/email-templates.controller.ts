import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { CreateTemplateBody, PatchTemplateBody, TemplatesQuery } from './email-templates.schemas.ts';
import type { EmailTemplatesService, TemplateResult } from './email-templates.service.ts';

/** HTTP handlers of the e-mail template routes. */
export interface EmailTemplatesController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

const templateIdOf = (res: Response): ObjectId => inputOf<{ templateId: ObjectId }>(res, 'params').templateId;

/** The template in the `{ data }` envelope (always JSON, whatever its HTML) with the `ETag` of its version. */
function sendTemplate(res: Response, result: TemplateResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.template, status);
}

/**
 * Translates HTTP into {@link EmailTemplatesService} calls. Every response that carries a template has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service.
 */
export function createEmailTemplatesController(service: EmailTemplatesService): EmailTemplatesController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<TemplatesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendTemplate(res, await service.get(res.locals.auth!, res.locals.groupAccess!, templateIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<CreateTemplateBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.template.id}`);
      sendTemplate(res, created, 201);
    },
    update: async (req, res) => {
      sendTemplate(res, await service.update(res.locals.auth!, res.locals.groupAccess!, templateIdOf(res), res.locals.ifMatch!, inputOf<PatchTemplateBody>(res, 'body'), clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, templateIdOf(res), clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
