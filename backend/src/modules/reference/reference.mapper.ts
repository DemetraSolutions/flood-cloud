import type { Document, ObjectId } from 'mongodb';

/** A group as the reference list shows it. */
export interface GroupReference {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly trashed: boolean;
}

/** A company as the reference list shows it. */
export interface CompanyReference {
  readonly id: string;
  readonly name: string;
  readonly trashed: boolean;
}

/** A place as the reference list shows it. */
export interface PlaceReference {
  readonly id: string;
  readonly name: string;
  /** Id of the company, `null` when the stored place has none. */
  readonly companyId: string | null;
  readonly trashed: boolean;
}

/** A missing or non-string name is read as the empty string (tolerant read of legacy data). */
const nameOf = (document: Document): string => (typeof document['name'] === 'string' ? document['name'] : '');

/** Projection of the group list: the only stored fields ever read. */
export const GROUP_PROJECTION = Object.freeze({ name: 1, status: 1, trash: 1 } as const);

/** Projection of the company list: the only stored fields ever read. */
export const COMPANY_PROJECTION = Object.freeze({ name: 1, trash: 1 } as const);

/** Projection of the place list: the only stored fields ever read. */
export const PLACE_PROJECTION = Object.freeze({ name: 1, trash: 1, companyId: 1 } as const);

/**
 * Maps a stored group to its reference representation, field by field (allowlist): `status` is
 * `active` only when the stored value is `true`.
 *
 * @param document The projected group document.
 */
export function toGroupReference(document: Document): GroupReference {
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: nameOf(document),
    status: document['status'] === true ? 'active' : 'suspended',
    trashed: document['trash'] === true,
  };
}

/**
 * Maps a stored company to its reference representation.
 *
 * @param document The projected company document.
 */
export function toCompanyReference(document: Document): CompanyReference {
  return { id: (document['_id'] as ObjectId).toHexString(), name: nameOf(document), trashed: document['trash'] === true };
}

/**
 * Maps a stored place to its reference representation.
 *
 * @param document The projected place document.
 */
export function toPlaceReference(document: Document): PlaceReference {
  const companyId: unknown = document['companyId'];
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: nameOf(document),
    companyId: typeof companyId === 'object' && companyId !== null && 'toHexString' in companyId ? (companyId as ObjectId).toHexString() : null,
    trashed: document['trash'] === true,
  };
}
