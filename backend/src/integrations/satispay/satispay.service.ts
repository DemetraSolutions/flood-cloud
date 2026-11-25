import { AppError } from '../../shared/http/errors.ts';
import type { PlaceIntegrationsPort } from '../../shared/integrations/ports.ts';
import { targetOf } from '../place-call.ts';
import type { CallRequest, CallSpec, ProviderCalls } from '../provider-call.ts';
import type { SatispayClient } from './satispay-client.ts';

/** The call, as the activity log and the errors know it: a security event (the code is single use and the key it opens pays the place). */
export const SATISPAY_ACTIVATION_CALL: CallSpec = Object.freeze({ action: 'integrations.satispayActivated', category: 'security', provider: 'Satispay', credentialField: 'activationCode', refusedStatuses: Object.freeze([403, 404]) });

/** The activation of Satispay for a place. */
export interface SatispayService {
  /**
   * Activates a place on Satispay: the core checks the caller, the place, the role (a PSA or a dealer only, the rule of the payment keys), the switch and the version before anything leaves, then the code is
   * exchanged for the key id of the place and only the key id is stored (the code is never kept). The answer carries the new version when the place had not changed meanwhile, and never the key id.
   *
   * If the key id cannot be stored after the provider accepted the code, the code is consumed and a new one is needed: the failure is recorded as a security event and the error is the one of the failure.
   *
   * @param request The caller and the place.
   * @param ifMatch The version of the place the caller read (without quotes).
   * @param activationCode The code, checked and in capitals.
   * @returns The new version, or `null` when the place had changed.
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `PRECONDITION_FAILED`, `VALIDATION_ERROR` (Satispay off for the place, or `activationCode` refused by the provider), `SERVICE_UNAVAILABLE`, `PROVIDER_ERROR`.
   */
  activate(request: CallRequest, ifMatch: string, activationCode: string): Promise<string | null>;
}

/** Dependencies of {@link createSatispayService}. */
export interface SatispayDeps {
  readonly satispay: SatispayClient;
  readonly places: Pick<PlaceIntegrationsPort, 'checkSatispayActivation' | 'saveSatispayKeyId'>;
  readonly calls: ProviderCalls;
}

/**
 * Builds the Satispay service.
 *
 * @param deps The client, the place port and the runner of calls.
 */
export function createSatispayService(deps: SatispayDeps): SatispayService {
  const { satispay, places, calls } = deps;
  return {
    activate: (request, ifMatch, activationCode) =>
      calls.run(SATISPAY_ACTIVATION_CALL, request, async (probe) => {
        if (!satispay.available) {
          throw new AppError('SERVICE_UNAVAILABLE');
        }
        const target = targetOf(request);
        await places.checkSatispayActivation(target, ifMatch);
        const keyId = await satispay.activate(activationCode);
        try {
          return (await places.saveSatispayKeyId(target, ifMatch, keyId)).etag;
        } catch (error) {
          probe.outcome = 'saveFailed';
          throw error;
        }
      }),
  };
}
