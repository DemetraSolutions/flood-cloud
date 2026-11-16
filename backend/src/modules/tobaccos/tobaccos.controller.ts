import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { sendRevalidatedPage } from '../../shared/http/etag.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { TobaccosQuery } from './tobaccos.schemas.ts';
import type { TobaccosService } from './tobaccos.service.ts';

/** HTTP handlers of the price list routes. */
export interface TobaccosController {
  list: RequestHandler;
  importList: RequestHandler;
}

/**
 * Translates HTTP into {@link TobaccosService} calls. The list is revalidated with its `ETag`; the import answers `200` with the counts (it replaces a list, it does not create a resource).
 *
 * @param service The service.
 */
export function createTobaccosController(service: TobaccosService): TobaccosController {
  return {
    list: async (req, res) => {
      const { items, page } = await service.list(inputOf<TobaccosQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    importList: async (req, res) => {
      // The route ran `acceptWorkbook`: there is a file.
      sendData(res, await service.importList(res.locals.auth!, req.file!.buffer, clientContextOf(req, res)));
    },
  };
}
