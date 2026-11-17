import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { listPipeline, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { trustedGroupMirror } from '../../shared/security/scope/group-mirror.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';
import { PUBLIC_COMPANY_PROJECTION, PUBLIC_PLACE_PROJECTION } from './public.mapper.ts';
import { PUBLIC_NAME_LIST } from './public.list.ts';

/** What the public API reads from the copies of the places and the companies of a group, inside the group and the restrictions of the key. */
export interface PublicRepository {
  /**
   * A page of the places of the key's group that are not in the trash, inside its restrictions (the companies it is limited to, the places it is limited to; both when both are set).
   *
   * @param principal The authenticated key.
   * @param params List parameters.
   */
  listPlaces(principal: ApiKeyPrincipal, params: ListParams): Promise<ListPage>;
  /**
   * One place of the key's group.
   *
   * @param principal The authenticated key.
   * @param placeId Id of the place.
   * @returns The copy (projected on the public allowlist), or `null` when the place does not exist, is in the trash, belongs to another group or is outside the restrictions: one and the same answer.
   */
  findPlace(principal: ApiKeyPrincipal, placeId: ObjectId): Promise<Document | null>;
  /**
   * A page of the companies of the key's group that are not in the trash, inside its restrictions: a company is visible when it is one the key is limited to (if it is) and one of the companies of the places the key is limited to (if it is).
   *
   * @param principal The authenticated key.
   * @param params List parameters.
   */
  listCompanies(principal: ApiKeyPrincipal, params: ListParams): Promise<ListPage>;
  /**
   * One company of the key's group.
   *
   * @param principal The authenticated key.
   * @param companyId Id of the company.
   * @returns The copy (projected on the public allowlist), or `null` when it does not exist, is in the trash, belongs to another group or is outside the restrictions.
   */
  findCompany(principal: ApiKeyPrincipal, companyId: ObjectId): Promise<Document | null>;
}

/** The condition of the places the restrictions of a key allow. */
function placeRestrictions(principal: ApiKeyPrincipal): Filter<Document> {
  const { companyIds, placeIds } = principal.restrictions;
  return {
    trash: { $ne: true },
    ...(companyIds === null ? {} : { companyId: { $in: [...companyIds] } }),
    ...(placeIds === null ? {} : { _id: { $in: [...placeIds] } }),
  };
}

/**
 * Builds the public repository over the copies in the common database, read through `group-mirror.ts` (the group of the key is the one the authentication verified, never a parameter of the client): every read names
 * its fields, all of them from the central allowlist, and takes no filter from the client.
 *
 * @param databases Database accessor.
 */
export function createPublicRepository(databases: Databases): PublicRepository {
  const places = (principal: ApiKeyPrincipal) => trustedGroupMirror(principal.groupId, databases, 'places');
  const companies = (principal: ApiKeyPrincipal) => trustedGroupMirror(principal.groupId, databases, 'companies');

  /** The condition of the companies the restrictions allow: the ones named, narrowed to the companies of the places named. */
  const companyRestrictions = async (principal: ApiKeyPrincipal): Promise<Filter<Document>> => {
    const { companyIds, placeIds } = principal.restrictions;
    let allowed: ObjectId[] | null = companyIds === null ? null : [...companyIds];
    if (placeIds !== null) {
      const found = await places(principal).find({ _id: { $in: [...placeIds] }, trash: { $ne: true } }, { projection: { companyId: 1 }, limit: placeIds.length });
      const viaPlaces = found.flatMap((place) => (place['companyId'] instanceof ObjectId ? [place['companyId']] : []));
      const named = allowed;
      allowed = named === null ? viaPlaces : viaPlaces.filter((id) => named.some((candidate) => candidate.equals(id)));
    }
    return { trash: { $ne: true }, ...(allowed === null ? {} : { _id: { $in: allowed } }) };
  };

  return {
    listPlaces: async (principal, params) =>
      pageOf(await places(principal).aggregate(listPipeline(placeRestrictions(principal), params, PUBLIC_NAME_LIST, PUBLIC_PLACE_PROJECTION)), params),

    findPlace: async (principal, placeId) => {
      const [place] = await places(principal).find({ $and: [{ _id: placeId }, placeRestrictions(principal)] }, { projection: PUBLIC_PLACE_PROJECTION, limit: 1 });
      return place ?? null;
    },

    listCompanies: async (principal, params) =>
      pageOf(await companies(principal).aggregate(listPipeline(await companyRestrictions(principal), params, PUBLIC_NAME_LIST, PUBLIC_COMPANY_PROJECTION)), params),

    findCompany: async (principal, companyId) => {
      const [company] = await companies(principal).find({ $and: [{ _id: companyId }, await companyRestrictions(principal)] }, { projection: PUBLIC_COMPANY_PROJECTION, limit: 1 });
      return company ?? null;
    },
  };
}
