import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { TrashCount } from '../../shared/security/scope/group-counts.ts';

/** What a group holds, by kind: the elements in use and the ones in the trash (read from the common database). */
export interface GroupCounts {
  readonly companies: TrashCount;
  readonly places: TrashCount;
  readonly users: TrashCount;
}

/** A group as the reference list shows it. */
export interface GroupReference {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly trashed: boolean;
  /** Id of the dealer's `D` user, `null` when the group has none (or the stored value is not an id). */
  readonly dealerId: string | null;
  readonly demo: boolean;
  /** Counts of companies, places and users of the group (the list of groups only). */
  readonly counts: GroupCounts;
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
export const GROUP_PROJECTION = Object.freeze({ name: 1, status: 1, trash: 1, dealerId: 1, demo: 1 } as const);

/** Projection of the place list: the only stored fields ever read. */
export const PLACE_PROJECTION = Object.freeze({ name: 1, trash: 1, companyId: 1 } as const);

/**
 * Maps a stored group to its reference representation, field by field (allowlist): `status` is
 * `active` only when the stored value is `true`, `demo` is on only when `true`, `dealerId` is the id of the dealer or `null`.
 *
 * @param document The projected group document.
 * @param counts The counts of the group, already read from the common database.
 */
export function toGroupReference(document: Document, counts: GroupCounts): GroupReference {
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: nameOf(document),
    status: document['status'] === true ? 'active' : 'suspended',
    trashed: document['trash'] === true,
    dealerId: document['dealerId'] instanceof ObjectId ? document['dealerId'].toHexString() : null,
    demo: document['demo'] === true,
    counts,
  };
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

/** A country of the reference list: its ISO code, its name and the areas (provinces) it lists. */
export interface CountryReference {
  readonly code: string;
  readonly name: string;
  readonly areas: ReadonlyArray<{ readonly code: string; readonly name: string }>;
}

/** The fields of a country the list reads. */
export const COUNTRY_PROJECTION = Object.freeze({ code: 1, name: 1, areas: 1 } as const);

/**
 * Maps a document of `common.countries` to the reference country, tolerant of the legacy shapes: a country without a usable code is left out (`null`), a name that is missing is the
 * code, `areas` that is not a list (`'none'`, `null`) is `[]`, and an area without a code is left out (its name falls back to the code).
 *
 * @param document The stored country.
 * @returns The country, or `null` when it has no usable code.
 */
export function toCountryReference(document: Document): CountryReference | null {
  const code: unknown = document['code'];
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) {
    return null;
  }
  const areas: unknown = document['areas'];
  const name: unknown = document['name'];
  return {
    code: code.toUpperCase(),
    name: typeof name === 'string' && name !== '' ? name : code.toUpperCase(),
    areas: (Array.isArray(areas) ? areas : []).flatMap((area: unknown) => {
      const { code: areaCode, name: areaName } = (typeof area === 'object' && area !== null ? area : {}) as { code?: unknown; name?: unknown };
      return typeof areaCode === 'string' && areaCode !== '' ? [{ code: areaCode, name: typeof areaName === 'string' && areaName !== '' ? areaName : areaCode }] : [];
    }),
  };
}
