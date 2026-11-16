import { SETTING_BLOCKS } from '../../shared/legacy-write/place-settings.ts';
import type { SettingField, SettingKind, WholeName } from '../../shared/legacy-write/place-settings.ts';
import { array, boolean, enumOf, integer, nullable, number, object, optional, record, string } from '../../shared/validation/schema.ts';
import type { Schema } from '../../shared/validation/schema.ts';
import { emptyAsNull, fileNameText, logoValue, urlText } from '../companies/companies.schemas.ts';
import type { Part } from '../companies/companies.schemas.ts';

/** Most elements of the lists of the settings (the categories of a list, the payment types…), and the most languages and price lists a map can name. */
export const MAX_SETTING_ITEMS = 500;
const MAX_PAYMENT_TYPES = 50;
const MAX_LANGUAGES = 20;
const MAX_PRICE_LISTS = 50;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = () => string({ min: 1, max: 64, pattern: ID });
const wholeInt = (max = 2_147_483_647) => nullable(integer({ min: 0, max }));
/** The id of a payment type in a request: one the place has already (the service checks it) or none, for a new type. */
const typeId = () => string({ min: 1, max: 64, pattern: ID });

/** The schemas of the keys that are a whole list or map. */
function wholeSchema(name: WholeName): Schema<unknown> {
  switch (name) {
    case 'workshiftNames':
      return array(string({ min: 1, max: 50, trim: true }), { max: 20 });
    case 'tipValues':
      return array(object({ type: enumOf(['v', 'p'] as const), value: number({ min: 0, max: 100_000 }) }), { max: 20 });
    case 'tableGroups':
      return object({ status: boolean(), name: boolean(), autoCreateFirst: boolean() });
    case 'timeBlocks':
      return array(object({ weekDays: array(integer({ min: 0, max: 6 }), { max: 7, unique: true }), start: string({ max: 5, trim: true }), end: string({ max: 5, trim: true }) }), { max: 50 });
    case 'paymentTypes':
      return array(
        object({
          id: optional(typeId()),
          name: string({ min: 1, max: 100, trim: true }),
          cash: boolean(),
          electronic: boolean(),
          cheque: boolean(),
          tickets: boolean(),
          electronicInvoiceMode: emptyAsNull(nullable(string({ max: 4, pattern: /^MP(?:0[1-9]|1\d|2[0-3])$/ }))),
        }),
        { max: MAX_PAYMENT_TYPES },
      );
    case 'shippingCosts':
      return array(object({ taxed: number({ min: 0, max: 1_000_000 }), toKm: number({ min: 0, max: 100_000 }) }), { max: 50 });
    case 'minAmount':
      return record(number({ min: 0, max: 1_000_000_000 }), { max: 10, key: /^[A-Z]{3}$/ });
    case 'priceListsConfig':
      return record(
        object({
          roundTime: wholeInt(),
          roundMaxProducts: wholeInt(),
          totalMaxProducts: wholeInt(),
          variants: boolean(),
          freeVariants: boolean(),
          tableAutoClose: boolean(),
          productsCategories: array(object({ _id: id(), roundMaxProducts: wholeInt(), totalMaxProducts: wholeInt(), position: wholeInt(), purchasable: boolean() }), { max: MAX_SETTING_ITEMS }),
        }),
        { max: MAX_PRICE_LISTS, key: ID },
      );
    case 'kioskCategories':
      return array(object({ _id: id(), position: wholeInt() }), { max: MAX_SETTING_ITEMS });
    case 'languageTexts':
      return record(string({ max: 200 }), { max: MAX_LANGUAGES, key: /^[a-z]{2}$/ });
  }
}

/** The schema of the value of a key (`field.legacy` tells the media names apart). */
function kindSchema(field: SettingField): Schema<unknown> {
  const kind: SettingKind = field.kind;
  switch (kind.t) {
    case 'flag':
      return boolean();
    case 'text':
      return emptyAsNull(nullable(string({ max: kind.max, trim: true })));
    case 'plain':
      // The plain texts are the media names: a simple file name, or an `http(s)` URL.
      return field.legacy.includes('externalUrl') ? urlText() : fileNameText();
    case 'enum':
      return kind.def === null ? emptyAsNull(nullable(enumOf(kind.values))) : enumOf(kind.values);
    case 'font':
      // The form (`R-C`) is checked by the service where the value changes, so a historical value sent back unchanged is accepted.
      return string({ max: 3 });
    case 'color':
      return string({ max: 7 });
    case 'time':
      return emptyAsNull(nullable(string({ max: 5, trim: true })));
    case 'int':
      return kind.def === null ? nullable(integer({ min: kind.min, max: kind.max })) : integer({ min: kind.min, max: kind.max });
    case 'num':
      return nullable(number({ min: kind.min, max: kind.max }));
    case 'id':
      return emptyAsNull(nullable(string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ })));
    case 'ref':
      return emptyAsNull(nullable(id()));
    case 'logo':
      return nullable(logoValue());
    case 'whole':
      return wholeSchema(kind.name);
  }
}

type Tree = { [key: string]: Tree | SettingField };

/** The fields of a block as a tree by the segments of their path below the block. */
function treeOf(fields: readonly SettingField[], strip: number): Tree {
  const root: Tree = {};
  for (const field of fields) {
    const segments = field.domain.split('.').slice(strip);
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      node = (node[segment] ??= {}) as Tree;
    }
    node[segments.at(-1) as string] = field;
  }
  return root;
}

function schemaOfTree(tree: Tree, part: Part): Schema<unknown> {
  return object(Object.fromEntries(Object.entries(tree).map(([key, node]) => [key, part('legacy' in node ? kindSchema(node as SettingField) : schemaOfTree(node as Tree, part))])));
}

/**
 * The schema of a settings block: an object of the keys of the block (nested like the representation), every key required for a whole block (`PUT`) or optional for a modification (`part`).
 * Texts are bounded, numbers have a range, lists and maps a number of elements, and a map keyed by currency, language or price list refuses operators, paths and prototype keys.
 *
 * @param name The domain name of the block (`cashSettings`, `printing`…).
 * @param part {@link required} or {@link partial}.
 */
export function settingsSchema<T = Record<string, unknown>>(name: string, part: Part): Schema<T> {
  // Every domain path starts with the name of its block: the tree is built from the segments below it (`printing` has three objects there: `receipt`, `prebilling`, `ordering`).
  return schemaOfTree(treeOf(SETTING_BLOCKS[name] as readonly SettingField[], 1), part) as unknown as Schema<T>;
}

/** The path segment of the `PUT` of each settings block, after `/groups/{groupId}/places/{placeId}/`. */
export const SETTING_SEGMENTS: Readonly<Record<string, string>> = Object.freeze({
  cashSettings: 'settings/cash',
  printing: 'settings/printing',
  payments: 'settings/payments',
  tables: 'settings/tables',
  reservations: 'settings/reservations',
  delivery: 'settings/delivery',
  selfOrdering: 'settings/self-ordering',
  kiosk: 'settings/kiosk',
  appointments: 'settings/appointments',
  externalDisplay: 'settings/external-display',
  fidelity: 'settings/fidelity',
  tobacco: 'settings/tobacco',
  media: 'media',
});
