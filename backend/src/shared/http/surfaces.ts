/**
 * Mount paths of the HTTP surfaces of the application: the single source of the prefixes that
 * `createApp` mounts.
 *
 * The public exposure on GKE is declared separately, in `backend/k8s/httproute.yaml`, which must
 * list exactly the prefixes of {@link API_PREFIXES} (and never {@link HEALTH_PREFIX}): a unit test
 * compares the two, so a new surface cannot be mounted without being exposed, or exposed without
 * being mounted.
 * @module
 */

/**
 * Prefixes of the API surfaces reachable from the internet through the load balancer:
 * the backoffice surface (also used by the server of a point of sale) and the public API.
 */
export const API_PREFIXES = Object.freeze({
  /** Backoffice surface, `/v1`. */
  backoffice: '/v1',
  /** Public API of the groups, `/public/v1`. */
  public: '/public/v1',
} as const);

/**
 * Prefix of the liveness and readiness probes. Internal only: the orchestrator and the load
 * balancer health check reach the pods directly, and the public route must never expose it.
 */
export const HEALTH_PREFIX = '/health';
