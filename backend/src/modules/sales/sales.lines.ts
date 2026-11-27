import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { LooseObject } from './sales.write.schemas.ts';

/** What the rule of one field of a line says: its type and, for a text, how long it may be. A value of another type is dropped, never an error: a sale of the till is not refused for a field. */
export type FieldRule =
  | { readonly type: 'text'; readonly max: number }
  | { readonly type: 'number'; readonly max: number }
  | { readonly type: 'boolean' }
  | { readonly type: 'scalar' }
  | { readonly type: 'localized' }
  /** A text the electronic invoice may carry (basic Latin and Latin-1 supplement, no control character and none of `<`, `>`, `&`), of at most `max` characters: anything else is dropped. */
  | { readonly type: 'safeText'; readonly max: number }
  /** A real calendar date as `YYYY-MM-DD`; anything else is dropped. */
  | { readonly type: 'date' }
  | { readonly type: 'object'; readonly fields: Readonly<Record<string, FieldRule>> }
  /** A list of objects: the first `max` elements that keep at least one field, each reduced by `item`. */
  | { readonly type: 'list'; readonly max: number; readonly item: Readonly<Record<string, FieldRule>> };

/** The characters an electronic invoice allows in a text, without the ones that mean something in XML (`<`, `>`, `&`): the consumers put the value in the file as it is. */
export const SAFE_TEXT = /^[\u0020-\u0025\u0027-\u003B\u003D\u003F-\u007E\u00A0-\u00FF]+$/;

/** Whether a text is a real calendar date written `YYYY-MM-DD`. */
export const isCalendarDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

const TEXT = (max = 100): FieldRule => ({ type: 'text', max });

/** Largest quantity (in absolute value) of a line, of a modifier or of a selection of a menu: a number beyond it is a mistake of the till, never a quantity the warehouse should move. */
export const MAX_QUANTITY = 1_000_000;

/** Largest price or rate (in absolute value) of a line. */
export const MAX_AMOUNT = 1_000_000_000;

const QT: FieldRule = { type: 'number', max: MAX_QUANTITY };
const MONEY: FieldRule = { type: 'number', max: MAX_AMOUNT };

/**
 * The allowlist of the fields of a line that come from the client: **the one table to extend** to save one more field of the product the till sends (it is added here on the server, with no change to the clients installed).
 * Everything else the client sends is dropped. The identity of the product (id, code, name, type, categories, department), what the warehouse reads of the catalog (`availability.warehouse`, `bundleProducts`) and the costs are never
 * taken from here: they are read from the catalog in the database (`reduceLine`).
 */
export const LINE_FIELDS: Readonly<Record<string, FieldRule>> = Object.freeze({
  qt: QT,
  timestampId: TEXT(64),
  menuParentId: TEXT(64),
  variantParentId: TEXT(64),
  barcodeRead: TEXT(64),
  sent: { type: 'scalar' },
  sentBy: TEXT(24),
  discountPercentage: MONEY,
  halfPortion: { type: 'boolean' },
  generic: { type: 'boolean' },
  group: { type: 'scalar' },
  exit: { type: 'scalar' },
  scaleType: TEXT(32),
  availability: { type: 'object', fields: { scales: { type: 'boolean' } } },
  variant: { type: 'object', fields: { status: { type: 'boolean' } } },
  modularBundle: { type: 'object', fields: { priceRule: TEXT(32) } },
  // What the electronic invoice reads of a line (step VS5): the first of the other management data (`AltriDatiGestionali`), as the standard names them.
  XML: { type: 'object', fields: { AltriDatiGestionali: { type: 'list', max: 1, item: { TipoDato: { type: 'safeText', max: 10 }, RiferimentoTesto: { type: 'safeText', max: 60 }, RiferimentoData: { type: 'date' } } } } },
  price: {
    type: 'object',
    fields: {
      price: MONEY,
      taxed: MONEY,
      discount: MONEY,
      tax: MONEY,
      listId: TEXT(64),
      currency: TEXT(8),
      taxData: { type: 'object', fields: { id: TEXT(64), value: MONEY, natura: TEXT(16), description: TEXT(200), department: { type: 'scalar' } } },
    },
  },
});

/** The fields a modifier (an added, removed or noted product of a line) keeps from the client, besides the identity: the quantity and the price. */
const MODIFIER_FIELDS: Readonly<Record<string, FieldRule>> = Object.freeze({
  qt: QT,
  price: { type: 'object', fields: { price: MONEY, taxed: MONEY, tax: MONEY } },
});

/** The fields a selection of a modular menu keeps from the client, besides the identity: the quantity, already scaled by the till. */
const SELECTION_FIELDS: Readonly<Record<string, FieldRule>> = Object.freeze({ qt: QT });

