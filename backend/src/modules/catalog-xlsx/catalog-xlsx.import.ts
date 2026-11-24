import { isDeepStrictEqual } from 'node:util';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { validate } from '../../shared/validation/schema.ts';
import { flagOf, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { objectIdsValue, plainOf, wholeValue } from '../product-categories/categories.mapper.ts';
import { placesOf } from '../product-categories/categories.availability.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import type { CategoriesService } from '../product-categories/categories.service.ts';
import { createCategoryBody, patchCategoryBody } from '../product-categories/categories.schemas.ts';
import { stationsOf } from '../product-categories/categories.mapper.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { productPlacesOf } from '../products/products.availability.ts';
import { MODIFIER_CODES, idsOf } from '../products/products.mapper.ts';
import type { PriceInput } from '../products/products.pricing.ts';
import { pricesOf } from '../products/products.pricing.ts';
import type { ProductsService } from '../products/products.service.ts';
import { createProductBody, patchProductBody } from '../products/products.schemas.ts';
import { PRICE_SLOTS } from './catalog-xlsx.columns.ts';
import type { PlaceColumn, SheetKind } from './catalog-xlsx.columns.ts';
import { ErrorCollector } from './catalog-xlsx.errors.ts';
import type { RowError } from './catalog-xlsx.errors.ts';
import type { Refs } from './catalog-xlsx.export.ts';
import type { ParsedSheet, ParsedWorkbook } from './catalog-xlsx.parse.ts';
import { baseRuleIndex } from './catalog-xlsx.prices.ts';
import type { CatalogPlace } from './catalog-xlsx.repository.ts';
import { RowReader } from './catalog-xlsx.row.ts';
import { VARIANT_TYPES, decimalOf, recognizeByIdOrName, recognizeColor, recognizeFlag, recognizeRate, recognizeScaleType, recognizeWhole, referencesOf } from './catalog-xlsx.rules.ts';
import type { Recognized } from './catalog-xlsx.rules.ts';

/** What the import reads of the group besides the file: the references of the catalog and the currency of a new price. */
export interface ImportRefs extends Refs {
  /** The currency of the prices the import creates: the euro when the group has it, else the first currency of the group. */
  readonly currency: string;
}

/** The services of the catalog an import calls, built over the session of the transaction, and the reads it needs. */
export interface ImportGraph {
  readonly products: Pick<ProductsService, 'create' | 'update' | 'trash'>;
  readonly categories: Pick<CategoriesService, 'create' | 'update' | 'remove'>;
  /** A product the caller reaches (not in the trash or in it), `null` for none. */
  findProduct(principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /** A category the caller reaches, `null` for none. */
  findCategory(principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  productVersion(document: Document): string;
  categoryVersion(document: Document): string;
  /** The id the next category created gets: the import names the categories of the file before it creates them (so any row can refer to them), and says the id of each one just before it creates it. */
  useCategoryId(id: ObjectId): void;
  /** The references of the group for the caller. */
  loadRefs(principal: CatalogCaller, access: GroupAccess): Promise<ImportRefs>;
}

/** The counts of one sheet: the documents really written. */
export interface SheetCounts {
  inserted: number;
  updated: number;
  /** Products moved to the trash, categories deleted. */
  removed: number;
  unchanged: number;
}

/** What an import did (or, with `dryRun`, would do) and the problems it found. */
export interface ImportReport {
  readonly sheets: Readonly<Record<SheetKind, SheetCounts>>;
  readonly errors: readonly RowError[];
  readonly errorCount: number;
}

/** What an import is run with. */
export interface ImportInput {
  readonly graph: ImportGraph;
  readonly principal: CatalogCaller;
  readonly access: GroupAccess;
  readonly client: ClientContext;
  readonly workbook: ParsedWorkbook;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** The time, in epoch milliseconds, after which the import is stopped. */
  readonly deadline: number;
}

type Body = Record<string, unknown>;

/** The language of every text the workbook reads and writes. */
const LANGUAGE = 'it';

/** The column a field the services refuse belongs to, by the start of the path of the field. */
const FIELD_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['name', 'name'],
  ['shortName', 'shortName'],
  ['description', 'description'],
  ['shortDescription', 'shortDescription'],
  ['categoryIds', 'categories'],
  ['modifierCategoryIds', 'modifierCategories'],
  ['parentId', 'parent'],
  ['barcodes', 'barcode'],
  ['plu', 'plu'],
  ['code', 'code'],
  ['position', 'position'],
  ['scaleType', 'scaleType'],
  ['availability.pos', 'pos'],
  ['availability.warehouse', 'warehouse'],
  ['availability.scales', 'scales'],
  ['availability.ecommerce', 'ecommerce'],
  ['favoriteHandheld', 'favoriteHandheld'],
  ['favorite', 'favorite'],
  ['backgroundColor', 'color'],
  ['modifier', 'type'],
];

/** The key of the column a field belongs to, `null` when it is not of one fixed column. */
export function columnOfField(field: string): string | null {
  return FIELD_COLUMNS.find(([start]) => field === start || field.startsWith(`${start}.`) || field.startsWith(`${start}[`))?.[1] ?? null;
}

/** Records the problems a service refused a row with, one error for each detail. Anything that is not a refusal of the catalog is not a problem of the row: it is rethrown. */
function refusal(error: unknown, rv: RowReader): void {
  if (!(error instanceof AppError)) {
    throw error;
  }
  const details = error.details ?? [];
  const codes = { VALIDATION_ERROR: 'invalid', FORBIDDEN: 'forbidden', CONFLICT: 'conflict', NOT_FOUND: 'notFound', PRECONDITION_FAILED: 'conflict' } as const;
  const code = codes[error.code as keyof typeof codes];
  if (code === undefined) {
    throw error;
  }
  if (details.length === 0) {
    rv.fail(null, code);
  }
  for (const detail of details.slice(0, 5)) {
    rv.fail(columnOfField(detail.field), code, `${detail.field}: ${detail.issue}`);
  }
}

/** Runs a call of the catalog, turning a refusal into problems of the row. */
async function attempt<T>(rv: RowReader, call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    refusal(error, rv);
    return undefined;
  }
}

/** The result of recognizing a reference, recorded as a problem of the row when it is not found. */
function found<T>(rv: RowReader, column: string, result: Recognized<T>): T | null {
  if (result.kind === 'found') {
    return result.value;
  }
  rv.fail(column, result.kind === 'none' ? 'notFoundReference' : 'ambiguousName');
  return null;
}

/** The ids a cell of references stands for (id or name, separated by `|`), without repetitions; `null` when one is a problem. */
function idsOfCell(rv: RowReader, column: string, cell: string, items: readonly { readonly id: string; readonly name: string }[]): string[] | null {
  const ids: string[] = [];
  let valid = true;
  for (const token of referencesOf(cell)) {
    const item = found(rv, column, recognizeByIdOrName(token, items));
    if (item === null) {
      valid = false;
    } else if (!ids.includes(item.id)) {
      ids.push(item.id);
    }
  }
  return valid ? ids : null;
}

/** Sets a text by language of the workbook: only when it differs, an empty cell takes the text away (`null`), a required one is never empty. */
function setText(rv: RowReader, body: Body, key: string, field: string, stored: Document | null, required: boolean): void {
  const value = rv.text(key);
  if (value === undefined) {
    return;
  }
  const current = stored === null ? '' : (textOf(valueAt(stored, `${field}.${LANGUAGE}`)) ?? '');
  if (value === '' && required) {
    rv.fail(key, 'required');
  } else if (value !== current) {
    body[field] = { [LANGUAGE]: value === '' ? null : value };
  }
}

/**
 * Sets a flag of the body from a column that is present: an empty cell is "no" for a new element (it is written, so the default of the service does not apply) and for an existing one (written when it differs).
 * A column that is absent never reaches here. A "no" for a function the group lacks is not written (it would be refused for nothing, and the flag is off anyway); an `X` for it is, and the service refuses it.
 */
function setFlag(rv: RowReader, key: string, stored: Document | null, path: string, functionOn: boolean, assign: (value: boolean) => void): void {
  const cell = rv.text(key);
  if (cell === undefined) {
    return;
  }
  const value = recognizeFlag(cell);
  if (value === null) {
    rv.fail(key, 'invalidValue');
  } else if (stored === null ? value || functionOn : value !== flagOf(valueAt(stored, path))) {
    assign(value);
  }
}

/** Sets a position: empty is none. */
function setPosition(rv: RowReader, body: Body, stored: Document | null): void {
  const cell = rv.text('position');
  if (cell === undefined) {
    return;
  }
  const value = cell === '' ? null : recognizeWhole(cell);
  if (cell !== '' && value === null) {
    rv.fail('position', 'invalidValue');
  } else if (value !== (stored === null ? null : wholeValue(stored['position']))) {
    body['position'] = value;
  }
}

/** A nested object of a body, created when needed. */
function nested(body: Body, key: string): Body {
  const existing = body[key];
  if (typeof existing === 'object' && existing !== null) {
    return existing as Body;
  }
  const created: Body = {};
  body[key] = created;
  return created;
}

/** A point of sale column of a sheet, with the point of sale it names. */
export interface ResolvedPlaceColumn {
  readonly column: PlaceColumn;
  readonly place: CatalogPlace;
}

/** Resolves the columns of the points of sale by name: one that names no point of sale of the perimeter, or more than one, is a problem of the sheet (named after the column). */
function resolvePlaceColumns(sheet: ParsedSheet, refs: ImportRefs, errors: ErrorCollector): ResolvedPlaceColumn[] {
  const resolved: ResolvedPlaceColumn[] = [];
  for (const column of sheet.header.places) {
    const matches = refs.places.filter((place) => place.name === column.placeName);
    if (matches.length === 1) {
      resolved.push({ column, place: matches[0]! });
    } else {
      errors.add(sheet.kind, null, column.header, matches.length === 0 ? 'unknownPlace' : 'ambiguousPlace');
    }
  }
  return resolved;
}

/** The identity of a row: the id cell, validated, and the deletion mark. `null` id is a new element. */
function identity(rv: RowReader, seen: Set<string>): { readonly id: ObjectId | null; readonly remove: boolean } {
  const cell = rv.text('id') ?? '';
  const mark = rv.text('delete');
  const remove = mark === undefined ? false : recognizeFlag(mark);
  if (remove === null) {
    rv.fail('delete', 'invalidValue');
  }
  if (cell === '') {
    if (remove === true) {
      rv.fail('delete', 'deleteWithoutId');
    }
    return { id: null, remove: false };
  }
  const lower = cell.toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(lower)) {
    rv.fail('id', 'invalidId');
    return { id: null, remove: false };
  }
  if (seen.has(lower)) {
    rv.fail('id', 'duplicateId');
  }
  seen.add(lower);
  return { id: ObjectId.createFromHexString(lower), remove: remove === true };
}

