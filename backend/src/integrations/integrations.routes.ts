import { sendData } from '../shared/http/envelope.ts';
import { defineRoute } from '../shared/http/routes.ts';
import type { RouteDefinition } from '../shared/http/routes.ts';

/** Which providers the platform is configured for: booleans from the configuration, never a host, a key or a version. */
export interface IntegrationsStatus {
  /** The company lookup by VAT number on Cerved (`CERVED_API_KEY` is set). */
  readonly cerved: boolean;
  /** The list of the terminals of Dojo (`DOJO_RESELLER_ID` and `DOJO_SOFTWARE_HOUSE_ID` are set). */
  readonly dojo: boolean;
  /** The activation of Satispay (`SATISPAY_AUTH_BASE_URL` and `SATISPAY_PUBLIC_KEY` are set). */
  readonly satispay: boolean;
  /** The synchronization of the categories of TS Hospitality (`TSH_AUTH_BASE_URL` and `TSH_API_BASE_URL` are set). */
  readonly tsh: boolean;
  /** The coordinates of an address (`GOOGLE_MAPS_API_KEY` is set). */
  readonly geocoding: boolean;
}

/**
 * `GET /v1/integrations`: which providers are available, so the backoffice shows only the buttons that can work. It reads the configuration only and calls nobody. Reserved to who
 * uses an integration (the readers of a place, who create customers), on a `user` token: a store key and an API key never reach it.
 *
 * @param status The availability of the providers, computed once at start-up.
 * @returns The route definitions to mount on `/v1`.
 */
export function createIntegrationsStatusRoutes(status: IntegrationsStatus): RouteDefinition[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/integrations',
      auth: { kind: 'user', anyPermission: ['places:read', 'groups:create'] },
      handler: (_req, res) => {
        sendData(res, status);
      },
    }),
  ];
}
