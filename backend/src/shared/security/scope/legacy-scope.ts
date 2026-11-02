import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/** Scope ids of a user in the domain model (D-08). */
export interface LegacyScopeIds {
  readonly companyIds: ObjectId[];
  readonly placeIds: ObjectId[];
}

/**
 * Reads the scope ids of a legacy user document (D-08): `companyIds` from `companyId`, `placeIds`
 * as the union of `placeId` and `placesId[]`. Only real `ObjectId` values are kept (a reference
 * stored as text is a data anomaly and grants nothing), without duplicates, in order of appearance.
 *
 * @param document Legacy `users` document.
 * @returns Normalized scope ids.
 */
export function legacyScopeIds(document: Document): LegacyScopeIds {
  const unique = (candidates: readonly unknown[]): ObjectId[] => {
    const seen = new Set<string>();
    const ids: ObjectId[] = [];
    for (const candidate of candidates) {
      if (candidate instanceof ObjectId && !seen.has(candidate.toHexString())) {
        seen.add(candidate.toHexString());
        ids.push(candidate);
      }
    }
    return ids;
  };
  const places: unknown = document['placesId'];
  return {
    companyIds: unique([document['companyId']]),
    placeIds: unique([document['placeId'], ...(Array.isArray(places) ? (places as unknown[]) : [])]),
  };
}