/** The identity a modifier or a selection keeps from the client when the catalog does not have its product. */
const IDENTITY_FIELDS: Readonly<Record<string, FieldRule>> = Object.freeze({ code: TEXT(64), name: { type: 'localized' } });

/** The fields a free product (no id of the catalog) keeps from the client for its identity. */
const FREE_FIELDS: Readonly<Record<string, FieldRule>> = Object.freeze({ code: TEXT(64), name: { type: 'localized' }, departmentId: TEXT(64) });

/** A product of the catalog as the lines need it: read from the database with an allowlisted projection, never from the client. */
export interface CatalogProduct {
  readonly _id: ObjectId;
  readonly code: unknown;
  readonly name: unknown;
  readonly type: unknown;
  readonly categories: unknown;
  readonly departmentId: unknown;
  readonly trash: boolean;
  /** `availability.warehouse`: whether the product is kept in stock. */
  readonly warehouse: boolean;
  readonly bundleProducts: readonly { readonly _id: ObjectId; readonly quantity: unknown; readonly waste: unknown }[];
  readonly simpleCost: unknown;
  readonly averagePrice: unknown;
  readonly percentageFee: unknown;
}

/** What was found wrong in a line while it was reduced (the arithmetic and the tax rate are checked later, by `serverCheck`). */
export type LineIssue = 'productMissing' | 'productTrashed' | 'quantityMissing' | 'priceMissing';

const ID = /^[0-9a-fA-F]{24}$/;

/** The text of a hexadecimal id, as the object id it names; `null` for anything else. */
export function idOfText(raw: unknown): ObjectId | null {
  return typeof raw === 'string' && ID.test(raw) ? ObjectId.createFromHexString(raw) : null;
}

const isObject = (raw: unknown): raw is LooseObject => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** A text cut to a safe length, `null` for anything that is not a text. */
const textOf = (raw: unknown, max: number): string | null => (typeof raw === 'string' ? raw.slice(0, max) : null);

/** A name by language (`{ it: 'Pizza' }`): at most 20 languages of at most 200 characters, `null` for anything else. */
function localizedOf(raw: unknown): Document | null {
  if (!isObject(raw)) {
    return null;
  }
  const entries = Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})?$/.test(entry[0])).slice(0, 20);
  return entries.length === 0 ? null : Object.fromEntries(entries.map(([language, name]) => [language, name.slice(0, 200)]));
}

/**
 * Keeps of a value only what a table of rules allows, by type; what is missing or has another type is left out.
 *
 * @param rules The rules of the fields.
 * @param raw The value the client sent.
 * @returns A new object with the allowed fields, converted.
 */
export function reduceBy(rules: Readonly<Record<string, FieldRule>>, raw: unknown): Document {
  const reduced: Document = {};
  if (!isObject(raw)) {
    return reduced;
  }
  for (const [name, rule] of Object.entries(rules)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined;
    if (rule.type === 'text' && typeof value === 'string') {
      reduced[name] = value.slice(0, rule.max);
    } else if (rule.type === 'number' && typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= rule.max) {
      reduced[name] = value;
    } else if (rule.type === 'safeText' && typeof value === 'string' && value.length <= rule.max && SAFE_TEXT.test(value)) {
      reduced[name] = value;
    } else if (rule.type === 'date' && isCalendarDate(value)) {
      reduced[name] = value;
    } else if (rule.type === 'boolean' && typeof value === 'boolean') {
      reduced[name] = value;
    } else if (rule.type === 'scalar' && (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 100))) {
      reduced[name] = value;
    } else if (rule.type === 'localized' && localizedOf(value) !== null) {
      reduced[name] = localizedOf(value);
    } else if (rule.type === 'object' && isObject(value)) {
      const inner = reduceBy(rule.fields, value);
      if (Object.keys(inner).length > 0) {
        reduced[name] = inner;
      }
    } else if (rule.type === 'list' && Array.isArray(value)) {
      const items = (value as unknown[]).slice(0, rule.max).map((item) => reduceBy(rule.item, item)).filter((item) => Object.keys(item).length > 0);
      if (items.length > 0) {
        reduced[name] = items;
      }
    }
  }
  return reduced;
}

