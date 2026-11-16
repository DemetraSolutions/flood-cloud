import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { CreateGroupBody } from './onboarding.schemas.ts';
import type { OnboardingService } from './onboarding.service.ts';

/** HTTP handler of the creation of a customer. */
export interface OnboardingController {
  create: RequestHandler;
}

/**
 * Translates HTTP into {@link OnboardingService} calls: `201`, `Location` of the group and the ids of what was created.
 *
 * @param service The service.
 */
export function createOnboardingController(service: OnboardingService): OnboardingController {
  return {
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, inputOf<CreateGroupBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.groupId}`);
      sendData(res, created, 201);
    },
  };
}
