import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';

/** The two forms of an e-invoicing hub: `aruba` and `aruba__<24 hexadecimal characters of the id of a dealer>`. */
export const HUB = /^aruba(?:__([0-9a-f]{24}))?$/;

/** The hub every company may use. */
export const ARUBA_HUB = 'aruba';

/**
 * The allowlist of the hub a role may choose (`doc/API.md`, "Hub"): only a PSA or a dealer chooses one at all; a PSA any of the allowed forms, a dealer none, `aruba` or `aruba__<his own id>` (the hub of
 * another dealer is refused). It looks only at the form and the role: whether the dealer of `aruba__<id>` exists is checked by the caller.
 *
 * @param principal The authenticated caller.
 * @param hub A hub value.
 * @returns Whether the caller may set it.
 */
export function mayChooseHub(principal: Pick<AuthPrincipal, 'role' | 'userId'>, hub: string): boolean {
  if (principal.role !== 'PSA' && principal.role !== 'D') {
    return false;
  }
  const dealerId = HUB.exec(hub)?.[1];
  return !(principal.role === 'D' && dealerId !== undefined && dealerId !== principal.userId.toHexString());
}
