import type { CompanyAddress, DeepPartial } from '../companies/company.types.ts';

/** A price list a place sells with (`general.priceLists[]` of the document): the id of a price list of the group and the all-you-can-eat settings of the restaurant. */
export interface PlacePriceList {
  /** Id of a price list of the group. */
  readonly id: string;
  readonly allYouCanEat: boolean;
  /** The first code of the all-you-can-eat, `null` when not set. */
  readonly ayceCode1: string | null;
  /** The second code of the all-you-can-eat, `null` when not set. */
  readonly ayceCode2: string | null;
}

/** The place of a request or a response with the general data: the registry data, the price lists and the invoice series (`invoicePS`). */
export interface PlaceGeneral {
  readonly name: string;
  /** Id of the company of the place, `null` when the stored place has none. */
  readonly companyId: string | null;
  readonly address: CompanyAddress;
  /** Name of the contact person (`contact`). */
  readonly contactName: string | null;
  readonly email: string | null;
  /** The telephone (`telephone`). */
  readonly phone: string | null;
  /** The price list of the sales (`listId`): the id of a price list of the group, `null` for none. */
  readonly priceListId: string | null;
  /** The price list of the e-commerce (`ecommerceListId`), `null` for none. */
  readonly ecommercePriceListId: string | null;
  /**
   * The series of the invoice numbers (`invoicePS`): the `name` of one of the invoice series of the company, `null` for none, or `false` where the legacy stored it so (a value a
   * request may send back unchanged, never set).
   */
  readonly invoiceSeries: string | false | null;
  /** The price lists the place can use (`general.priceLists`). */
  readonly priceLists: readonly PlacePriceList[];
}

/** The license of a place: the plan, the end of the license, the state and the Sentry switch of the POS. */
export interface PlaceLicense {
  /** The plan as stored: `basic`, `advanced`, `enterprice`, `tgm-secondary`, `desk-secondary`, or a historical value (`professional`, `''`) returned as it is; `null` when the document has none. */
  readonly plan: string | null;
  /** ISO instant, `null` for none. */
  readonly expirationDate: string | null;
  readonly status: 'active' | 'disabled';
  /** Whether the POS reports its errors to Sentry (`platform.sentry`). */
  readonly sentry: boolean;
}

/** The hours of one day: whether the day is open and its time slots (`HH:mm`). */
export interface DayHours {
  readonly active: boolean;
  readonly values: ReadonlyArray<{ readonly start: string; readonly end: string }>;
}

/** The hours of a special day: whether the place is closed and, if not, its time slots. */
export interface SpecialDayHours {
  readonly closed: boolean;
  readonly values: ReadonlyArray<{ readonly start: string; readonly end: string }>;
}

/** The hours of the week, keyed by day `0` (Sunday) to `6`, all seven always there. */
export type WeekHours = Readonly<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', DayHours>>;

/** The special days by date (`YYYY-MM-DD`). */
export type SpecialDays = Readonly<Record<string, SpecialDayHours>>;

/** The hours of a place: the week and the special days. */
export interface HoursSchedule {
  readonly week: WeekHours;
  readonly special: SpecialDays;
}

/** The opening hours of a place: its time zone, the opening hours and the hours of the delivery (`delivery.time`). */
export interface PlaceOpeningHours extends HoursSchedule {
  /** IANA time zone. */
  readonly timezone: string | null;
  readonly deliveryTime: HoursSchedule;
}

/** A settings block of the place (step 7B): an object of the keys of the block, nested like the stored document; the schemas of `place-settings.schemas.ts` are the contract of each key. */
export type SettingsBlock = { readonly [key: string]: unknown };

/** The settings blocks of a place (step 7B), each the object of the keys of one tab of the old backoffice. */
export interface PlaceSettings {
  /** `general.*` but the price lists, and `advancedReport.logs` (`advancedReportLogs`). */
  readonly cashSettings: SettingsBlock;
  /** `receipt`, `prebilling` and `ordering`. */
  readonly printing: SettingsBlock;
  /** `payments` and `paymentTypes`. */
  readonly payments: SettingsBlock;
  /** `roomsSettings` but the reservations. */
  readonly tables: SettingsBlock;
  /** `roomsSettings.reservation`. */
  readonly reservations: SettingsBlock;
  /** `deliveryTakeAway` (`takeAway`) and `delivery` but the hours. */
  readonly delivery: SettingsBlock;
  readonly selfOrdering: SettingsBlock;
  readonly kiosk: SettingsBlock;
  /** `appointment`. */
  readonly appointments: SettingsBlock;
  readonly externalDisplay: SettingsBlock;
  readonly fidelity: SettingsBlock;
  /** `tgm`. */
  readonly tobacco: SettingsBlock;
  /** `medias.images`. */
  readonly media: SettingsBlock;
}

/**
 * A place as the detail returns it (`doc/Tasks.md` area 7, step 7A): the general data, the license and the opening hours. Never the integrations, the devices, the rooms, the storages, the
 * address of the store server or of the connector: they are not part of the representation, and the keys the backend does not know are never returned.
 */
export interface Place extends PlaceGeneral, PlaceSettings {
  readonly id: string;
  readonly groupId: string;
  readonly trashed: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly license: PlaceLicense;
  readonly openingHours: PlaceOpeningHours;
}

/** A place in the list: the compact reference (`id`, `name`, `companyId`, `trashed`, which the reference store reads) and the fields the list shows. */
export interface PlaceSummary {
  readonly id: string;
  readonly name: string;
  readonly companyId: string | null;
  readonly trashed: boolean;
  /** The plan as stored, `null` when the document has none. */
  readonly plan: string | null;
  readonly status: 'active' | 'disabled';
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  /** ISO instant, `null` for none. */
  readonly expirationDate: string | null;
}

/** What a request can write of a place: everything of {@link Place} but the read-only fields, with the address as a whole object. */
export type PlaceWritable = Omit<Place, 'id' | 'groupId' | 'trashed' | 'createdAt' | 'updatedAt'>;

/** The body of a modification: any subset of the fields and of the blocks, each block any subset of its fields (the lists and the hours of a week are replaced whole). */
export type PlacePatch = DeepPartial<PlaceWritable>;

/** The body of a creation: the name, the company and the address (without a province, which is optional) and, optionally, any other field. */
export type PlaceCreation = PlacePatch & {
  readonly name: string;
  readonly companyId: string;
  readonly address: { readonly street: string; readonly postcode: string; readonly city: string; readonly country: string; readonly province?: string };
};