/** The places of a product or a category after the columns of the points of sale: the entries of the places that are not in a column stay, the ones with an `X` are added (or kept as they are), the others go. */
function nextPlaces<T extends { readonly placeId: string }>(rv: RowReader, columns: readonly ResolvedPlaceColumn[], stored: readonly T[], allowed: ReadonlySet<string> | null, blank: (placeId: string) => T): T[] | null {
  // A company or place administrator sends only the entries of his own perimeter: the others stay stored, as with a `PATCH` of the product.
  const current = allowed === null ? stored : stored.filter((entry) => allowed.has(entry.placeId));
  const available = columns.filter(({ column }) => column.kind === 'DISPO');
  if (available.length === 0) {
    return null;
  }
  const named = new Set(available.map(({ place }) => place.id));
  const wanted = new Set<string>();
  for (const { column, place } of available) {
    const flag = recognizeFlag(rv.placeText(column));
    if (flag === null) {
      rv.fail(column.header, 'invalidValue');
    } else if (flag) {
      wanted.add(place.id);
    }
  }
  const kept = current.filter((entry) => !named.has(entry.placeId) || wanted.has(entry.placeId));
  const added = [...wanted].filter((placeId) => !current.some((entry) => entry.placeId === placeId)).map(blank);
  const next = [...kept, ...added];
  return isDeepStrictEqual(next, current) ? null : next;
}

