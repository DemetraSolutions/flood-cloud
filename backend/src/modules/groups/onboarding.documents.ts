import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { FEATURES } from './features.ts';
import type { Feature } from './features.ts';
import { PROVIDERS } from './group.types.ts';

/** The tax rate of a new group, as the form chose it: a percentage and the fiscal department of the cash register it is sold under. */
export interface TaxChoice {
  readonly rate: number;
  readonly department: number;
}

/** A tax rate of a new group with the id it will have. */
export interface NewTax extends TaxChoice {
  readonly id: string;
}

/** What the document of a new group is built from. */
export interface NewGroupInput {
  readonly id: ObjectId;
  readonly name: string;
  /** The dealer of the group, `null` for none. */
  readonly dealerId: ObjectId | null;
  readonly demo: boolean;
  /** The features chosen beyond the defaults (`cash` and `productsVariants` on, the others off). */
  readonly features: Readonly<Partial<Record<Feature, boolean>>>;
  readonly taxes: readonly NewTax[];
  /** The ids of the default price list, the measure unit and the three standard warehouse rules. */
  readonly ids: { readonly priceList: string; readonly measureUnit: string; readonly loadRule: string; readonly unloadRule: string; readonly returnRule: string };
  /** The files host of the group (`GROUP_FILES_HOST`), `''` for none. */
  readonly filesHost: string;
  /** The key of the group the legacy POS and integrations use: never returned, never logged. */
  readonly apiKey: string;
  readonly now: Date;
}

/** The currency of a new group and its fiscal symbol, stored as the HTML entity the legacy writes (the groups module shows it as the character). */
const CURRENCY = Object.freeze({ code: 'EUR', symbol: '&euro;' });

/** The unit of measure of a new group. */
const MEASURE_UNIT = 'pz';

/** The name of the default price list of a new group. */
const PRICE_LIST_NAME = 'Listino 1';

/** The features a new group has switched on before the form chooses (the cash register and the product variants). */
const DEFAULT_FEATURES: ReadonlySet<Feature> = new Set<Feature>(['cash', 'productsVariants']);

/**
 * A new key of a group for the legacy POS and the integrations: 256 random bits from the CSPRNG as 64 hexadecimal characters. Nobody decrypts it, it is only compared for equality.
 * It is written once and never read back by this backend: it is not a credential here, and no response or log carries it.
 */
export function newGroupApiKey(): string {
  return randomBytes(32).toString('hex');
}

/** A new tax rate with its id, as the legacy stores it (`{ id, value, department, description, natura }`): the department of the cash register, no description, no VAT nature. */
export function legacyTax(tax: NewTax): Document {
  return { id: tax.id, value: tax.rate, department: tax.department, description: null, natura: null };
}

/**
 * The document of a new group in the format of the legacy (`groups/generate`, `doc/Tasks.md` area 8): every key the readers of the legacy and the POS use without a guard.
 * Every feature is present (`cash` and `productsVariants` on, the others as the form chose), `settings.integrations` has the seven providers off with no key, and the group has one default price list,
 * the currency EUR, the unit `pz`, the three standard warehouse rules, the tax rates, the rules of the fidelity cards for EUR and no fidelity data. `type` is `null` (the type of customer is a
 * preset of the form and is not stored), `plan` and `expirationDate` are not written (they belong to the place, D-13), and `places` starts empty (the creation of the place recalculates it).
 *
 * @param input The values of the group.
 * @returns The document to insert, with `_id`.
 */
