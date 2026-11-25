import { AppError } from '../../shared/http/errors.ts';
import type { PlaceIntegrationsPort, TshCategory } from '../../shared/integrations/ports.ts';
import { targetOf } from '../place-call.ts';
import type { CallRequest, CallSpec, ProviderCalls } from '../provider-call.ts';
import type { TshClient } from './tsh-client.ts';

/** The call, as the activity log and the errors know it. */
export const TSH_SYNC_CALL: CallSpec = Object.freeze({ action: 'integrations.tshCategoriesSynced', category: 'data', provider: 'TSH', credentialField: 'integrations.tsh.secret' });

/** What a synchronization gives back: the categories now stored and the new version of the place. */
export interface TshSyncResult {
  readonly categories: TshCategory[];
  /** The new version of the place (without quotes). */
  readonly version: string;
}

/** The synchronization of the categories of charge of TS Hospitality of a place. */
export interface TshService {
  /**
   * Downloads the categories of charge of the property of a place, with the credentials the place has stored (the browser never sends any), checks them and stores the copy the place keeps
   * (`integrations.tsh.tshCategories`), only if the place is still at `ifMatch`. A list the place cannot store is a `502` and nothing is written.
   *
   * @param request The caller and the place.
   * @param ifMatch The version of the place the caller read (without quotes).
   * @returns The categories and the new version.
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `PRECONDITION_FAILED`, `VALIDATION_ERROR` (TS Hospitality off for the place, a credential or the property missing or in a wrong form, or `integrations.tsh.secret` refused by the provider), `SERVICE_UNAVAILABLE` (the platform has no hosts, or none for the test environment of a place in test mode), `PROVIDER_ERROR`.
   */
  sync(request: CallRequest, ifMatch: string): Promise<TshSyncResult>;
}

/** Dependencies of {@link createTshService}. */
export interface TshDeps {
  readonly tsh: TshClient;
  readonly places: Pick<PlaceIntegrationsPort, 'tshCredentials' | 'saveTshCategories'>;
  readonly calls: ProviderCalls;
}

/**
 * Builds the TS Hospitality service.
 *
 * @param deps The client, the place port and the runner of calls.
 */
export function createTshService(deps: TshDeps): TshService {
  const { tsh, places, calls } = deps;
  return {
    sync: (request, ifMatch) =>
      calls.run(TSH_SYNC_CALL, request, async (probe) => {
        if (!tsh.available) {
          throw new AppError('SERVICE_UNAVAILABLE');
        }
        const target = targetOf(request);
        const credentials = await places.tshCredentials(target);
        probe.testMode = credentials.testMode;
        if (credentials.testMode && !tsh.testAvailable) {
          throw new AppError('SERVICE_UNAVAILABLE');
        }
        const categories = await tsh.listChargeCategories(credentials);
        probe.count = categories.length;
        const { etag } = await places.saveTshCategories(target, ifMatch, categories);
        return { categories, version: etag };
      }),
  };
}
