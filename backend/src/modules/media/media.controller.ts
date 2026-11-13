import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ImagesQuery, UploadQuery } from './media.schemas.ts';
import type { MediaService } from './media.service.ts';

/** HTTP handlers of the media routes. */
export interface MediaController {
  upload: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
}

const imageIdOf = (res: Response): ObjectId => inputOf<{ imageId: ObjectId }>(res, 'params').imageId;

/**
 * Translates HTTP into {@link MediaService} calls.
 *
 * @param service The service.
 */
export function createMediaController(service: MediaService): MediaController {
  return {
    upload: async (req, res) => {
      if (req.file === undefined) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'required' }] });
      }
      const image = await service.upload(res.locals.auth!, res.locals.groupAccess!, { buffer: req.file.buffer, originalName: req.file.originalname }, inputOf<UploadQuery>(res, 'query').companyId ?? null);
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${image.id}`);
      sendData(res, image, 201);
    },
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<ImagesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendData(res, await service.get(res.locals.auth!, res.locals.groupAccess!, imageIdOf(res)));
    },
  };
}
