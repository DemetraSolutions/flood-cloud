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
  readonly sentry: boolean;
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

/** The thirteen settings blocks of a place, in the order of the tabs. */
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
] as const;

/** Name of a settings block. */
export type SettingsBlockName = (typeof SETTINGS_BLOCKS)[number];

/** A place as returned by the detail and by every write. */
export interface PlaceRecord extends Readonly<Record<SettingsBlockName, PlaceBlock>> {
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

/** The sections (tabs) of the place, named as the blocks of the API; the order is the order of the tabs. */
export const PLACE_SECTIONS = [
  { id: 'general', path: '', key: 'GENERAL', exact: true },
  { id: 'license', path: 'license', key: 'LICENSE', exact: false },
  { id: 'openingHours', path: 'opening-hours', key: 'OPENING_HOURS', exact: false },
  { id: 'cashSettings', path: 'cash', key: 'CASH', exact: false },
  { id: 'printing', path: 'printing', key: 'PRINTING', exact: false },
  { id: 'payments', path: 'payments', key: 'PAYMENTS', exact: false },
  { id: 'tables', path: 'tables', key: 'TABLES', exact: false },
  { id: 'reservations', path: 'reservations', key: 'RESERVATIONS', exact: false },
  { id: 'delivery', path: 'delivery', key: 'DELIVERY', exact: false },
  { id: 'selfOrdering', path: 'self-ordering', key: 'SELF_ORDERING', exact: false },
  { id: 'kiosk', path: 'kiosk', key: 'KIOSK', exact: false },
  { id: 'appointments', path: 'appointments', key: 'APPOINTMENTS', exact: false },
  { id: 'externalDisplay', path: 'external-display', key: 'EXTERNAL_DISPLAY', exact: false },
  { id: 'fidelity', path: 'fidelity', key: 'FIDELITY', exact: false },
  { id: 'tobacco', path: 'tobacco', key: 'TOBACCO', exact: false },
  { id: 'media', path: 'media', key: 'MEDIA', exact: false },
] as const;

/** Identifier of a section. */
export type PlaceSection = (typeof PLACE_SECTIONS)[number]['id'];

/** URL of the detail of a place. */
export function placeRoute(groupId: string, placeId: string): string[] {
  return ['/groups', groupId, 'places', placeId];
}