/** The ids of the catalog a body names: the products of its lines, its modifiers and its selections of menus, without repeats. */
export function productIdsOf(products: readonly LooseObject[]): ObjectId[] {
  const found = new Map<string, ObjectId>();
  const add = (raw: unknown): void => {
    const id = idOfText(raw);
    if (id !== null) {
      found.set(id.toHexString(), id);
    }
  };
  for (const product of products) {
    add(product['_id']);
    const variants = isObject(product['selectedVariants']) ? product['selectedVariants'] : {};
    for (const kind of ['plus', 'minus', 'info'] as const) {
      for (const variant of Array.isArray(variants[kind]) ? (variants[kind] as unknown[]) : []) {
        add(isObject(variant) ? variant['_id'] : undefined);
      }
    }
    const bundle = isObject(product['modularBundleSelected']) && Array.isArray(product['modularBundleSelected']['products']) ? (product['modularBundleSelected']['products'] as unknown[]) : [];
    for (const selection of bundle) {
      add(isObject(selection) ? selection['_id'] : undefined);
    }
  }
  return [...found.values()];
}

/** The identity of a product of the catalog, in the shape of a line. */
function identityOf(product: CatalogProduct): Document {
  return { _id: product._id, code: product.code, name: product.name, type: product.type };
}

/** The identity of a modifier or of a selection: the catalog when it has the product, else what the client said, reduced. */
function entryOf(raw: unknown, rules: Readonly<Record<string, FieldRule>>, catalog: ReadonlyMap<string, CatalogProduct>): Document | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = idOfText(raw['_id']);
  const found = id === null ? undefined : catalog.get(id.toHexString());
  const base = found === undefined ? { ...(id === null ? {} : { _id: id }), ...reduceBy(IDENTITY_FIELDS, raw) } : identityOf(found);
  return { ...base, ...reduceBy(rules, raw) };
}

/**
 * Reduces the product object a till sent in a line to what the sale saves: the allowlist of {@link LINE_FIELDS} from the client, and from the catalog in the database the identity (`_id`, `code`, `name`, `type`, `categories`,
 * `departmentId`), what the warehouse of the legacy reads on a return or a cancellation it makes (`availability.warehouse`, `bundleProducts`) and the costs at the date of the sale. A product the catalog does not have keeps the
 * identity the client gave (the sale is never lost) and is reported as `productMissing`. A line with no id, or marked `freeProduct`, is a free product: its name, code and department come from the client.
 *
 * @param raw The product object of the line, as validated (unknown fields included).
 * @param catalog The products of the catalog the body names, by hexadecimal id.
 * @returns The line to save and what was found wrong.
 */
export function reduceLine(raw: LooseObject, catalog: ReadonlyMap<string, CatalogProduct>): { readonly line: Document; readonly issues: LineIssue[] } {
  const issues: LineIssue[] = [];
  const id = idOfText(raw['_id']);
  const free = raw['freeProduct'] === true || id === null;
  const found = free || id === null ? undefined : catalog.get(id.toHexString());
  const line: Document = {};
  if (free) {
    Object.assign(line, { _id: id, freeProduct: true, ...reduceBy(FREE_FIELDS, raw) });
  } else if (found === undefined) {
    issues.push('productMissing');
    Object.assign(line, { _id: id, freeProduct: false, ...reduceBy(FREE_FIELDS, raw), code: textOf(raw['code'], 64) });
  } else {
    if (found.trash) {
      issues.push('productTrashed');
    }
    Object.assign(line, identityOf(found), {
      freeProduct: false,
      categories: Array.isArray(found.categories) ? found.categories : [],
      ...(found.departmentId === undefined || found.departmentId === null ? {} : { departmentId: found.departmentId }),
      availability: { warehouse: found.warehouse },
      bundleProducts: found.bundleProducts.map((component) => ({ _id: component._id, quantity: component.quantity, waste: typeof component.waste === 'number' ? component.waste : 0 })),
      ...(found.simpleCost === undefined || found.simpleCost === null ? {} : { simpleCost: found.simpleCost }),
      ...(found.averagePrice === undefined || found.averagePrice === null ? {} : { lastAveragePrice: { total: { averagePrice: found.averagePrice } } }),
      ...(found.percentageFee === undefined || found.percentageFee === null ? {} : { roomsSettings: { percentageFee: found.percentageFee } }),
    });
  }
  const fields = reduceBy(LINE_FIELDS, raw);
  const { availability, ...others } = fields;
  Object.assign(line, others);
  if (isObject(availability) && availability['scales'] === true) {
    line['availability'] = { ...(line['availability'] as Document | undefined), scales: true };
  }
  if (typeof line['qt'] !== 'number') {
    line['qt'] = 0;
    issues.push('quantityMissing');
  }
  const price = line['price'] as Document | undefined;
  if (typeof price?.['price'] !== 'number' || typeof price['taxed'] !== 'number') {
    issues.push('priceMissing');
  }
  /** An entry (modifier or selection) that sent a quantity the allowlist discarded: the line says so. */
  const noted = (raw: unknown, reduced: Document | null): void => {
    if (isObject(raw) && 'qt' in raw && reduced !== null && typeof reduced['qt'] !== 'number' && !issues.includes('quantityMissing')) {
      issues.push('quantityMissing');
    }
  };
  const variants = isObject(raw['selectedVariants']) ? raw['selectedVariants'] : null;
  if (variants !== null) {
    const selected: Document = {};
    for (const kind of ['plus', 'minus', 'info'] as const) {
      selected[kind] = (Array.isArray(variants[kind]) ? (variants[kind] as unknown[]) : []).flatMap((entry) => {
        const reduced = entryOf(entry, MODIFIER_FIELDS, catalog);
        noted(entry, reduced);
        return reduced ?? [];
      });
    }
    line['selectedVariants'] = selected;
  }
  const bundle = isObject(raw['modularBundleSelected']) && Array.isArray(raw['modularBundleSelected']['products']) ? (raw['modularBundleSelected']['products'] as unknown[]) : null;
  if (bundle !== null) {
    line['modularBundleSelected'] = { products: bundle
        .flatMap((entry) => {
          const reduced = entryOf(entry, SELECTION_FIELDS, catalog);
          noted(entry, reduced);
          return reduced ?? [];
        })
        .filter((selection) => selection['_id'] !== undefined),
    };
  }
  return { line, issues };
}

