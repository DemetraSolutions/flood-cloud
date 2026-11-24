import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { SyncBody, SyncQuery } from './tobacco-sync.schemas.ts';
import { MASS_DISABLE_PERCENT } from './tobacco-sync.plan.ts';
import { MassDisableRefusal } from './tobacco-sync.service.ts';
import type { TobaccoSyncService } from './tobacco-sync.service.ts';

/** HTTP handlers of the tobacco synchronization routes. */
export interface TobaccoSyncController {
  status: RequestHandler;
  sync: RequestHandler;
}

/**
 * Translates HTTP into {@link TobaccoSyncService} calls. The synchronization answers `200` with the counts (it changes many resources, it does not create one).
 *
 * @param service The service.
 */
export function createTobaccoSyncController(service: TobaccoSyncService): TobaccoSyncController {
  return {
    status: async (_req, res) => {
      sendData(res, await service.status(res.locals.auth!, res.locals.groupAccess!));
    },
    sync: async (req, res) => {
      try {
        sendData(res, await service.sync(res.locals.auth!, res.locals.groupAccess!, inputOf<SyncBody>(res, 'body'), inputOf<SyncQuery>(res, 'query').dryRun ?? false, clientContextOf(req, res)));
      } catch (error) {
        if (!(error instanceof MassDisableRefusal)) {
          throw error;
        }
        // The envelope of every `409` extended with the numbers: how many tobaccos would be disabled and how many the group has enabled.
        res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: 'The synchronization would disable more than 20% of the enabled tobaccos: nothing was written, send confirmMassDisable to go on',
            details: [{ field: 'group', issue: 'massDisable' }],
            disabled: error.disabled,
            active: error.active,
            thresholdPercent: MASS_DISABLE_PERCENT,
          },
        });
      }
    },
  };
}
