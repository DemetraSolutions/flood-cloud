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

/** The license of a place: the plan, the end of the license and the state. */
export interface PlaceLicense {
  /** The plan as stored: `basic`, `advanced`, `enterprice`, `tgm-secondary`, `desk-secondary`, or a historical value (`professional`, `''`) returned as it is; `null` when the document has none. */
  readonly plan: string | null;
  /** ISO instant, `null` for none. */
  readonly expirationDate: string | null;
  readonly status: 'active' | 'disabled';
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

/**
 * A device of the place (`devices[]`, step 7F). The keys are the ones of the old backoffice; the `info` and the `status` the POS writes on a device are not part of it. A credential
 * (the user and the password of the automatic cash) is never returned: `automaticCashUsernameSet` and `automaticCashPasswordSet` tell whether it is set. A request may carry the credential
 * (`automaticCashUsername`, `automaticCashPassword`: a text sets it, `null` clears it, leaving it out keeps it).
 */
export interface PlaceDevice {
  /** The id of the device: `dBJs.createId` of the old backoffice; a request leaves it out for a new device. */
  readonly id: string;
  readonly server: boolean;
  /** `desk`, `handheld`, `ordering`, `room-handheld`, `selfordering`, `waiting-list`, `external-display`, `kiosk` or `tgm`. */
  readonly type: string;
  readonly name: string;
  readonly driver: string;
  readonly host: string;
  readonly serialNumber: string;
  readonly epsonProtocol17: boolean;
  readonly epsonEreceipt: boolean;
  readonly DLN502017Rounding: boolean;
  readonly secondaryDriver: string;
  readonly secondaryHost: string;
  readonly automaticCashDriver: string;
  readonly automaticCashHost: string;
  readonly automaticCashUsernameSet: boolean;
  readonly automaticCashPasswordSet: boolean;
  readonly posProtocol17ip: string;
  readonly posProtocol17port: string;
  readonly posProtocol17terminalId: string;
  readonly posDojoTerminalId: string;
  /** MultiSafepay App-to-App payment on the device. */
  readonly multisafepayAppStatus: boolean;
  /** MultiSafepay QR Code payment on the device. */
  readonly multisafepayQrStatus: boolean;
  /** The MultiSafepay terminals of the device (at most 20, `terminalId` unique): `terminalId` 1 to 64 of `[A-Za-z0-9_-]`, `name` 1 to 100 characters. The list is written as a whole. */
  readonly multisafepayTerminals: ReadonlyArray<{ readonly terminalId: string; readonly name: string }>;
  /** The id of a device of type `external-display` of the place, `''` for none. */
  readonly externalDisplayId: string;
  /** The id of a device of type `tgm` of the place, `''` for none. */
  readonly secondaryCompanyPrinterId: string;
  /** The id of a list of favorite products of the group, `''` for none. */
  readonly favoritesId: string;
  readonly scaleDialog0204Ip: string;
  readonly scaleDialog0204Port: string;
  readonly scaleDialog0204SendPrice: boolean;
  readonly barcodePriceRule: string;
  readonly orderingPrintSingleProduct: boolean;
  readonly orderingPrintSingleProductTables: boolean;
  /** The ids of the print stations of the device. */
  readonly printStations: readonly string[];
  /** The names the old backoffice keeps next to the references: computed by the server. */
  readonly externalDisplayName: string;
  readonly secondaryCompanyPrinterName: string;
  readonly favoritesGroupName: string;
}

/** A print station (`printStations[]`). */
export interface PlacePrintStation {
  readonly id: string;
  /** `true` for an item the document keeps without an id (read only: the list it is in cannot be written). */
  readonly withoutId?: true;
  readonly name: string;
  /** `EPSON-EPOS-PRINT` or `ESCPOS`. */
  readonly driver: string;
  readonly host: string;
  readonly pulseNumber: number | null;
  readonly pulseNumberSecondary: number | null;
  readonly upsideDown: boolean;
  readonly exitsCut: boolean;
  /** The ids of the product categories the summary is made for. */
  readonly summaryCategoriesIds: readonly string[];
  /** The ids of the print stations the summary is made for. */
  readonly summaryPrintStationsIds: readonly string[];
}

/** A production center (`productionCenter[]`). */
export interface PlaceProductionCenter {
  readonly id: string;
  /** `true` for an item the document keeps without an id (read only: the list it is in cannot be written). */
  readonly withoutId?: true;
  readonly name: string;
  readonly capacity: number;
}

/** The place of a table in the grid of its room (`rooms[].tables[].view`), in cells. */
export interface PlaceTableView {
  readonly w: number;
  readonly h: number;
  /** The cell at the top left, `null` while the table is not placed. */
  readonly x: number | null;
  readonly y: number | null;
  /** `rect` or `round`. */
  readonly shape: string;
}

/** A table of a room. */
export interface PlaceTable {
  readonly id: string;
  /** `true` for an item the document keeps without an id (read only: the list it is in cannot be written). */
  readonly withoutId?: true;
  /** The id of the room: the server sets it. */
  readonly roomId: string;
  readonly name: string;
  readonly seats: number | null;
  /** The id of the user the table is assigned to, `''` for none. */
  readonly userId: string;
  readonly view: PlaceTableView;
}

/** A room (`rooms[]`) with its tables and its layout (`view`). The `view.subtables` the POS writes are not part of it. */
export interface PlaceRoom {
  readonly id: string;
  /** `true` for an item the document keeps without an id (read only: the list it is in cannot be written). */
  readonly withoutId?: true;
  readonly name: string;
  readonly listId: string;
  readonly service: number | null;
  readonly tax: string;
  /** The id of a device of type `desk` of the place, `''` for none. */
  readonly deviceId: string;
  readonly seatsRequest: boolean;
  readonly seatsRequired: boolean;
  readonly autoService: boolean;
  readonly priceListsRequest: boolean;
  readonly handheldVisibility: boolean;
  /** The ids of the print stations of the room. */
  readonly printStations: readonly string[];
  readonly tables: readonly PlaceTable[];
  /** The layout: `grid` (or `''` for the default list), whether the map is on, its size in cells. */
  readonly view: { readonly type: string; readonly status: boolean; readonly h: number; readonly w: number };
}

/** A storage of the place (`storages[]`). */
export interface PlaceStorage {
  /** The id of the storage, an `ObjectId` in the document; a request leaves it out for a new storage. */
  readonly id: string;
  readonly name: string;
  /** The storage of the cash desks: exactly one. */
  readonly cash: boolean;
  /** The storage of the e-commerce: at most one. */
  readonly ecommerce: boolean;
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
  /** `integrations`: the switch and the settings of every integration; a credential has a `<name>Set` flag and is never returned. */
  readonly integrations: SettingsBlock;
  /** `platform.sentry`, `server.ip` and `connectorAddress`: the dealers' (a PSA's or a dealer's; Sentry the PSA's); only they get the block. */
  readonly dealerSettings?: SettingsBlock;
}

/** The devices of the place (`devices[]`). */
export interface PlaceDevices {
  readonly items: readonly PlaceDevice[];
  /** `false` when the stored list has an item without an id: the list is read only and a change of it is `409`. */
  readonly editable: boolean;
}

/** The print stations and the production centers of the place (`printStations[]` and `productionCenter[]`). */
export interface PlacePrintStations {
  readonly stations: readonly PlacePrintStation[];
  readonly productionCenters: readonly PlaceProductionCenter[];
  /** `false` when the stored stations (or centers) have an item without an id: read only, a change is `409`. */
  readonly stationsEditable: boolean;
  readonly productionCentersEditable: boolean;
}

/** The rooms of the place (`rooms[]`). */
export interface PlaceRooms {
  readonly items: readonly PlaceRoom[];
  /** `false` when a stored room or table has no id: read only, a change is `409`. */
  readonly editable: boolean;
}

/** The storages of the place (`storages[]`). */
export interface PlaceStorages {
  readonly items: readonly PlaceStorage[];
  readonly editable: boolean;
}

/** The lists of items of the place (step 7F). */
export interface PlaceLists {
  readonly devices: PlaceDevices;
  readonly printStations: PlacePrintStations;
  readonly rooms: PlaceRooms;
  readonly storages: PlaceStorages;
}

/**
 * A place as the detail returns it (`doc/Tasks.md` area 7): the general data, the license, the opening hours, the settings, the lists of items (devices, print stations, rooms, storages),
 * the integrations and the dealer settings. A credential is never returned (only whether it is set), the `dealerSettings` are returned to a PSA or a dealer only, and the keys the backend
 * does not know are never returned.
 */
export interface Place extends PlaceGeneral, PlaceSettings, PlaceLists {
  readonly id: string;
  readonly groupId: string;
  readonly trashed: boolean;
  /** When the place went to the trash (ISO 8601); `null` when it is not there or the legacy trashed it (informational only). */
  readonly trashedAt: string | null;
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
  /** When the place went to the trash (ISO 8601), `null` when unknown. */
  readonly trashedAt: string | null;
  /** The plan as stored, `null` when the document has none. */
  readonly plan: string | null;
  readonly status: 'active' | 'disabled';
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  /** ISO instant, `null` for none. */
  readonly expirationDate: string | null;
}

/** A place of the list across groups: the compact item plus the group it belongs to. */
export interface CrossGroupPlace extends PlaceSummary {
  readonly groupId: string;
  /** Name of the group, `null` when the group is missing. */
  readonly groupName: string | null;
}

/** What a request can write of a place: everything of {@link Place} but the read-only fields, with the address as a whole object. */
export type PlaceWritable = Omit<Place, 'id' | 'groupId' | 'trashed' | 'trashedAt' | 'createdAt' | 'updatedAt'>;

/** The body of a modification: any subset of the fields and of the blocks, each block any subset of its fields (the lists and the hours of a week are replaced whole). */
export type PlacePatch = DeepPartial<PlaceWritable>;

/** The body of a creation: the name, the company and the address (without a province, which is optional) and, optionally, any other field. */
export type PlaceCreation = PlacePatch & {
  readonly name: string;
  readonly companyId: string;
  readonly address: { readonly street: string; readonly postcode: string; readonly city: string; readonly country: string; readonly province?: string };
};

declare const clearCredentials: unique symbol;

/**
 * The place as the server of its own point of sale reads it: the representation of the backoffice with the credentials of integrations and devices in clear instead of their `<key>Set`
 * flags. It is deliberately a different type, not assignable to {@link Place} (an opaque tree with a brand), so the compiler refuses it wherever a `Place` is accepted (a response of the
 * backoffice, an activity event, a comparison with a request).
 */
export type StorePlace = Readonly<Record<string, unknown>> & { readonly [clearCredentials]: true };