/** What the warehouse needs of a saved line, as the lines of `stock.reconcileOrigin` (`unit: 'sale'`). */
export interface StockEntry {
  readonly productId: string;
  readonly quantity: number;
  readonly unit: 'sale';
  readonly barcode?: string;
  readonly modularSelections?: readonly { readonly productId: string; readonly quantity: number }[];
}

const hexOf = (raw: unknown): string | null => (raw instanceof ObjectId ? raw.toHexString() : null);
const positiveNumber = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null);

/**
 * The lines the warehouse unloads and loads for the saved lines of a sale, net of what was returned: a line sold (quantity above zero) unloads what is left of it after the returns (`returned[i]` is the quantity returned of the line `i`,
 * never below zero left: a return above what was sold is an anomaly, not a negative unload), a line returned inside the same receipt (quantity below zero) loads. The modifiers added (`plus`) unload as products, the quantity of the modifier
 * times what is left of the line (the removed ones are not handled yet: decision 8 of step VS), and the selections of a modular menu go with their line, with the quantity the till already scaled, in proportion to what is left.
 * A free product has no stock. One entry per line, so the returns never add entries to the limit the warehouse reads.
 *
 * @param lines The saved lines of the sale.
 * @param returned The quantity returned of each line, by position (missing is zero).
 * @returns The lines to unload and to load.
 */
export function stockEntriesOf(lines: readonly Document[], returned: readonly number[] = []): { readonly unload: StockEntry[]; readonly load: StockEntry[] } {
  const unload: StockEntry[] = [];
  const load: StockEntry[] = [];
  lines.forEach((line, index) => {
    const productId = hexOf(line['_id']);
    const qt = typeof line['qt'] === 'number' && Number.isFinite(line['qt']) ? line['qt'] : 0;
    if (line['freeProduct'] === true || productId === null || qt === 0) {
      return;
    }
    const left = qt > 0 ? Math.max(qt - (returned[index] ?? 0), 0) : qt;
    if (left === 0) {
      return;
    }
    const ratio = left / qt;
    const barcode = typeof line['barcodeRead'] === 'string' && line['barcodeRead'] !== '' ? line['barcodeRead'] : undefined;
    const selections = ((line['modularBundleSelected'] as Document | undefined)?.['products'] as Document[] | undefined) ?? [];
    const modularSelections = selections.flatMap((selection) => {
      const id = hexOf(selection['_id']);
      const quantity = positiveNumber(selection['qt']);
      return id === null || quantity === null ? [] : [{ productId: id, quantity: quantity * ratio }];
    });
    (qt > 0 ? unload : load).push({ productId, quantity: Math.abs(left), unit: 'sale', ...(barcode === undefined ? {} : { barcode }), ...(modularSelections.length === 0 ? {} : { modularSelections }) });
    const plus = ((line['selectedVariants'] as Document | undefined)?.['plus'] as Document[] | undefined) ?? [];
    for (const variant of plus) {
      const id = hexOf(variant['_id']);
      const quantity = positiveNumber(variant['qt']);
      if (id !== null && quantity !== null) {
        (qt > 0 ? unload : load).push({ productId: id, quantity: quantity * Math.abs(left), unit: 'sale' });
      }
    }
  });
  return { unload, load };
}
