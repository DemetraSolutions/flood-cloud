/**
 * The keys of the legacy `places` document the backend owns (`doc/Tasks.md` area 7, step 7A: the general data, the license and the opening hours; the blocks of the
 * settings come with step 7B). Every key is written one by one with `$set` on its dotted path, never as the whole block, so the keys the POS, the legacy or a later
 * release add to a block survive every write. What the POS writes (`devices`, `rooms`, `storages`, `printStations`, `productionCenter`) and what is kept for the
 * integrations (`integrations`, `server`, `connectorAddress`, `platform` but for `platform.sentry`) is never owned.
 */

import { SETTING_CONTAINERS, SETTING_LEGACY_PATHS } from './place-settings.ts';

/** Day of the week `0` (Sunday) to `6`: the keys of `openingTime.weekGeneric` and `delivery.time.weekGeneric`, each `{ active, values: [{ start, end }] }`. */
export const WEEK_DAYS = Object.freeze(['0', '1', '2', '3', '4', '5', '6'] as const);

/** The registry data, the license and the state of the place at the top level of the document, written key by key (`trash` and `updateDate` are written by the service itself). */
export const PLACE_TOP_KEYS = Object.freeze([
  'name',
  'address',
  'postcode',
  'city',
  'countryAreaCode',
  'countryCode',
  'contact',
  'email',
  'telephone',
  'companyId',
  'listId',
  'ecommerceListId',
  'invoicePS',
  'timezone',
  'plan',
  'status',
  'expirationDate',
] as const);

/**
 * Every owned leaf path below a block of the place (the settings of step 7B are listed in `place-settings.ts`): the enabled price lists (`general.priceLists`, a whole array), the Sentry switch (`platform.sentry`), the opening hours
 * of the week and the special days (`openingTime.weekGeneric`, `openingTime.daySpecial`) and the same two of the delivery hours (`delivery.time.*`), each a whole value.
 */
export const PLACE_BLOCK_PATHS: readonly string[] = Object.freeze([
  'general.priceLists',
  'platform.sentry',
  'openingTime.weekGeneric',
  'openingTime.daySpecial',
  'delivery.time.weekGeneric',
  'delivery.time.daySpecial',
  // The settings blocks of step 7B, key by key.
  ...SETTING_LEGACY_PATHS,
]);

/**
 * The containers that hold owned leaves, outermost first: when one is missing or empty in a stored place, a write that sets a leaf below it completes it with the
 * defaults of the keys the change does not set, so it never stays half built (the POS reads these blocks without checks). A container that is not an object is refused.
 */
export const PLACE_CONTAINERS: readonly string[] = Object.freeze([...new Set(['platform', 'general', 'openingTime', 'delivery', 'delivery.time', ...SETTING_CONTAINERS])]);
