import { AppError } from '../../shared/http/errors.ts';
import type { PlaceIntegrationsPort } from '../../shared/integrations/ports.ts';
import { targetOf } from '../place-call.ts';
import type { CallRequest, CallSpec, ProviderCalls } from '../provider-call.ts';
import type { DojoClient, DojoTerminal } from './dojo-client.ts';

/** The call, as the activity log and the errors know it. */
export const DOJO_TERMINALS_CALL: CallSpec = Object.freeze({ action: 'integrations.dojoTerminalsListed', category: 'data', provider: 'Dojo', credentialField: 'integrations.dojo.apiKey' });

/** The terminals of Dojo of a place. */
export interface DojoService {
  /**
   * Lists the terminals of the Dojo account of a place, with the key the place has stored (the browser never sends one). The list is shown, never saved.
   *
   * @param request The caller and the place.
   * @returns The terminals (`id`, `tid`, `status`).
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` (Dojo off for the place, no key, or a key Dojo refused: `integrations.dojo.apiKey`), `SERVICE_UNAVAILABLE` (the platform has no Dojo configuration), `PROVIDER_ERROR`.
   */
  listTerminals(request: CallRequest): Promise<DojoTerminal[]>;
}

/** Dependencies of {@link createDojoService}. */
export interface DojoDeps {
  readonly dojo: DojoClient;
  readonly places: Pick<PlaceIntegrationsPort, 'dojoCredentials'>;
  readonly calls: ProviderCalls;
}

/**
 * Builds the Dojo service.
 *
 * @param deps The client, the place port and the runner of calls.
 */
export function createDojoService(deps: DojoDeps): DojoService {
  const { dojo, places, calls } = deps;
  return {
    listTerminals: (request) =>
      calls.run(DOJO_TERMINALS_CALL, request, async (probe) => {
        if (!dojo.available) {
          throw new AppError('SERVICE_UNAVAILABLE');
        }
        const { apiKey } = await places.dojoCredentials(targetOf(request));
        const terminals = await dojo.listTerminals(apiKey);
        probe.count = terminals.length;
        return terminals;
      }),
  };
}