/** The ids of the stations a column names, `null` when one is a problem. */
function stationsOfCell(rv: RowReader, column: PlaceColumn, place: CatalogPlace): string[] | null {
  const ids: string[] = [];
  let valid = true;
  for (const name of referencesOf(rv.placeText(column))) {
    const matches = place.stations.filter((station) => station.name === name);
    if (matches.length === 1) {
      if (!ids.includes(matches[0]!.id)) {
        ids.push(matches[0]!.id);
      }
    } else {
      rv.fail(column.header, matches.length === 0 ? 'unknownStation' : 'ambiguousName');
      valid = false;
    }
  }
  return valid ? ids : null;
}

/** The prices of a row: the triples of the workbook, applied to the rule each price list has; `undefined` when nothing changes or the row has a problem. Nothing is ever taken away. */
function priceInputs(rv: RowReader, refs: ImportRefs, stored: Document | null): PriceInput[] | undefined {
  const slots: Array<{ readonly listId: string; readonly taxId: string; readonly gross: number }> = [];
  const views = pricesOf(stored?.['prices']);
  for (let n = 1; n <= PRICE_SLOTS; n += 1) {
    const keys = [`list${String(n)}`, `price${String(n)}`, `tax${String(n)}`] as const;
    const cells = keys.map((key) => rv.text(key));
    if (cells.every((cell) => cell === undefined || cell === '')) {
      continue;
    }
    const missing = keys.find((_, index) => cells[index] === undefined || cells[index] === '');
    if (missing !== undefined) {
      rv.fail(missing, 'incompletePrice');
      continue;
    }
    const list = found(rv, keys[0], recognizeByIdOrName(cells[0]!, refs.priceLists));
    const gross = decimalOf(cells[1]!);
    if (gross === null) {
      rv.fail(keys[1], 'invalidValue');
    }
    const currentTax = list === null ? null : (views[baseRuleIndex(views, list.id)]?.taxId ?? null);
    const tax = found(rv, keys[2], recognizeRate(cells[2]!, refs.taxes, currentTax));
    if (list !== null && gross !== null && tax !== null) {
      if (slots.some((slot) => slot.listId === list.id)) {
        rv.fail(keys[0], 'duplicatePriceList');
      } else {
        slots.push({ listId: list.id, taxId: tax.id, gross });
      }
    }
  }
  if (slots.length === 0 || rv.failed) {
    return undefined;
  }
  const inputs: PriceInput[] = [];
  for (const view of views) {
    if (view.priceListId === null || view.currency === null || view.taxId === null || (view.gross === null && view.net === null)) {
      rv.fail('list1', 'notRepresentable');
      return undefined;
    }
    inputs.push({
      id: view.id,
      priceListId: view.priceListId,
      currency: view.currency,
      taxId: view.taxId,
      ...(view.gross === null ? { net: view.net! } : { gross: view.gross }),
      ...(view.discount === null ? {} : { discount: view.discount }),
      validFrom: view.validFrom,
      validTo: view.validTo,
      dailyFrom: view.dailyFrom,
      dailyTo: view.dailyTo,
      weekDays: [...view.weekDays],
      fromQuantity: view.fromQuantity,
      maxSaleQuantity: view.maxSaleQuantity,
    });
  }
  let changed = false;
  for (const slot of slots) {
    const index = baseRuleIndex(views, slot.listId);
    if (index === -1) {
      inputs.push({ priceListId: slot.listId, currency: refs.currency, taxId: slot.taxId, gross: slot.gross });
      changed = true;
    } else if (views[index]!.gross !== slot.gross || views[index]!.taxId !== slot.taxId) {
      const { net: _net, ...rest } = inputs[index]!;
      inputs[index] = { ...rest, taxId: slot.taxId, gross: slot.gross };
      changed = true;
    }
  }
  return changed ? inputs : undefined;
}

