import type { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { trustedGroupMirror } from '../../shared/security/scope/group-mirror.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';
import type { ApiKeyCaller } from '../product-catalog/caller.ts';

/** Most places the restrictions of one key may resolve to: a key limited to companies with more places sees the first ones (the perimeter only ever narrows). */
export const MAX_KEY_PLACES = 500;

/** Builds the caller the services of the catalog see for a public API key. */
export interface ApiKeyCallers {
  /**
   * The caller of a verified key, from its group and its restrictions alone. A key without restrictions is the group's (the scope `group`, as a group administrator); a key limited to companies and/or places has the
   * scope `places` with the places of the group, not in the trash, that are in both lists (the places of the companies named, narrowed to the places named when both are set), as a place administrator of them.
   *
   * @param principal The verified key.
   * @throws {AppError} `NOT_FOUND` when the restrictions of the key match no place of the group that is not in the trash: such a key reaches nothing of the catalog.
   */
  callerOf(principal: ApiKeyPrincipal): Promise<ApiKeyCaller>;
}

/**
 * Builds the factory of the callers of the public API keys. The places are read from the copies in the common database through `group-mirror.ts`, inside the group of the key, naming only the identifier.
 *
 * @param databases Database accessor.
 */
export function createApiKeyCallers(databases: Databases): ApiKeyCallers {
  return {
    callerOf: async (principal) => {
      const { companyIds, placeIds } = principal.restrictions;
      const identity = { kind: 'apiKey' as const, keyId: principal.keyId, prefix: principal.prefix };
      if (companyIds === null && placeIds === null) {
        return Object.freeze({ ...identity, scope: Object.freeze({ kind: 'group' as const, groupId: principal.groupId }) });
      }
      const found = await trustedGroupMirror(principal.groupId, databases, 'places').find(
        { trash: { $ne: true }, ...(companyIds === null ? {} : { companyId: { $in: [...companyIds] } }), ...(placeIds === null ? {} : { _id: { $in: [...placeIds] } }) },
        { projection: { _id: 1 }, sort: { _id: 1 }, limit: MAX_KEY_PLACES },
      );
      if (found.length === 0) {
        throw new AppError('NOT_FOUND');
      }
      return Object.freeze({ ...identity, scope: Object.freeze({ kind: 'places' as const, groupId: principal.groupId, placeIds: Object.freeze(found.map((place) => place['_id'] as ObjectId)) }) });
    },
  };
}