export function newGroupDocument(input: NewGroupInput): Document {
  const { ids } = input;
  const settings: Document = { languages: null };
  for (const feature of FEATURES) {
    settings[feature] = input.features[feature] ?? DEFAULT_FEATURES.has(feature);
  }
  settings['stats'] = { openingTime: null };
  settings['integrations'] = Object.fromEntries(PROVIDERS.map((provider) => [provider, { status: false, apiKey: null }]));
  return {
    _id: input.id,
    name: input.name,
    description: '',
    databaseHost: '',
    filesHost: input.filesHost,
    type: null,
    settings,
    status: true,
    demo: input.demo,
    dealerId: input.dealerId,
    apiKey: input.apiKey,
    priceLists: { [ids.priceList]: { id: ids.priceList, default: true, status: true, name: PRICE_LIST_NAME } },
    taxes: input.taxes.map(legacyTax),
    currencies: { [CURRENCY.code]: { code: CURRENCY.code, symbol: CURRENCY.symbol } },
    measureUnits: { [ids.measureUnit]: { id: ids.measureUnit, value: MEASURE_UNIT } },
    warehouseRules: {
      [ids.loadRule]: { id: ids.loadRule, name: 'Carico standard', type: 'L', quantity: '+', value: '+', useLoadUnit: false, counterpart: 'suppliers', default: true, cashL: false },
      [ids.unloadRule]: { id: ids.unloadRule, name: 'Scarico standard', type: 'D', quantity: '-', value: '-', counterpart: 'customers', default: true, cashD: true },
      [ids.returnRule]: { id: ids.returnRule, name: 'Reso standard', type: 'L', quantity: '+', value: '+', useLoadUnit: false, counterpart: 'customers', default: true, cashL: true },
    },
    fidelityCardRules: { [CURRENCY.code]: { code: CURRENCY.code, value: null, discountPercentage: null } },
    fidelity: { cardsTypes: [], pointsCollections: [], prizeCatalogues: [] },
    expirationDate: null,
    places: [],
    trash: false,
    insertDate: input.now,
    updateDate: input.now,
  };
}

/**
 * The departments of a new group, one per tax rate, as the POS reads them: the `tax` object is a copy of the tax rate of the group (the POS reads `department.tax.value` without a guard) and the
 * `code` is the department of the tax rate, so none is `undefined`. They carry the `groupId` the legacy leaves out.
 *
 * @param groupId The new group.
 * @param taxes Its tax rates.
 * @param now Insert and update date.
 * @returns The documents to insert, each with a new `_id`.
 */
export function newDepartmentDocuments(groupId: ObjectId, taxes: readonly NewTax[], now: Date): Document[] {
  return taxes.map((tax) => ({
    _id: new ObjectId(),
    groupId,
    code: tax.department,
    tax: legacyTax(tax),
    name: { it: `Reparto ${String(tax.department)}` },
    description: { it: '' },
    medias: { images: {} },
    placesAvailability: [],
    status: true,
    trash: false,
    insertDate: now,
    updateDate: now,
  }));
}

/**
 * The end of the current year in Italy, the default expiration of a new place: 31 December at 23:59:59 in `Europe/Rome`. On that date the time zone is always on winter time
 * (UTC+1: the summer time ends in October), so the instant is 22:59:59 UTC; the year is the one in Italy, which differs from the UTC one for the first hour of the year.
 *
 * @param now The current instant.
 * @returns The instant.
 */
export function endOfYearInRome(now: Date): Date {
  const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', year: 'numeric' }).format(now));
  return new Date(Date.UTC(year, 11, 31, 22, 59, 59));
}

/**
 * The end of a calendar day in Italy, 23:59:59 in `Europe/Rome`: the expiration a date without a time stands for, as the default of the year ends at 23:59:59 on 31 December.
 * The offset is the one of the day (summer or winter time), read at noon UTC, far from the changes of time (which happen at 01:00 UTC).
 *
 * @param day The date, as the instant 00:00 UTC of the day.
 * @returns The instant.
 */
export function endOfDayInRome(day: Date): Date {
  const noon = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12));
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'longOffset' }).formatToParts(noon).find((part) => part.type === 'timeZoneName')!.value;
  // Italy is always east of Greenwich: `GMT+01:00` or `GMT+02:00`.
  const [, hours, minutes] = /^GMT\+(\d{2}):(\d{2})$/.exec(zone)!;
  const offsetMs = (Number(hours) * 60 + Number(minutes)) * 60_000;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59, 59) - offsetMs);
}
