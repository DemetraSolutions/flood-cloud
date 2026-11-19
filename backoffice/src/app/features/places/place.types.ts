import { LogoDescriptor } from '../companies/company.types';

/** Status of a place. */
export type PlaceStatus = 'active' | 'disabled';

/** A place as listed by `GET /v1/groups/{groupId}/places`. */
export interface PlaceListItem {
  readonly id: string;
  readonly name: string;
  readonly companyId: string | null;
  readonly trashed: boolean;
  readonly plan: string | null;
  readonly status: PlaceStatus;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  /** ISO instant, `null` for none. */
  readonly expirationDate: string | null;
  /** Group of the place: only in the cross-group list (`GET /v1/places`). */
  readonly groupId?: string;
  /** Name of that group: `''` without a text name, `null` when the group does not exist (cross-group list only). */
  readonly groupName?: string | null;
  /** ISO instant the place was trashed, `null` otherwise (cross-group list). */
  readonly trashedAt?: string | null;
}

/** Postal address of a place. */
export interface PlaceAddress {
  readonly street: string | null;
  readonly postcode: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
}

/** A price list the place can use, with the all-you-can-eat settings of the restaurant. */
export interface PlacePriceList {
  readonly id: string;
  readonly allYouCanEat: boolean;
  readonly ayceCode1: string | null;
  readonly ayceCode2: string | null;
}

/** The license of a place. */
export interface PlaceLicense {
  /** The plan as stored, also a historical one. */
  readonly plan: string | null;
  readonly expirationDate: string | null;
  readonly status: PlaceStatus;
}

/** The hours of a day of the week. */
export interface DayHours {
  readonly active: boolean;
  readonly values: readonly { readonly start: string; readonly end: string }[];
}

/** The hours of a special day. */
export interface SpecialDayHours {
  readonly closed: boolean;
  readonly values: readonly { readonly start: string; readonly end: string }[];
}

/** A week (`0` Sunday to `6`) and the special days by `YYYY-MM-DD` date. */
export interface HoursSchedule {
  readonly week: Readonly<Record<string, DayHours>>;
  readonly special: Readonly<Record<string, SpecialDayHours>>;
}

/** Opening hours and delivery hours of a place. */
export interface PlaceOpeningHours extends HoursSchedule {
  readonly timezone: string | null;
  readonly deliveryTime: HoursSchedule;
}

/** A settings block as the API returns it: an object of the keys of the tab, nested as stored. */
export type PlaceBlock = { readonly [key: string]: unknown };

/** The settings blocks of a place (thirteen of the settings, then the integrations and the dealer settings). */
export const SETTINGS_BLOCKS = [
  'cashSettings',
  'printing',
  'payments',
  'tables',
  'reservations',
  'delivery',
  'selfOrdering',
  'kiosk',
  'appointments',
  'externalDisplay',
  'fidelity',
  'tobacco',
  'media',
  'integrations',
  'dealerSettings',
] as const;

/** Name of a settings block. */
export type SettingsBlockName = (typeof SETTINGS_BLOCKS)[number];

/** A place as returned by the detail and by every write. */
export interface PlaceRecord extends Readonly<
  Record<Exclude<SettingsBlockName, 'dealerSettings'>, PlaceBlock>
> {
  readonly devices: { readonly items: readonly PlaceDevice[]; readonly editable: boolean };
  readonly printStations: {
    readonly stations: readonly PlacePrintStation[];
    readonly productionCenters: readonly PlaceProductionCenter[];
    readonly stationsEditable: boolean;
    readonly productionCentersEditable: boolean;
  };
  readonly rooms: { readonly items: readonly PlaceRoom[]; readonly editable: boolean };
  readonly storages: { readonly items: readonly PlaceStorage[]; readonly editable: boolean };
  /** Only for platform administrators and dealers. */
  readonly dealerSettings?: PlaceBlock;
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly companyId: string | null;
  readonly address: PlaceAddress;
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly priceListId: string | null;
  readonly ecommercePriceListId: string | null;
  readonly invoiceSeries: string | false | null;
  readonly priceLists: readonly PlacePriceList[];
  readonly trashed: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly license: PlaceLicense;
  readonly openingHours: PlaceOpeningHours;
}