/** The barcodes of a row: the first barcode is the one of the cell, the others (and the quantities of the barcodes) stay. */
function barcodeList(rv: RowReader, stored: Document | null, warehouse: boolean): Array<Record<string, unknown>> | undefined {
  const value = rv.text('barcode');
  if (value === undefined) {
    return undefined;
  }
  const current = (Array.isArray(stored?.['barcode']) ? (stored['barcode'] as unknown[]) : []).flatMap((item) => (typeof item === 'object' && item !== null && typeof (item as Document)['value'] === 'string' ? [item as Document] : []));
  if ((current[0]?.['value'] ?? '') === value) {
    return undefined;
  }
  const entry = (item: Document): Record<string, unknown> => {
    const load = plainOf(item['qtLoad']);
    const sale = plainOf(item['qtSale']);
    return { value: item['value'] as string, ...(warehouse && typeof load === 'number' ? { loadQuantity: load } : {}), ...(typeof sale === 'number' ? { saleQuantity: sale } : {}) };
  };
  const moved = current.find((item) => item['value'] === value);
  const rest = current.filter((item, index) => index > 0 && item['value'] !== value).map(entry);
  return value === '' ? rest : [moved === undefined ? { value } : entry(moved), ...rest];
}

/** The body of a product (or variant) row: only what the row changes. */
function productBody(rv: RowReader, refs: ImportRefs, access: GroupAccess, allowed: ReadonlySet<string> | null, columns: readonly ResolvedPlaceColumn[], stored: Document | null): Body {
  const body: Body = {};
  const creating = stored === null;
  setText(rv, body, 'name', 'name', stored, true);
  if (creating && body['name'] === undefined && rv.text('name') === undefined) {
    rv.fail('name', 'required');
  }
  setText(rv, body, 'shortName', 'shortName', stored, false);
  setText(rv, body, 'description', 'description', stored, false);
  setText(rv, body, 'shortDescription', 'shortDescription', stored, false);
  setPosition(rv, body, stored);
  const categories = rv.text('categories');
  if (categories !== undefined) {
    const ids = idsOfCell(rv, 'categories', categories, refs.categories);
    const current = stored === null ? [] : idsOf(stored['categories']);
    if (ids !== null && !(ids.length === current.length && ids.every((id) => current.includes(id)))) {
      body['categoryIds'] = ids;
    }
  }
  const prices = priceInputs(rv, refs, stored);
  if (prices !== undefined) {
    body['prices'] = prices;
  }
  setFlag(rv, 'pos', stored, 'availability.pos', access.features.cash, (value) => (nested(body, 'availability')['pos'] = value));
  setFlag(rv, 'warehouse', stored, 'availability.warehouse', access.features.warehouse, (value) => (nested(body, 'availability')['warehouse'] = value));
  setFlag(rv, 'scales', stored, 'availability.scales', access.features.scales, (value) => (nested(body, 'availability')['scales'] = value));
  setFlag(rv, 'ecommerce', stored, 'availability.ecommerce', access.features.customersApp, (value) => (nested(body, 'availability')['ecommerce'] = value));
  setFlag(rv, 'favorite', stored, 'favorite', true, (value) => (body['favorite'] = value));
  setFlag(rv, 'favoriteHandheld', stored, 'favoriteHandheld', access.features.rooms, (value) => (body['favoriteHandheld'] = value));
  const plu = rv.text('plu');
  if (plu !== undefined && plu !== (textOf(stored?.['plu']) ?? '')) {
    body['plu'] = plu === '' ? null : plu;
  }
  const scale = rv.text('scaleType');
  if (scale !== undefined) {
    const kind = recognizeScaleType(scale);
    const current = stored === null ? null : plainOf(stored['scaleType']);
    const wanted = kind === '' ? (current === 0 ? 'piece' : null) : kind;
    if (kind === null) {
      rv.fail('scaleType', 'invalidValue');
    } else if (wanted !== null && wanted !== (current === 0 ? 'weight' : current === 1 ? 'piece' : null)) {
      body['scaleType'] = wanted;
    }
  }
  const code = rv.text('code');
  if (code !== undefined && code !== (textOf(stored?.['code']) ?? '')) {
    body['code'] = code;
  }
  const barcodes = barcodeList(rv, stored, access.features.warehouse);
  if (barcodes !== undefined) {
    body['barcodes'] = barcodes;
  }
  const type = rv.text('type');
  if (type !== undefined && type !== '') {
    const kind = VARIANT_TYPES.get(type.toLowerCase());
    if (kind === undefined) {
      rv.fail('type', 'invalidValue');
    } else if (MODIFIER_CODES[kind] !== valueAt(stored ?? {}, 'variant.type')) {
      body['modifier'] = { type: kind };
    }
  }
  const places = nextPlaces(rv, columns, productPlacesOf(stored?.['placesAvailability']).entries, allowed, (placeId) => ({ placeId, favorite: false, favoriteHandheld: false, position: null, productionCenterId: null }));
  if (places !== null) {
    body['places'] = places.map((entry) => ({ placeId: entry.placeId, favorite: entry.favorite, favoriteHandheld: entry.favoriteHandheld, position: entry.position, productionCenterId: entry.productionCenterId }));
  }
  return body;
}

