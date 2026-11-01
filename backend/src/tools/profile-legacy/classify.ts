import { ObjectId } from 'mongodb';

/** Legacy AES-256-CBC format of encrypted personal data: `<ciphertext hex>$<iv hex, 32 chars>`. */
export const ENCRYPTED_LEGACY = /^([0-9a-f]{32})+\$[0-9a-f]{32}$/;

/** Legacy password hash: HMAC-SHA512 as 128 lowercase hex characters. */
export const HMAC_SHA512_HEX = /^[0-9a-f]{128}$/;

const PIN_FORMAT = /^[0-9]{4,8}$/;
const HEX24_LOWER = /^[0-9a-f]{24}$/i;

/** How a personal-data value is stored. */
export type PiiKind = 'encryptedLegacy' | 'plain' | 'empty' | 'missingOrNull' | 'otherType';

/** Histogram of {@link PiiKind}. */
export type PiiCounts = Record<PiiKind, number>;

/**
 * Classifies a personal-data value without looking at its content.
 *
 * @param value The stored value.
 * @returns How it is stored.
 */
export function classifyPii(value: unknown): PiiKind {
  if (value === undefined || value === null) {
    return 'missingOrNull';
  }
  if (typeof value !== 'string') {
    return 'otherType';
  }
  if (value.trim() === '') {
    return 'empty';
  }
  return ENCRYPTED_LEGACY.test(value) ? 'encryptedLegacy' : 'plain';
}

/** @returns A zeroed {@link PiiCounts}. */
export function emptyPiiCounts(): PiiCounts {
  return { encryptedLegacy: 0, plain: 0, empty: 0, missingOrNull: 0, otherType: 0 };
}

/** Length bands used for values that are not in the expected format. */
export type LengthBand = '0' | '1-7' | '8-16' | '17-64' | '65+' | 'nonString';

/**
 * Puts the length of a string into a band.
 *
 * @param length Number of characters.
 * @returns The band.
 */
export function lengthBand(length: number): Exclude<LengthBand, 'nonString'> {
  if (length === 0) {
    return '0';
  }
  if (length <= 7) {
    return '1-7';
  }
  if (length <= 16) {
    return '8-16';
  }
  return length <= 64 ? '17-64' : '65+';
}

/** Histogram of password formats. */
export interface PasswordProfile {
  hmacSha512Hex: number;
  missingOrNull: number;
  other: number;
  /** Length bands of the `other` values. */
  otherLengths: Record<LengthBand, number>;
}

/** @returns A zeroed {@link PasswordProfile}. */
export function emptyPasswordProfile(): PasswordProfile {
  return {
    hmacSha512Hex: 0,
    missingOrNull: 0,
    other: 0,
    otherLengths: { '0': 0, '1-7': 0, '8-16': 0, '17-64': 0, '65+': 0, nonString: 0 },
  };
}

/**
 * Adds a stored password to the profile. The value is classified and then forgotten.
 *
 * @param profile Profile to feed.
 * @param value The stored value.
 */
export function tallyPassword(profile: PasswordProfile, value: unknown): void {
  if (value === undefined || value === null) {
    profile.missingOrNull += 1;
  } else if (typeof value === 'string' && HMAC_SHA512_HEX.test(value)) {
    profile.hmacSha512Hex += 1;
  } else {
    profile.other += 1;
    const band = typeof value === 'string' ? lengthBand(value.length) : 'nonString';
    profile.otherLengths[band] += 1;
  }
}

/** Histogram of PIN formats. */
export interface PinProfile {
  missingOrNull: number;
  /** A string of 4 to 8 digits. */
  numeric4to8: number;
  other: number;
}

/** @returns A zeroed {@link PinProfile}. */
export function emptyPinProfile(): PinProfile {
  return { missingOrNull: 0, numeric4to8: 0, other: 0 };
}

/**
 * Adds a stored PIN to the profile. The value is classified and then forgotten.
 *
 * @param profile Profile to feed.
 * @param value The stored value.
 */
export function tallyPin(profile: PinProfile, value: unknown): void {
  if (value === undefined || value === null) {
    profile.missingOrNull += 1;
  } else if (typeof value === 'string' && PIN_FORMAT.test(value)) {
    profile.numeric4to8 += 1;
  } else {
    profile.other += 1;
  }
}

/** How a reference to another document is stored. */
export type RefKind = 'objectId' | 'hexString' | 'otherString' | 'null' | 'missing' | 'otherType';

/** A classified reference; `hex` is set when it designates a document (`objectId` or `hexString`). */
export interface ClassifiedRef {
  kind: RefKind;
  hex: string | null;
}

/**
 * Classifies a reference field.
 *
 * @param value The stored value.
 * @returns The kind and, when it is an id, its lowercase hex form.
 */
export function classifyRef(value: unknown): ClassifiedRef {
  if (value === undefined) {
    return { kind: 'missing', hex: null };
  }
  if (value === null) {
    return { kind: 'null', hex: null };
  }
  if (value instanceof ObjectId) {
    return { kind: 'objectId', hex: value.toHexString() };
  }
  if (typeof value === 'string') {
    return HEX24_LOWER.test(value) ? { kind: 'hexString', hex: value.toLowerCase() } : { kind: 'otherString', hex: null };
  }
  return { kind: 'otherType', hex: null };
}

/** Histogram of the kinds of a reference field. */
export type RefKinds = Record<RefKind, number>;

/** Histogram of the kinds of a reference field, with the outcome of the existence check. */
export interface RefProfile {
  kinds: RefKinds;
  /** References to a document that does not exist. */
  orphans: number;
  /** References that cannot be checked because the place they live in is unknown. */
  unverifiable: number;
}

/** @returns A zeroed {@link RefKinds}. */
export function emptyRefKinds(): RefKinds {
  return { objectId: 0, hexString: 0, otherString: 0, null: 0, missing: 0, otherType: 0 };
}

/** @returns A zeroed {@link RefProfile}. */
export function emptyRefProfile(): RefProfile {
  return { kinds: emptyRefKinds(), orphans: 0, unverifiable: 0 };
}

/**
 * Adds a reference to a kind histogram, without checking that the target exists.
 *
 * @param kinds Histogram to feed.
 * @param value The stored reference.
 * @returns The classification, so callers can reuse the resolved id.
 */
export function tallyKind(kinds: RefKinds, value: unknown): ClassifiedRef {
  const ref = classifyRef(value);
  kinds[ref.kind] += 1;
  return ref;
}

/**
 * Adds a reference to a profile and checks it against the set of existing ids.
 *
 * @param profile Profile to feed.
 * @param value The stored reference.
 * @param existing Ids that exist, or `undefined` when they cannot be known (then an id reference is `unverifiable`).
 * @returns The classification, so callers can reuse the resolved id.
 */
export function tallyRef(profile: RefProfile, value: unknown, existing: ReadonlySet<string> | undefined): ClassifiedRef {
  const ref = tallyKind(profile.kinds, value);
  if (ref.hex !== null) {
    if (existing === undefined) {
      profile.unverifiable += 1;
    } else if (!existing.has(ref.hex)) {
      profile.orphans += 1;
    }
  }
  return ref;
}
