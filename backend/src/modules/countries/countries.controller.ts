import type { RequestHandler, Response } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { AreaParams, CountryParams, CreateCodedBody, RenameBody } from './countries.schemas.ts';
import type { CountriesService, CountryResult } from './countries.service.ts';

/** HTTP handlers of the country routes. */
export interface CountriesController {
  get: RequestHandler;
  create: RequestHandler;
  rename: RequestHandler;
  remove: RequestHandler;
  addArea: RequestHandler;
  renameArea: RequestHandler;
  removeArea: RequestHandler;
}

/** The country in the `{ data }` envelope with the `ETag` of its version. */
function sendCountry(res: Response, result: CountryResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.country, status);
}

const countryOf = (res: Response): string => inputOf<CountryParams>(res, 'params').countryCode;
const areaOf = (res: Response): AreaParams => inputOf<AreaParams>(res, 'params');

/**
 * Translates HTTP into {@link CountriesService} calls. Every response that carries a country has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service.
 */
export function createCountriesController(service: CountriesService): CountriesController {
  return {
    get: async (_req, res) => {
      sendCountry(res, await service.get(countryOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, inputOf<CreateCodedBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.country.code}`);
      sendCountry(res, created, 201);
    },
    rename: async (req, res) => {
      sendCountry(res, await service.rename(res.locals.auth!, countryOf(res), res.locals.ifMatch!, inputOf<RenameBody>(res, 'body'), clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, countryOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
    addArea: async (req, res) => {
      const body = inputOf<CreateCodedBody>(res, 'body');
      const created = await service.addArea(res.locals.auth!, countryOf(res), res.locals.ifMatch!, body, clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${body.code}`);
      sendCountry(res, created, 201);
    },
    renameArea: async (req, res) => {
      const { countryCode, areaCode } = areaOf(res);
      sendCountry(res, await service.renameArea(res.locals.auth!, countryCode, areaCode, res.locals.ifMatch!, inputOf<RenameBody>(res, 'body'), clientContextOf(req, res)));
    },
    removeArea: async (req, res) => {
      const { countryCode, areaCode } = areaOf(res);
      sendCountry(res, await service.removeArea(res.locals.auth!, countryCode, areaCode, res.locals.ifMatch!, clientContextOf(req, res)));
    },
  };
}