/** The body of a category row. With `deferred` the references to other categories (parent and categories of modifiers) are left out: they are applied once every category of the file exists. */
function categoryBody(rv: RowReader, refs: ImportRefs, access: GroupAccess, allowed: ReadonlySet<string> | null, columns: readonly ResolvedPlaceColumn[], stored: Document | null, deferred: boolean): Body {
  const body: Body = {};
  // (A new category always has a name here: a row with none is refused before the category is created.)
  setText(rv, body, 'name', 'name', stored, true);
  setText(rv, body, 'description', 'description', stored, false);
  setPosition(rv, body, stored);
  setFlag(rv, 'pos', stored, 'availability.pos', access.features.cash, (value) => (nested(body, 'availability')['pos'] = value));
  const color = rv.text('color');
  if (color !== undefined) {
    const value = recognizeColor(color);
    if (value === null) {
      rv.fail('color', 'invalidValue');
    } else if (value !== '' && value !== (stored === null ? null : (typeof stored['backgroundColor'] === 'string' ? stored['backgroundColor'].toLowerCase() : null))) {
      body['backgroundColor'] = value;
    }
  }
  if (!deferred) {
    const parent = rv.text('parent');
    if (parent !== undefined) {
      const item = parent === '' ? null : found(rv, 'parent', recognizeByIdOrName(parent, refs.categories));
      const current = stored !== null && stored['parentId'] instanceof ObjectId ? stored['parentId'].toHexString() : null;
      if ((parent === '' || item !== null) && (item?.id ?? null) !== current) {
        body['parentId'] = item?.id ?? null;
      }
    }
    const modifiers = rv.text('modifierCategories');
    if (modifiers !== undefined) {
      const ids = idsOfCell(rv, 'modifierCategories', modifiers, refs.categories);
      // (A row applied here always has a stored category: the creations are applied with `deferred`.)
      const current = objectIdsValue(stored?.['variantsCategories']);
      if (ids !== null && !(ids.length === current.length && ids.every((id) => current.includes(id)))) {
        body['modifierCategoryIds'] = ids;
      }
    }
  }
  const places = nextPlaces(rv, columns, placesOf(stored?.['placesAvailability']).entries, allowed, (placeId) => ({ placeId, position: null, productionCenterId: null }));
  if (places !== null) {
    body['places'] = places.map((entry) => ({ placeId: entry.placeId, position: entry.position, productionCenterId: entry.productionCenterId }));
  }
  for (const [kind, field, path] of [['SALA', 'printStations', 'printStations'], ['BANCO', 'counterPrintStations', 'printStationsNoRooms']] as const) {
    const current = stationsOf(stored?.[path], null);
    for (const { column, place } of columns.filter((item) => item.column.kind === kind)) {
      const ids = stationsOfCell(rv, column, place);
      if (ids !== null && !isDeepStrictEqual(current[place.id] ?? [], ids)) {
        nested(body, field)[place.id] = ids;
      }
    }
  }
  return body;
}

