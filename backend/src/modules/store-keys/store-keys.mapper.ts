import type { Installation, KeyIssuer, PendingActivation, RevokedSummary, StoreKey } from './store-keys.types.ts';
import type { StoreKeyStatus } from './store-keys.service.ts';

/** The prefix of a store key, shown with its hint. */
const KEY_PREFIX = 'fc_sk_';

/** Who made a code or a key, as the backoffice sees him: the id and the role. */
function issuer(value: KeyIssuer): { readonly id: string; readonly role: string } {
  return { id: value.userId.toHexString(), role: value.role };
}

/** What the app declared when it activated, all of it optional text. */
function installation(value: Installation): Installation {
  return { userAgent: value.userAgent, appVersion: value.appVersion, platform: value.platform };
}

/** The active key as the backoffice sees it: the hint to recognize it, never the key, never its hash. */
function toKey(key: StoreKey) {
  return {
    id: key.id.toHexString(),
    hint: `${KEY_PREFIX}${key.hint}…`,
    activatedAt: key.activatedAt.toISOString(),
    activatedBy: issuer(key.activatedBy),
    installation: installation(key.installation),
    lastSeenAt: key.lastSeenAt.toISOString(),
    lastSeenIp: key.lastSeenIp,
  };
}

function toPending(pending: PendingActivation) {
  return { createdAt: pending.createdAt.toISOString(), expiresAt: pending.expiresAt.toISOString(), createdBy: issuer(pending.createdBy) };
}

function toRevoked(revoked: RevokedSummary) {
  return { revokedAt: revoked.revokedAt.toISOString(), reason: revoked.reason };
}

/**
 * The representation of the key of a place (`GET …/store-key`), field by field: nothing of the stored document goes out that is not named here.
 *
 * @param status The key, the pending code and the last revocation.
 */
export function toStoreKeyStatus(status: StoreKeyStatus) {
  return {
    status: status.status,
    key: status.key === null ? null : toKey(status.key),
    pendingActivation: status.pendingActivation === null ? null : toPending(status.pendingActivation),
    lastRevoked: status.lastRevoked === null ? null : toRevoked(status.lastRevoked),
  };
}
