import type { RequestHandler } from 'express';
import { sendData } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { callRequestOf } from '../place-call.ts';
import type { GeocodingBody } from './geocoding.schemas.ts';
import type { GeocodingService } from './geocoding.service.ts';

/** HTTP handlers of the geocoding route. */
export interface GeocodingController {
  geocode: RequestHandler;
}

/**
 * Translates HTTP into {@link GeocodingService} calls. The answer is the point (`lat`, `lng`) and nothing else.
 *
 * @param service The service.
 */
export function createGeocodingController(service: GeocodingService): GeocodingController {
  return {
    geocode: async (req, res) => {
      const { lat, lng } = await service.geocode(callRequestOf(req, res), inputOf<GeocodingBody>(res, 'body'));
      sendData(res, { lat, lng });
    },
  };
}