/** The counts of a sheet at the start. */
const blank = (): SheetCounts => ({ inserted: 0, updated: 0, removed: 0, unchanged: 0 });

/**
 * Runs the import over the workbook, **inside a transaction the caller owns** (the writes go through the services of the catalog, which hold every rule of the catalog: the perimeter of the company and place
 * administrators, the single store, the functions of the group, the references, the limits; the transaction is what makes the file all or nothing). The order is: the categories (created first, so the others can
 * refer to them by name, then updated with their references), the variants, the products, and last the deletion of the categories (so a category can be deleted in the file that moves its products away).
 * Every row is checked and tried; the problems of all of them are collected (a sheet with a problem in its header is not read at all). Nothing is committed here: the caller aborts the transaction when the report has problems or the request is a dry run.
 *
 * @param input The services, the caller, the workbook and the deadline.
 * @returns The counts of the documents written and the problems.
 * @throws {AppError} `PAYLOAD_TOO_LARGE` when the deadline passes; any error that is not a refusal of the catalog (a database failure, a transient transaction error) as it is.
 */
export async function runImport(input: ImportInput): Promise<ImportReport> {
  const { graph, principal, access, client, workbook } = input;
  const errors = new ErrorCollector();
  const counts: Record<SheetKind, SheetCounts> = { products: blank(), variants: blank(), categories: blank() };
  const allowed = perimeterOf(principal);
  const refs = await graph.loadRefs(principal, access);
  const categories: Array<{ id: string; name: string }> = [...refs.categories];
  const live: ImportRefs = { ...refs, categories };
  const sheets = new Map<SheetKind, { readonly sheet: ParsedSheet; readonly columns: ResolvedPlaceColumn[] }>();
  for (const sheet of workbook.sheets) {
    for (const problem of sheet.header.problems) {
      errors.add(sheet.kind, null, problem.column, problem.code);
    }
    const before = errors.count;
    const columns = resolvePlaceColumns(sheet, live, errors);
    if (errors.count === before) {
      sheets.set(sheet.kind, { sheet, columns });
    }
  }
  const tick = (): void => {
    if (input.now() > input.deadline) {
      throw new AppError('PAYLOAD_TOO_LARGE', { message: 'The import takes too long: split the file' });
    }
  };
  const readers = (kind: SheetKind): RowReader[] => {
    const entry = sheets.get(kind);
    return entry === undefined ? [] : entry.sheet.rows.map((row) => new RowReader(entry.sheet, row, errors));
  };

  // The categories: the ones the file creates are named first (so any row can refer to them), then created, then every row is applied.
  const categoryColumns = sheets.get('categories')?.columns ?? [];
  const seenCategories = new Set<string>();
  const categoryRows = readers('categories').map((rv) => ({ rv, ...identity(rv, seenCategories), newId: null as ObjectId | null, created: false }));
  for (const item of categoryRows) {
    if (item.id === null && !item.rv.failed) {
      const name = item.rv.text('name') ?? '';
      if (name === '') {
        item.rv.fail('name', 'required');
      } else {
        item.newId = new ObjectId();
        categories.push({ id: item.newId.toHexString(), name });
      }
    }
  }
  const categoryTarget = async (item: (typeof categoryRows)[number]): Promise<Document | null> => {
    const document = await graph.findCategory(principal, access, item.id ?? item.newId!);
    if (document === null) {
      item.rv.fail('id', 'notFound');
    }
    return document;
  };
  for (const item of categoryRows) {
    tick();
    if (errors.full || item.rv.failed || item.newId === null) {
      continue;
    }
    const body = categoryBody(item.rv, live, access, allowed, categoryColumns, null, true);
    if (item.rv.failed) {
      continue;
    }
    graph.useCategoryId(item.newId);
    const result = await attempt(item.rv, () => graph.categories.create(principal, access, validate(createCategoryBody, body, '(row)'), client));
    if (result !== undefined) {
      item.created = true;
      counts.categories.inserted += 1;
    }
  }
  for (const item of categoryRows) {
    tick();
    if (errors.full || item.rv.failed || item.remove || (item.id === null && !item.created)) {
      continue;
    }
    const stored = await categoryTarget(item);
    if (stored === null) {
      continue;
    }
    const body = categoryBody(item.rv, live, access, allowed, categoryColumns, stored, false);
    if (item.rv.failed) {
      continue;
    }
    if (Object.keys(body).length === 0) {
      counts.categories.unchanged += item.created ? 0 : 1;
      continue;
    }
    const version = graph.categoryVersion(stored);
    const result = await attempt(item.rv, () => graph.categories.update(principal, access, stored['_id'] as ObjectId, version, validate(patchCategoryBody, body, '(row)'), client));
    if (result !== undefined && !item.created) {
      counts.categories[result.version === version ? 'unchanged' : 'updated'] += 1;
    }
  }

  // The variants and the products.
  for (const kind of ['variants', 'products'] as const) {
    const columns = sheets.get(kind)?.columns ?? [];
    const seen = new Set<string>();
    for (const rv of readers(kind)) {
      tick();
      if (errors.full) {
        break;
      }
      const { id, remove } = identity(rv, seen);
      if (rv.failed) {
        continue;
      }
      let stored: Document | null = null;
      if (id !== null) {
        stored = await graph.findProduct(principal, access, id);
        if (stored === null) {
          rv.fail('id', 'notFound');
        } else if (stored['trash'] === true) {
          rv.fail('id', 'trashed');
        } else if ((valueAt(stored, 'variant.status') === true) !== (kind === 'variants')) {
          rv.fail('id', 'wrongSheet');
        } else if (['tobaccos', 'games', 'monopoly'].includes(stored['type'] as string)) {
          rv.fail('id', 'notImportable');
        }
        if (rv.failed) {
          continue;
        }
      }
      if (remove) {
        const version = graph.productVersion(stored!);
        if ((await attempt(rv, () => graph.products.trash(principal, access, id!, version, client))) !== undefined) {
          counts[kind].removed += 1;
        }
        continue;
      }
      const body = productBody(rv, live, access, allowed, columns, stored);
      if (kind === 'variants' && stored === null) {
        body['isModifier'] = true;
      }
      if (rv.failed) {
        continue;
      }
      if (stored === null) {
        if ((await attempt(rv, () => graph.products.create(principal, access, validate(createProductBody, body, '(row)'), client))) !== undefined) {
          counts[kind].inserted += 1;
        }
      } else if (Object.keys(body).length === 0) {
        counts[kind].unchanged += 1;
      } else {
        const version = graph.productVersion(stored);
        const result = await attempt(rv, () => graph.products.update(principal, access, id!, version, validate(patchProductBody, body, '(row)'), client));
        if (result !== undefined) {
          counts[kind][result.version === version ? 'unchanged' : 'updated'] += 1;
        }
      }
    }
  }

  // The deletion of the categories.
  for (const item of categoryRows) {
    tick();
    if (errors.full || item.rv.failed || !item.remove) {
      continue;
    }
    // `remove` answers nothing: the call is made a value (`true`) so that a refusal (`undefined`) is told from a deletion.
    if ((await attempt(item.rv, async () => (await graph.categories.remove(principal, access, item.id!, client), true))) === true) {
      counts.categories.removed += 1;
    }
  }
  return { sheets: counts, errors: errors.errors, errorCount: errors.count };
}