/** The slots of the media of a place that hold an image. */
export const MEDIA_SLOTS = [
  'logoLight',
  'coverLight',
  'logoKiosk',
  'coverKiosk',
  'productPlaceholderKiosk',
] as const;

/** Name of an image slot of a place. */
export type MediaSlot = (typeof MEDIA_SLOTS)[number];

/** The stored descriptor of an image (sent back unchanged to keep it). */
export type { LogoDescriptor };

/** The plans a place may have; the stored value may be another one (a historical plan). */
export const PLANS = [
  'basic',
  'advanced',
  'enterprice',
  'tgm-secondary',
  'desk-secondary',
] as const;

/** Plans a dealer may choose when creating a place (`desk-secondary` is the platform's). */
export const DEALER_PLANS = ['basic', 'advanced', 'enterprice', 'tgm-secondary'] as const;

/** A device of the place (`devices.items[]`); the credentials of the automatic cash are write-only (`…Set` flags). */
export interface PlaceDevice {
  /** Empty for a device not saved yet. */
  readonly id: string;
  /** `true` for an item the stored list keeps without an id (read only). */
  readonly withoutId?: true;
  readonly server: boolean;
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
  readonly externalDisplayId: string;
  readonly secondaryCompanyPrinterId: string;
  readonly favoritesId: string;
  readonly scaleDialog0204Ip: string;
  readonly scaleDialog0204Port: string;
  readonly scaleDialog0204SendPrice: boolean;
  readonly barcodePriceRule: string;
  readonly orderingPrintSingleProduct: boolean;
  readonly orderingPrintSingleProductTables: boolean;
  readonly printStations: readonly string[];
}

/** A print station of the place. */
export interface PlacePrintStation {
  readonly id: string;
  readonly withoutId?: true;
  readonly name: string;
  readonly driver: string;
  readonly host: string;
  readonly pulseNumber: number | null;
  readonly pulseNumberSecondary: number | null;
  readonly upsideDown: boolean;
  readonly exitsCut: boolean;
  readonly summaryCategoriesIds: readonly string[];
  readonly summaryPrintStationsIds: readonly string[];
}

/** A production center of the place. */
export interface PlaceProductionCenter {
  readonly id: string;
  readonly withoutId?: true;
  readonly name: string;
  readonly capacity: number;
}

/** The position and size of a table in the grid of its room, in cells (`x` and `y` are `null` while not placed). */
export interface PlaceTableView {
  readonly w: number;
  readonly h: number;
  readonly x: number | null;
  readonly y: number | null;
  /** `rect` or `round`. */
  readonly shape: string;
}

/** A table of a room. */
export interface PlaceTable {
  readonly id: string;
  readonly withoutId?: true;
  readonly name: string;
  readonly seats: number | null;
  readonly userId: string;
  readonly view: PlaceTableView;
}

/** A room of the place with its tables and layout. */
export interface PlaceRoom {
  readonly id: string;
  readonly withoutId?: true;
  readonly name: string;
  readonly listId: string;
  readonly service: number | null;
  readonly tax: string;
  readonly deviceId: string;
  readonly seatsRequest: boolean;
  readonly seatsRequired: boolean;
  readonly autoService: boolean;
  readonly priceListsRequest: boolean;
  readonly handheldVisibility: boolean;
  readonly printStations: readonly string[];
  readonly tables: readonly PlaceTable[];
  readonly view: {
    readonly type: string;
    readonly status: boolean;
    readonly h: number;
    readonly w: number;
  };
}

/** A storage of the place. */
export interface PlaceStorage {
  readonly id: string;
  readonly name: string;
  readonly cash: boolean;
  readonly ecommerce: boolean;
}

/** The sections of the form: the units of change, one property of the model each. */
export const PLACE_SECTIONS = [
  'general',
  'license',
  'openingHours',
  ...SETTINGS_BLOCKS,
  'devices',
  'printStations',
  'rooms',
  'storages',
] as const;

/** Identifier of a section. */
export type PlaceSection = (typeof PLACE_SECTIONS)[number];

/** URL of the detail of a place. */
export function placeRoute(groupId: string, placeId: string): string[] {
  return ['/groups', groupId, 'places', placeId];
}
