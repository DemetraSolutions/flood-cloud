import { Double, Int32, Long, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { canonicalJson } from '../../shared/http/etag.ts';
import { ECOMMERCE_FLAGS } from '../../shared/legacy-write/company-paths.ts';
import type { Company, CompanySummary, MediaLogo } from './company.types.ts';

/** How the value of one key of the stored document becomes a value of the domain and back. */
export interface Codec {
  /** The domain value of a stored value of any shape: tolerant, never throws. */
  read(stored: unknown): unknown;
  /** The stored value of a domain value already validated; `stored` is what the document holds now at that path (`undefined` for a new document). */
  write(value: unknown, stored: unknown): unknown;
}

/** One key of the company: where it is in the domain, where it is in the stored document, and how one becomes the other. */
export interface Leaf {
  /** Dotted path in the domain representation (`eInvoicing.rea.office`). */
  readonly domain: string;
  /** Dotted path in the stored document (`fattura_elettronica.rea_ufficio`). */
  readonly legacy: string;
  readonly codec: Codec;
  /** `true` for what a request never writes (`trashed`, the dates). */
  readonly readOnly?: true;
  /** `true` for what a request writes and a response never carries (a credential: the representation has a read-only flag at the same stored path instead). */
  readonly writeOnly?: true;
}

/** Whether a stored value is a plain object (not an array, not `null`). */
export const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A stored number: a JS number or one of the BSON numeric types the exact reads give (`Int32`, `Double`, `Long`).
 *
 * @param value Any stored value.
 * @returns The number, or `null` when the value is not a finite number.
 */
export function numberOf(value: unknown): number | null {
  const number = typeof value === 'number' ? value : value instanceof Int32 || value instanceof Double ? value.value : value instanceof Long ? value.toNumber() : null;
  return number !== null && Number.isFinite(number) ? number : null;
}

/** A string kept as it is; anything else is `null`. */
export const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
/** A non-empty string kept as it is; `''` and anything that is not a string is `null`. */
export const nonEmptyOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A string kept as it is; anything else is `null`. */
export const text: Codec = { read: stringOrNull, write: (value) => value };
/** A string the document keeps as `''` when empty (the e-invoicing keys, the fiscal code): `''` and anything else that is not text read as `null`, and `null` is written as `''`. */
const blank: Codec = { read: nonEmptyOrNull, write: (value) => value ?? '' };
/** A string the document may hold as `null` or `''` (e-mail, telephone): `''` reads as `null`, `null` is written as `null`. */
export const optionalText: Codec = { read: nonEmptyOrNull, write: (value) => value };
/** A string with `''` for none, in the domain too (the media names). */
const plainText: Codec = { read: (value) => (typeof value === 'string' ? value : ''), write: (value) => value };
/** A flag: only `true` is on. */
export const flag: Codec = { read: (value) => value === true, write: (value) => value };
/** A number, `0` when the document has none. */
const quantity: Codec = { read: (value) => numberOf(value) ?? 0, write: (value) => value };
/** A whole number or `null`. */
const wholeNumber: Codec = { read: (value) => ((n) => (n !== null && Number.isInteger(n) ? n : null))(numberOf(value)), write: (value) => value };
/** The `active` or `disabled` of a status flag. */
export const status: Codec = { read: (value) => (value === true ? 'active' : 'disabled'), write: (value) => value === 'active' };
/** A date as an ISO instant, `null` when missing or not a valid date. */
export const instant: Codec = {
  read: (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null),
  write: (value) => (value === null ? null : new Date(value as string)),
};
/** The position of the invoice series. */
const position: Codec = { read: (value) => (value === 'prefix' || value === 'suffix' ? value : null), write: (value) => value };
/** An id of the stored document, `''` is none. */
const reference: Codec = { read: nonEmptyOrNull, write: (value) => value ?? '' };

/** A list of the document read item by item: what is not an object is left out. */
export const listOf = (item: (stored: Record<string, unknown>) => unknown, write: (value: never) => unknown): Codec => ({
  read: (value) => (Array.isArray(value) ? value.filter(isPlain).map(item) : []),
  write: (value) => (value as never[]).map(write),
});

const bankAccounts = listOf(
  (bank) => ({
    id: stringOrNull(bank['id']) ?? '',
    name: stringOrNull(bank['name']) ?? '',
    iban: stringOrNull(bank['iban']) ?? '',
    abi: nonEmptyOrNull(bank['abi']),
    cab: nonEmptyOrNull(bank['cab']),
    bic: nonEmptyOrNull(bank['bic']),
    default: bank['default'] === true,
  }),
  (bank: { id: string; name: string; iban: string; abi: string | null; cab: string | null; bic: string | null; default: boolean }) => ({
    id: bank.id,
    name: bank.name,
    iban: bank.iban,
    abi: bank.abi ?? '',
    cab: bank.cab ?? '',
    bic: bank.bic ?? '',
    default: bank.default,
  }),
);

const mealVoucherIssuers = listOf(
  (issuer) => ({
    id: stringOrNull(issuer['id']) ?? '',
    name: stringOrNull(issuer['name']) ?? '',
    cuts: Array.isArray(issuer['cuts']) ? issuer['cuts'].map(numberOf) : [],
  }),
  (issuer: { id: string; name: string; cuts: Array<number | null> }) => ({ id: issuer.id, name: issuer.name, cuts: issuer.cuts }),
);

const invoiceSeries = listOf(
  (series) => ({ name: stringOrNull(series['name']) ?? '', cash: series['cash'] === true }),
  (series: { name: string; cash: boolean }) => ({ name: series.name, cash: series.cash }),
);

/**
 * The minimum order by currency: `{ <code>: { code, value } }` in the document, `{ <code>: value }` in the domain. The entries of the document that are not
 * well formed are left out of the domain; on a write every entry the document has is kept exactly as it is (other currencies, other keys of an entry),
 * and only the currencies of the domain value are set.
 */
export const minimumOrder: Codec = {
  read: (value) => {
    const amounts: Record<string, number> = {};
    for (const [code, entry] of Object.entries(isPlain(value) ? value : {})) {
      const amount = isPlain(entry) ? numberOf(entry['value']) : null;
      if (amount !== null) {
        amounts[code] = amount;
      }
    }
    return amounts;
  },
  write: (value, stored) => {
    const kept: Record<string, unknown> = isPlain(stored) ? { ...stored } : {};
    for (const [code, amount] of Object.entries(value as Record<string, number>)) {
      const entry = kept[code];
      kept[code] = { ...(isPlain(entry) ? entry : {}), code, value: amount };
    }
    return kept;
  },
};

const LOGO_KEYS = ['_id', 'basename', 'extension', 'filename', 'mimetype', 'title', 'alt', 'dirname', 'type'] as const;

/**
 * The descriptor the legacy Media Manager stores for a logo, from the domain form (built by the server from an image of the group): the eleven keys in the order and with the types of
 * the legacy: `_id` a hexadecimal string, `filename` the name of the file, `filectime` a double, `mmThumb` an empty object (a serialized DOM element in the legacy), `type` always `image`.
 */
export function legacyLogoDescriptor(logoValue: MediaLogo): Document {
  return {
    _id: logoValue._id,
    dirname: logoValue.dirname,
    basename: logoValue.basename,
    extension: logoValue.extension,
    filename: logoValue.filename,
    mimetype: logoValue.mimetype,
    filectime: new Double(logoValue.filectime as number),
    mmThumb: {},
    type: 'image',
    title: logoValue.title,
    alt: logoValue.alt,
  };
}

/**
 * A logo descriptor: the ten known keys (text, and the creation time as a number), `null` when the document has none. The unknown keys of the stored object (`mmThumb`)
 * are never returned. A write is `null` (remove) or the descriptor of an image of the group, which the service has built and checked: it is stored in the form of the legacy.
 */
export const logo: Codec = {
  read: (value) => (isPlain(value) ? { ...Object.fromEntries(LOGO_KEYS.map((key) => [key, stringOrNull(value[key])])), filectime: numberOf(value['filectime']) } : null),
  write: (value) => (value === null ? null : legacyLogoDescriptor(value as MediaLogo)),
};

const E_INVOICING: ReadonlyArray<readonly [string, string, Codec]> = [
  ['hub', 'hub', blank],
  ['transmitter.country', 'IdTrasmittente_paese', blank],
  ['transmitter.code', 'IdTrasmittente_codice', blank],
  ['eori', 'codice_eori', blank],
  ['pec', 'email', blank],
  ['recipientCode', 'codice_destinatario', blank],
  ['professionalRegister.name', 'albo_professionale', blank],
  ['professionalRegister.number', 'ap_numero_iscrizione', blank],
  ['professionalRegister.province', 'ap_provincia', blank],
  ['professionalRegister.date', 'ap_data_iscrizione', blank],
  ['rea.office', 'rea_ufficio', blank],
  ['rea.number', 'rea_numero', blank],
  ['rea.shareCapital', 'rea_capitale_sociale', blank],
  ['rea.shareholders', 'rea_soci', blank],
  ['rea.liquidation', 'rea_liquidazione', blank],
  ['taxRegime', 'regime_fiscale', blank],
];

/**
 * Every key of the company, domain and stored, in the order the representation is built: the general data, the e-invoicing, the numbering, the lists,
 * the customer app and the media. It is the only table of the mapping: the read, the comparison with a request and the choice of the keys to write all follow it.
 */
export const LEAVES: readonly Leaf[] = Object.freeze([
  { domain: 'name', legacy: 'name', codec: text },
  { domain: 'vatNumber', legacy: 'code', codec: text },
  { domain: 'fiscalCode', legacy: 'code2', codec: blank },
  { domain: 'address.street', legacy: 'address', codec: text },
  { domain: 'address.postcode', legacy: 'postcode', codec: text },
  { domain: 'address.city', legacy: 'city', codec: text },
  { domain: 'address.province', legacy: 'countryAreaCode', codec: text },
  { domain: 'address.country', legacy: 'countryCode', codec: text },
  { domain: 'currency', legacy: 'currencyCode', codec: text },
  { domain: 'email', legacy: 'email', codec: optionalText },
  { domain: 'phone', legacy: 'telephone', codec: optionalText },
  { domain: 'status', legacy: 'status', codec: status },
  { domain: 'trashed', legacy: 'trash', codec: flag, readOnly: true },
  { domain: 'expirationDate', legacy: 'expirationDate', codec: instant },
  { domain: 'createdAt', legacy: 'insertDate', codec: instant, readOnly: true },
  { domain: 'updatedAt', legacy: 'updateDate', codec: instant, readOnly: true },
  ...E_INVOICING.map(([domain, legacy, codec]): Leaf => ({ domain: `eInvoicing.${domain}`, legacy: `fattura_elettronica.${legacy}`, codec })),
  { domain: 'invoiceNumbering.position', legacy: 'invoicesPS', codec: position },
  { domain: 'invoiceNumbering.values', legacy: 'invoicesPSValues', codec: invoiceSeries },
  { domain: 'invoiceNumbering.lastInvoiceNumber', legacy: 'settings.global.lastInvoiceNumber', codec: wholeNumber },
  { domain: 'invoiceNumbering.discountLines', legacy: 'settings.global.discountLines', codec: flag },
  { domain: 'invoiceNumbering.cervedLookup', legacy: 'settings.api.cerved', codec: flag },
  { domain: 'bankAccounts', legacy: 'banks', codec: bankAccounts },
  { domain: 'mealVoucherIssuers', legacy: 'ticketsSuppliers', codec: mealVoucherIssuers },
  { domain: 'customerApp.enableLoginSignup', legacy: 'settings.global.enableLoginSignup', codec: flag },
  { domain: 'customerApp.showPrivacyPage', legacy: 'settings.global.showPrivacyPage', codec: flag },
  { domain: 'customerApp.showTermsPage', legacy: 'settings.global.showTermsPage', codec: flag },
  { domain: 'customerApp.ecommerce.status', legacy: 'settings.ecommerce.status', codec: flag },
  { domain: 'customerApp.ecommerce.priceListId', legacy: 'settings.ecommerce.listId', codec: reference },
  { domain: 'customerApp.ecommerce.minimumOrder', legacy: 'settings.ecommerce.minAmount', codec: minimumOrder },
  { domain: 'customerApp.ecommerce.showProductRemainingQuantity', legacy: 'settings.ecommerce.showProductRemainingQuantity', codec: quantity },
  ...ECOMMERCE_FLAGS.filter((key) => key !== 'status').map((key): Leaf => ({ domain: `customerApp.ecommerce.${key}`, legacy: `settings.ecommerce.${key}`, codec: flag })),
  { domain: 'media.internalFileName', legacy: 'medias.images.internalFileName', codec: plainText },
  { domain: 'media.externalUrl', legacy: 'medias.images.externalUrl', codec: plainText },
  { domain: 'media.customersAppLogoLight', legacy: 'medias.images.customersAppLogoLight', codec: logo },
  { domain: 'media.customersAppLogoDark', legacy: 'medias.images.customersAppLogoDark', codec: logo },
]);

/**
 * The value at a dotted path of a plain object tree, `undefined` when a step is missing or is not an object. Own keys only.
 *
 * @param tree The object.
 * @param path Dotted path.
 */
export function valueAt(tree: unknown, path: string): unknown {
  let current = tree;
  for (const key of path.split('.')) {
    if (!isPlain(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * Puts a value at a dotted path of an object being built, creating the steps.
 *
 * @param tree The object to change.
 * @param path Dotted path.
 * @param value The value.
 */
export function setValueAt(tree: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let target = tree;
  for (const key of keys) {
    target = (target[key] ??= {}) as Record<string, unknown>;
  }
  target[last] = value;
}

/**
 * Maps a stored company to its representation: every key by its codec, so a value that is missing or has the wrong type is `null` (or the neutral value of its
 * kind: `false`, `0`, `[]`) and the read never fails. Keys the backend does not know are not in the result.
 *
 * @param document The company as stored, read with the exact types (`Int32` and `Double` wrappers are accepted as numbers).
 * @param groupId The group the company was read from (the verified one, not the stored `groupId`).
 * @returns The company.
 */
export function toCompany(document: Document, groupId: ObjectId): Company {
  const company: Record<string, unknown> = { id: document['_id'] instanceof ObjectId ? document['_id'].toHexString() : '', groupId: groupId.toHexString() };
  readLeaves(LEAVES, document, company);
  return company as unknown as Company;
}

/**
 * Reads every key of a table of leaves from a stored document into a representation being built, each by its codec (a value that is missing or has the wrong type is the neutral
 * value of its kind, so the read never fails).
 *
 * @param leaves The table (companies and places each have theirs).
 * @param document The stored document, read with the exact types.
 * @param target The object being built, which the domain paths are set into.
 */
export function readLeaves(leaves: readonly Leaf[], document: Document, target: Record<string, unknown>): void {
  for (const leaf of leaves) {
    if (leaf.writeOnly !== true) {
      setValueAt(target, leaf.domain, leaf.codec.read(valueAt(document, leaf.legacy)));
    }
  }
}

/** One key to write: its stored path and the value to give it. */
export interface LeafWrite {
  /** The domain path, to tell what changed. */
  readonly domain: string;
  /** The stored path. */
  readonly legacy: string;
  readonly value: unknown;
}

/**
 * The keys a request writes. For every writable key the request has, its stored value is computed; when `current` is given a key whose value is the same as the
 * one the company has is left out, so a request that sends the whole object back changes only what really differs and keeps the exact stored form of the rest.
 *
 * @param request The validated request (any subset of the writable keys, in the domain form).
 * @param current The company (or place) as it is now, or `null` for a creation (every key the request has is written).
 * @param document The company (or place) as stored, or `null` for a creation: the minimum orders of other currencies (the days of other dates, for a place) are kept from it.
 * @param leaves The table of the keys, the one of the companies by default.
 * @returns The keys to write, in the order of the table.
 */
export function leafWrites(request: unknown, current: object | null, document: Document | null, leaves: readonly Leaf[] = LEAVES): LeafWrite[] {
  const writes: LeafWrite[] = [];
  for (const leaf of leaves) {
    const requested = valueAt(request, leaf.domain);
    if (leaf.readOnly === true || requested === undefined) {
      continue;
    }
    if (current !== null && canonicalJson(requested) === canonicalJson(valueAt(current, leaf.domain))) {
      continue;
    }
    writes.push({ domain: leaf.domain, legacy: leaf.legacy, value: leaf.codec.write(requested, document === null ? undefined : valueAt(document, leaf.legacy)) });
  }
  return writes;
}

/**
 * Maps a document of the copies (read with the list projection) to a compact list item. A value that is missing or has the wrong type is `null`
 * (the name `''`).
 *
 * @param document The projected company.
 */
export function toCompanySummary(document: Document): CompanySummary {
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: stringOrNull(document['name']) ?? '',
    vatNumber: stringOrNull(document['code']),
    city: stringOrNull(document['city']),
    province: stringOrNull(document['countryAreaCode']),
    country: stringOrNull(document['countryCode']),
    status: document['status'] === true ? 'active' : 'disabled',
    trashed: document['trash'] === true,
  };
}

/** The fields the list reads from the copies, the only ones ever loaded for it. */
export const COMPANY_SUMMARY_PROJECTION = Object.freeze({ name: 1, trash: 1, code: 1, city: 1, countryAreaCode: 1, countryCode: 1, status: 1 } as const);
