import { isDeepStrictEqual } from 'node:util';
import { Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { legacyLogoDescriptor, logo } from '../companies/company.mapper.ts';
import { flagOf, isRecord, recordsOf, textOf, valueAt } from '../groups/catalogs/kit.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import type { ReferencesRepository } from '../groups/catalogs/references.repository.ts';
import { currencies } from '../groups/catalogs/currencies.ts';
import type { Currency } from '../groups/catalogs/currencies.ts';
import { measureUnits } from '../groups/catalogs/measure-units.ts';
import type { MeasureUnit } from '../groups/catalogs/measure-units.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { taxes } from '../groups/catalogs/taxes.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';
import type { Feature } from '../groups/features.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import type { GroupLanguages } from '../product-catalog/group-languages.ts';
import { languageIssues, mergeTexts, requiredLanguage, textsOf } from '../product-catalog/texts.ts';
import { numberValue, plainOf, stationsOf, wholeValue } from '../product-categories/categories.mapper.ts';
import type { CategoryPlaces } from '../product-categories/categories.places.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { assertPlacesInPerimeter, isEditableProduct, productPlacesDocument, productPlacesOf, samePlaces } from './products.availability.ts';
import type { ProductPlace } from './products.availability.ts';
import { mediaWrites } from './products.document.ts';
import type { MediaWriteKey } from './products.document.ts';
import type { ProductLinks } from './products.links.ts';
import {
  CHOICE_PRICE_RULES,
  MODIFIER_CODES,
  MODULAR_PRICE_RULES,
  barcodesOf,
  componentsOf,
  idOf,
  idsOf,
  isModifierProduct,
  menuOf,
  modifierChoicesOf,
  stockOf,
  suppliersOf,
  typeOf,
} from './products.mapper.ts';
import { instantOf, priceDocument, pricesOf, usableRate } from './products.pricing.ts';
import type { PriceInput } from './products.pricing.ts';
import type { ProductsRepository } from './products.repository.ts';
import type { PatchProductBody } from './products.schemas.ts';

/** Most refused ids reported in the details of one refused request. */
const MAX_REPORTED = 20;

/** Most products one walk of the bills of materials looks at: a bill that reaches more is refused, since a cycle cannot be excluded. */
const MAX_BUNDLE_WALK = 1000;

/** What the planner reads and checks with. */
export interface PlanDeps {
  readonly repository: Pick<ProductsRepository, 'invalid' | 'componentsOf'>;
  readonly links: ProductLinks;
  readonly places: Pick<CategoryPlaces, 'setupOf'>;
  readonly references: Pick<ReferencesRepository, 'missing'>;
  readonly catalogs: Pick<CatalogsService, 'list'>;
  /** The descriptor of an image of the library, `null` when the caller may not use it. */
  readonly images: { imageSource(principal: AuthPrincipal, access: GroupAccess, imageId: ObjectId): Promise<MediaLogo | null> };
  readonly languages: GroupLanguages;
  readonly users: Pick<UsersRepository, 'findById'>;
  /** A new element id (the id of a price). */
  readonly newElementId: () => string;
}

/** What is to be planned: a creation (the stored document is the blank one the legacy starts a form from) or a modification. */
export interface PlanInput {
  readonly principal: AuthPrincipal;
  readonly access: GroupAccess;
  readonly id: ObjectId;
  readonly stored: Document;
  readonly body: PatchProductBody;
  readonly creating: boolean;
}

/** The writes a request needs, and the problems it has. */
export interface Plan {
  readonly set: Document;
  readonly unset: Document;
  /** The problems of the request (`422`); nothing is written while there is one. */
  readonly issues: ErrorDetail[];
  /** The ancestors of the leaves the write sets, which the write requires to be missing or objects. */
  readonly intact: string[];
  /** The value each field the write touches had when it was read, which the write requires to still hold. */
  readonly readValues: Record<string, unknown>;
  /** Whether the write adds components to the bill of materials (the write must then be checked for a cycle once it is made). */
  readonly componentsAdded: boolean;
}

/** The function of the group each field needs (otherwise `422` `notAllowed`, and the field is never shown). */
const FEATURE_OF: Readonly<Record<string, Feature>> = Object.freeze({
  'availability.pos': 'cash',
  'availability.warehouse': 'warehouse',
  'availability.scales': 'scales',
  'availability.ecommerce': 'customersApp',
  featured: 'customersApp',
  favoriteHandheld: 'rooms',
  plu: 'scales',
  scaleType: 'scales',
  loadUnit: 'warehouse',
  unloadUnit: 'warehouse',
  conversionRatio: 'warehouse',
  stock: 'warehouse',
  'colors.text': 'cash',
  'colors.background': 'cash',
  duration: 'services',
  maxConcurrent: 'services',
  requiredModifierIds: 'productsVariants',
  modifierIds: 'productsVariants',
  excludedModifierIds: 'productsVariants',
  modifierCategoryIds: 'productsVariants',
  modifierChoices: 'productsVariants',
  printStations: 'ordering',
  counterPrintStations: 'ordering',
  image: 'media',
  gallery: 'media',
  internalFileName: 'media',
  externalUrl: 'media',
});

/** The objects of a body whose fields each need their own function (or, for `dining` and `modifier`, one function for all of them). */
const NESTED = new Set(['availability', 'colors', 'dining', 'modifier']);

/** The fields of a modification that a company or place administrator may send for a product that is not wholly his: the data of his own places. */
const PLACE_FIELDS: readonly string[] = ['places', 'printStations', 'counterPrintStations', 'stock'];

/** The functions of the group the fields of a request need and the group lacks, as `notAllowed` problems. */
function featureIssues(access: GroupAccess, body: object): ErrorDetail[] {
  const paths = Object.entries(body).flatMap(([key, value]) => (NESTED.has(key) && isRecord(value) ? Object.keys(value).map((leaf) => `${key}.${leaf}`) : [key]));
  return paths.flatMap((path) => {
    const feature: Feature | undefined = path.startsWith('dining.') ? 'rooms' : path.startsWith('modifier.') ? 'productsVariants' : FEATURE_OF[path];
    return feature === undefined || access.features[feature] ? [] : [{ field: path, issue: 'notAllowed' }];
  });
}

/** The kinds of simple field and how each is read from and written to a document. */
type ScalarKind = 'flag' | 'text' | 'whole' | 'decimal' | 'color';

/** A field that is one value: its path in the body and in the document, and its kind. */
interface Scalar {
  readonly field: string;
  readonly path: string;
  readonly kind: ScalarKind;
}

/** The simple fields, written when they differ from the stored value (a flag the document lacks is off, a number that is not one reads as `null`). */
const SCALARS: readonly Scalar[] = Object.freeze([
  { field: 'enabled', path: 'status', kind: 'flag' },
  { field: 'favorite', path: 'favorite', kind: 'flag' },
  { field: 'favoriteHandheld', path: 'favoriteHandheld', kind: 'flag' },
  { field: 'generic', path: 'generic', kind: 'flag' },
  { field: 'toCheck', path: 'toCheck', kind: 'flag' },
  { field: 'noDiscount', path: 'noDiscount', kind: 'flag' },
  { field: 'featured', path: 'featured', kind: 'flag' },
  { field: 'availability.pos', path: 'availability.pos', kind: 'flag' },
  { field: 'availability.warehouse', path: 'availability.warehouse', kind: 'flag' },
  { field: 'availability.scales', path: 'availability.scales', kind: 'flag' },
  { field: 'availability.ecommerce', path: 'availability.ecommerce', kind: 'flag' },
  { field: 'integrations.floodOrders', path: 'integrations.floodOrders', kind: 'flag' },
  { field: 'integrations.yellgo', path: 'integrations.yellgo', kind: 'flag' },
  { field: 'integrations.leggimenu', path: 'integrations.leggimenu', kind: 'flag' },
  { field: 'dining.halfPortion', path: 'roomsSettings.halfPortion', kind: 'flag' },
  { field: 'dining.hiddenOnHandheld', path: 'roomsSettings.handheldHidden', kind: 'flag' },
  { field: 'dining.affiliatedMenu', path: 'roomsSettings.affiliatedMenu', kind: 'flag' },
  { field: 'dining.reversePrint', path: 'roomsSettings.reversePrint', kind: 'flag' },
  { field: 'dining.feePercentage', path: 'roomsSettings.percentageFee', kind: 'decimal' },
  { field: 'code', path: 'code', kind: 'text' },
  { field: 'plu', path: 'plu', kind: 'text' },
  { field: 'duration', path: 'time', kind: 'text' },
  { field: 'loadUnit', path: 'measureLoad', kind: 'text' },
  { field: 'unloadUnit', path: 'measureDownload', kind: 'text' },
  { field: 'position', path: 'position', kind: 'whole' },
  { field: 'productionValue', path: 'productionValue', kind: 'whole' },
  { field: 'maxConcurrent', path: 'max', kind: 'whole' },
  { field: 'conversionRatio', path: 'measureConversionRatio', kind: 'decimal' },
  { field: 'simpleCost', path: 'simpleCost', kind: 'decimal' },
  { field: 'shipping.width', path: 'shippingInfo.width', kind: 'decimal' },
  { field: 'shipping.height', path: 'shippingInfo.height', kind: 'decimal' },
  { field: 'shipping.depth', path: 'shippingInfo.depth', kind: 'decimal' },
  { field: 'shipping.weight', path: 'shippingInfo.weight', kind: 'decimal' },
  { field: 'modifier.pricePercentagePlus', path: 'variant.pricePercentagePlus', kind: 'decimal' },
  { field: 'modifier.pricePercentageMinus', path: 'variant.pricePercentageMinus', kind: 'decimal' },
  { field: 'colors.text', path: 'colors.pos.text', kind: 'color' },
  { field: 'colors.background', path: 'colors.pos.background', kind: 'color' },
]);

/** The texts by language, merged in the language the stored value has: a text that is `null` in the request is removed. */
const TEXTS = Object.freeze([
  { field: 'name', path: 'name' },
  { field: 'shortName', path: 'shortName' },
  { field: 'description', path: 'description' },
  { field: 'shortDescription', path: 'shortDescription' },
  { field: 'modifier.description', path: 'variant.description' },
] as const);

/** The lists of ids replaced as a whole, and what the ids of each are checked against. */
const ID_LISTS = Object.freeze([
  { field: 'categoryIds', path: 'categories', check: 'categories' },
  { field: 'modifierCategoryIds', path: 'variantsCategories', check: 'categories' },
  { field: 'requiredModifierIds', path: 'variantsRequired', check: 'modifiers' },
  { field: 'modifierIds', path: 'variants', check: 'modifiers' },
  { field: 'excludedModifierIds', path: 'variantsExcluded', check: 'modifiers' },
] as const);

/** The value of a field of the body at a dotted path (`undefined` when any step is missing). */
const bodyValue = (body: object, path: string): unknown => valueAt(body, path);

/** The stored value of a kind of simple field, read the way the views read it, and the value to store for a requested one. */
function currentOf(kind: ScalarKind, stored: Document, path: string): unknown {
  const raw = valueAt(stored, path);
  switch (kind) {
    case 'flag':
      return flagOf(raw);
    case 'text':
      return textOf(raw);
    case 'whole':
      return wholeValue(raw);
    case 'decimal':
      return numberValue(raw);
    case 'color':
      return typeof raw === 'string' && /^#[0-9A-Fa-f]{6}$/.test(raw) ? raw.toLowerCase() : null;
  }
}

/** A number the way the legacy stores it: an integer as `Int32`, a number with decimals as a double. */
const storedNumber = (value: number): Int32 | number => (Number.isInteger(value) && Math.abs(value) < 2 ** 31 ? new Int32(value) : value);

/** What to write for a requested value of a kind of simple field. */
const writtenOf = (kind: ScalarKind, requested: unknown): unknown => (kind === 'whole' && requested !== null ? new Int32(requested as number) : kind === 'decimal' && requested !== null ? storedNumber(requested as number) : requested);

/** The ancestors of the dotted paths (`a.b.c` has `a` and `a.b`): what a write of the leaf needs to be missing or an object. */
export function ancestorsOf(paths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const path of paths) {
    const segments = path.split('.');
    for (let length = 1; length < segments.length; length += 1) {
      result.add(segments.slice(0, length).join('.'));
    }
  }
  return [...result];
}

/** The ids a list has now, to tell the ones a write adds. */
const adding = (requested: readonly string[], current: readonly string[]): string[] => {
  const known = new Set(current);
  return requested.filter((id) => !known.has(id));
};

/** The hexadecimal ids of a stored list of references (`{ _id }` elements). */
const elementIds = (raw: unknown, key: string): string[] => recordsOf(raw).flatMap((item) => idsOf([item[key]]));

/**
 * Walks the bills of materials that start at some components, looking for the product itself: a product cannot, through any chain of components, contain itself.
 *
 * @param deps The reads.
 * @param input The caller, the group and the product.
 * @param components The new components, hexadecimal.
 * @returns The positions, in `components`, of the ones whose bill contains the product; `null` when the walk met more than {@link MAX_BUNDLE_WALK} products (a cycle cannot then be excluded).
 */
export async function cyclicComponents(deps: Pick<PlanDeps, 'repository'>, input: Pick<PlanInput, 'principal' | 'access' | 'id'>, components: readonly string[]): Promise<number[] | null> {
  const self = input.id.toHexString();
  const origin = new Map<string, number>();
  let frontier: string[] = [];
  components.forEach((id, index) => {
    if (!origin.has(id)) {
      origin.set(id, index);
      frontier.push(id);
    }
  });
  const cyclic = new Set<number>();
  while (frontier.length > 0) {
    if (origin.size > MAX_BUNDLE_WALK) {
      return null;
    }
    const level = await deps.repository.componentsOf(input.principal, input.access, frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of level.get(id) ?? []) {
        if (child === self) {
          cyclic.add(origin.get(id)!);
        } else if (!origin.has(child)) {
          origin.set(child, origin.get(id)!);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  // The product as a direct component of itself is a cycle as well.
  components.forEach((id, index) => id === self && cyclic.add(index));
  return [...cyclic].sort((a, b) => a - b);
}

/**
 * Plans the write of a creation or a modification of a product: checks the request against the group, the caller and the stored document and works out the paths to set and to unset, with every other key of
 * the document left alone. Nothing is written here; a request that changes nothing gives empty `set` and `unset`.
 *
 * @param deps The reads.
 * @param input The request.
 * @returns The plan; `issues` lists the `422` problems (the service refuses the request with them), a `403` is thrown at once.
 * @throws {AppError} `FORBIDDEN` for a company or place administrator who changes what is not his, `VALIDATION_ERROR` for a language the group does not have or a missing name.
 */
export async function planProduct(deps: PlanDeps, input: PlanInput): Promise<Plan> {
  const { principal, access, stored, body, creating } = input;
  const features = access.features;
  const allowed = perimeterOf(principal);
  const restricted = allowed !== null;
  const editable = isEditableProduct(principal, stored['placesAvailability']);
  const set: Document = {};
  const unset: Document = {};
  const issues: ErrorDetail[] = [];
  const modifier = isModifierProduct(stored);

  // A company or place administrator changes the whole of a product only when it is wholly his; otherwise only the data of his own places.
  if (!creating && restricted && !editable) {
    const outside = Object.keys(body).filter((key) => !PLACE_FIELDS.includes(key));
    if (outside.length > 0) {
      throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED).map((field) => ({ field, issue: 'notAllowed' })) });
    }
  }
  issues.push(...featureIssues(access, body));
  if (body.isModifier === true && !features.productsVariants) {
    issues.push({ field: 'isModifier', issue: 'notAllowed' });
  }
  if (!creating && body.isModifier !== undefined && body.isModifier !== modifier) {
    issues.push({ field: 'isModifier', issue: 'immutable' });
  }
  if (body.type !== undefined && (creating || body.type !== typeOf(stored['type']))) {
    if (body.type === 'service' && !features.services) {
      issues.push({ field: 'type', issue: 'notAllowed' });
    }
    if (['tobaccos', 'games', 'monopoly'].includes(body.type) && !features.tobaccosGamesMonopoly) {
      issues.push({ field: 'type', issue: 'notAllowed' });
    }
  }
  // The fields that belong to a product that is not a modifier, and the ones of a modifier.
  for (const field of ['requiredModifierIds', 'modifierIds', 'excludedModifierIds', 'modifierCategoryIds', 'menu', 'modifierChoices', 'modularPriceRule'] as const) {
    if (modifier && body[field] !== undefined) {
      issues.push({ field, issue: 'notAllowed' });
    }
  }
  if (!modifier && body.modifier !== undefined) {
    issues.push({ field: 'modifier', issue: 'notAllowed' });
  }

  // The simple fields.
  for (const scalar of SCALARS) {
    const requested = bodyValue(body, scalar.field);
    if (requested !== undefined && currentOf(scalar.kind, stored, scalar.path) !== requested) {
      set[scalar.path] = writtenOf(scalar.kind, requested);
    }
  }
  if (body.type !== undefined && stored['type'] !== body.type) {
    set['type'] = body.type;
  }
  if (body.scaleType !== undefined) {
    const code = body.scaleType === 'weight' ? 0 : 1;
    if (plainOf(stored['scaleType']) !== code) {
      set['scaleType'] = new Int32(code);
    }
  }
  if (body.modifier?.type !== undefined && valueAt(stored, 'variant.type') !== MODIFIER_CODES[body.modifier.type]) {
    set['variant.type'] = MODIFIER_CODES[body.modifier.type];
  }
  for (const [field, path] of [['validFrom', 'startDate'], ['validTo', 'endDate']] as const) {
    const requested = body[field];
    if (requested !== undefined && instantOf(stored[path]) !== requested) {
      set[path] = requested === null ? null : new Date(requested);
    }
  }
  if (body.modularPriceRule !== undefined && !modifier && valueAt(stored, 'modularBundle.priceRule') !== (body.modularPriceRule === null ? null : MODULAR_PRICE_RULES[body.modularPriceRule])) {
    set['modularBundle.priceRule'] = body.modularPriceRule === null ? null : MODULAR_PRICE_RULES[body.modularPriceRule];
  }

  // The texts by language.
  const textBody = (field: string): Record<string, string | null> | undefined => bodyValue(body, field) as Record<string, string | null> | undefined;
  if (TEXTS.some((entry) => textBody(entry.field) !== undefined)) {
    const groupLanguages = await deps.languages.of(access.groupId);
    const languages = new Set(groupLanguages);
    for (const { field, path } of TEXTS) {
      const request = textBody(field);
      if (request === undefined) {
        continue;
      }
      const current = valueAt(stored, path);
      issues.push(...languageIssues(field, request, current, languages));
      const merged = mergeTexts(current, request);
      if (field === 'name') {
        const caller = await deps.users.findById(principal.userId);
        if (caller === null) {
          throw new AppError('NOT_FOUND');
        }
        const required = requiredLanguage(caller.user.language, groupLanguages);
        // A name keeps a text in the required language it already had, and never ends up with none.
        if (Object.keys(textsOf(merged)).length === 0 || (textsOf(current)[required] !== undefined && textsOf(merged)[required] === undefined) || (creating && textsOf(merged)[required] === undefined)) {
          issues.push({ field: `name.${required}`, issue: 'required' });
        }
      }
      if (!isDeepStrictEqual(current, merged)) {
        set[path] = merged;
      }
    }
  }

  // The brand, the categories, the attributes, the modifiers and the suppliers: only what the write adds is judged, so an old reference that is gone never blocks an unrelated change.
  if (body.brandId !== undefined && body.brandId !== idOf(stored['brandId'])) {
    if (body.brandId !== null && (await deps.links.invalid(principal, access, 'brands', [body.brandId])).length > 0) {
      issues.push({ field: 'brandId', issue: 'incorrect' });
    }
    set['brandId'] = body.brandId === null ? null : ObjectId.createFromHexString(body.brandId);
  }
  for (const { field, path, check } of ID_LISTS) {
    const requested = body[field];
    if (requested === undefined) {
      continue;
    }
    const current = idsOf(stored[path]);
    const added = adding(requested, current);
    if (added.length > 0) {
      const invalid = check === 'categories' ? await deps.links.invalid(principal, access, 'categories', added) : await deps.repository.invalid(principal, access, added, 'modifier', restricted);
      invalid.forEach((position) => issues.push({ field: `${field}.${String(requested.indexOf(added[position]!))}`, issue: 'incorrect' }));
    }
    if (!isDeepStrictEqual(requested, current) || (Array.isArray(stored[path]) ? (stored[path] as unknown[]).length : -1) !== current.length) {
      set[path] = requested.map((id) => ObjectId.createFromHexString(id));
    }
  }
  if (body.attributeIds !== undefined) {
    const current = (Array.isArray(stored['attributes']) ? (stored['attributes'] as unknown[]) : []).filter((id): id is string => typeof id === 'string');
    const added = adding(body.attributeIds, current);
    if (added.length > 0) {
      (await deps.links.invalid(principal, access, 'attributes', added)).forEach((position) => issues.push({ field: `attributeIds.${String(body.attributeIds!.indexOf(added[position]!))}`, issue: 'incorrect' }));
    }
    if (!isDeepStrictEqual(body.attributeIds, current) || (Array.isArray(stored['attributes']) ? (stored['attributes'] as unknown[]).length : -1) !== current.length) {
      set['attributes'] = [...body.attributeIds];
    }
  }

  // The barcodes.
  if (body.barcodes !== undefined) {
    const current = recordsOf(stored['barcode']);
    const byValue = new Map(current.flatMap((item) => (typeof item['value'] === 'string' ? [[item['value'], item] as const] : [])));
    const next = body.barcodes.map((item, index) => {
      if (item.loadQuantity !== undefined && !features.warehouse) {
        issues.push({ field: `barcodes.${String(index)}.loadQuantity`, issue: 'notAllowed' });
      }
      const old = byValue.get(item.value);
      return { ...old, value: item.value, qtLoad: features.warehouse ? (item.loadQuantity ?? null) : (numberValue(old?.['qtLoad']) ?? null), qtSale: item.saleQuantity ?? null };
    });
    if (!isDeepStrictEqual(barcodesOf(next, { warehouse: true }), barcodesOf(stored['barcode'], { warehouse: true })) || !Array.isArray(stored['barcode'])) {
      set['barcode'] = next;
    }
  }

  // The prices.
  if (body.prices !== undefined) {
    const [taxList, listsOfGroup, currenciesOfGroup] = await Promise.all([
      deps.catalogs.list(taxes, access) as Promise<Tax[]>,
      deps.catalogs.list(priceLists, access) as Promise<PriceList[]>,
      deps.catalogs.list(currencies, access) as Promise<Currency[]>,
    ]);
    const known = new Set(pricesOf(stored['prices']).map((price) => `${price.priceListId ?? ''}|${price.currency ?? ''}|${price.taxId ?? ''}`));
    const storedPrices = recordsOf(stored['prices']);
    const ids = new Set<string>();
    const next = body.prices.map((input, index) => {
      const at = `prices.${String(index)}`;
      const tax = taxList.find((candidate) => candidate.id === input.taxId);
      const fresh = !known.has(`${input.priceListId}|${input.currency}|${input.taxId}`);
      if (fresh && !listsOfGroup.some((list) => list.id === input.priceListId)) {
        issues.push({ field: `${at}.priceListId`, issue: 'incorrect' });
      }
      if (fresh && !currenciesOfGroup.some((currency) => currency.code === input.currency)) {
        issues.push({ field: `${at}.currency`, issue: 'incorrect' });
      }
      if (tax === undefined || !usableRate(tax.rate)) {
        issues.push({ field: `${at}.taxId`, issue: 'incorrect' });
      }
      // A rule keeps the keys it has when it is sent back with its id; a rule the legacy wrote with none is matched by its place in the list.
      const old = input.id == null ? (storedPrices[index] !== undefined && textOf(storedPrices[index]!['id']) === null ? storedPrices[index] : undefined) : storedPrices.find((price) => textOf(price['id']) === input.id);
      let id = input.id ?? textOf(old?.['id']) ?? deps.newElementId();
      if (ids.has(id)) {
        issues.push({ field: `${at}.id`, issue: 'incorrect' });
        id = deps.newElementId();
      }
      ids.add(id);
      return tax === undefined || !usableRate(tax.rate) ? {} : priceDocument(input as PriceInput, tax, id, old);
    });
    if (!isDeepStrictEqual(pricesOf(next), pricesOf(stored['prices'])) || !Array.isArray(stored['prices'])) {
      set['prices'] = next;
    }
  }

  // The suppliers.
  if (body.suppliers !== undefined) {
    const current = recordsOf(stored['suppliers']);
    const known = suppliersOf(stored['suppliers']).flatMap((supplier) => supplier.contactId ?? []);
    const added = adding(
      body.suppliers.map((supplier) => supplier.contactId),
      known,
    );
    if (added.length > 0) {
      const wanted = body.suppliers.map((supplier) => supplier.contactId);
      (await deps.links.invalid(principal, access, 'suppliers', added)).forEach((position) => issues.push({ field: `suppliers.${String(wanted.indexOf(added[position]!))}.contactId`, issue: 'incorrect' }));
    }
    const next = body.suppliers.map((supplier) => {
      const old = current.find((item) => idOf(item['id']) === supplier.contactId);
      return {
        ...old,
        id: ObjectId.createFromHexString(supplier.contactId),
        code: supplier.code ?? '',
        name: supplier.name ?? '',
        minQt: supplier.minQuantity ?? null,
        deliveryTime: supplier.deliveryTime ?? null,
        deliveryTimeUnit: supplier.deliveryTimeUnit ?? 'days',
        favorite: supplier.favorite ?? false,
        companyLists: (supplier.priceLists ?? []).map((list) => ({ id: list.id, price: list.price ?? null, discount1: list.discount1 ?? null, discount2: list.discount2 ?? null, discount3: list.discount3 ?? null })),
      };
    });
    if (!isDeepStrictEqual(suppliersOf(next), suppliersOf(stored['suppliers'])) || !Array.isArray(stored['suppliers'])) {
      set['suppliers'] = next;
    }
  }

  // The bill of materials, the menu and the modifier choices.
  let componentsAdded = false;
  if (body.components !== undefined) {
    const current = componentsOf(stored['bundleProducts']);
    const requestedIds = body.components.map((component) => component.productId);
    const added = adding(requestedIds, current.map((component) => component.productId));
    if (added.length > 0) {
      (await deps.repository.invalid(principal, access, added, 'plain', restricted)).forEach((position) => issues.push({ field: `components.${String(requestedIds.indexOf(added[position]!))}.productId`, issue: 'incorrect' }));
    }
    const storedComponents = recordsOf(stored['bundleProducts']);
    const next = body.components.map((component) => ({ ...storedComponents.find((item) => idOf(item['_id']) === component.productId), _id: ObjectId.createFromHexString(component.productId), quantity: component.quantity, waste: component.waste ?? null }));
    if (!isDeepStrictEqual(componentsOf(next), current) || !Array.isArray(stored['bundleProducts'])) {
      set['bundleProducts'] = next;
      componentsAdded = added.length > 0;
      // A product cannot contain itself, through any chain of components (a product that is being created cannot be a component of anything yet).
      if (!creating && added.length > 0 && issues.length === 0) {
        const cyclic = await cyclicComponents(deps, input, requestedIds);
        if (cyclic === null) {
          issues.push({ field: 'components', issue: 'tooMany' });
        } else {
          cyclic.forEach((position) => issues.push({ field: `components.${String(position)}.productId`, issue: 'incorrect' }));
        }
      }
    }
  }
  /** Checks the categories and the products of the choices a write adds. */
  const choiceIssues = async (field: 'menu' | 'modifierChoices', requested: ReadonlyArray<{ readonly categoryId: string; readonly productIds?: readonly string[] | undefined }>, currentRaw: unknown, use: 'plain' | 'modifier'): Promise<void> => {
    const currentCategories = recordsOf(currentRaw).flatMap((item) => idsOf([item['categoryId']]));
    const currentProducts = recordsOf(currentRaw).flatMap((item) => elementIds(item['products'], '_id'));
    const addedCategories = adding(requested.map((choice) => choice.categoryId), currentCategories);
    if (addedCategories.length > 0) {
      const wanted = requested.map((choice) => choice.categoryId);
      (await deps.links.invalid(principal, access, 'categories', addedCategories)).forEach((position) => issues.push({ field: `${field}.${String(wanted.indexOf(addedCategories[position]!))}.categoryId`, issue: 'incorrect' }));
    }
    const addedProducts = adding(requested.flatMap((choice) => choice.productIds ?? []), currentProducts);
    if (addedProducts.length > 0) {
      const bad = new Set((await deps.repository.invalid(principal, access, [...new Set(addedProducts)], use, restricted)).map((position) => [...new Set(addedProducts)][position]!));
      requested.forEach((choice, index) => (choice.productIds ?? []).forEach((id, position) => bad.has(id) && issues.push({ field: `${field}.${String(index)}.productIds.${String(position)}`, issue: 'incorrect' })));
    }
  };
  if (body.menu !== undefined) {
    body.menu.forEach((choice, index) => choice.course !== undefined && !features.rooms && issues.push({ field: `menu.${String(index)}.course`, issue: 'notAllowed' }));
    await choiceIssues('menu', body.menu, stored['selectableBundleProducts'], 'plain');
    const storedMenu = recordsOf(stored['selectableBundleProducts']);
    const next = body.menu.map((choice, index) => ({
      categoryId: ObjectId.createFromHexString(choice.categoryId),
      quantity: new Int32(choice.quantity),
      exit: features.rooms ? (choice.course == null ? null : new Int32(choice.course)) : (storedMenu[index]?.['exit'] ?? null),
      products: (choice.productIds ?? []).map((id) => ({ _id: ObjectId.createFromHexString(id) })),
    }));
    if (!isDeepStrictEqual(menuOf(next, { rooms: true }), menuOf(stored['selectableBundleProducts'], { rooms: true })) || !Array.isArray(stored['selectableBundleProducts'])) {
      set['selectableBundleProducts'] = next;
    }
  }
  if (body.modifierChoices !== undefined) {
    await choiceIssues('modifierChoices', body.modifierChoices, stored['selectableVariantsBundleProducts'], 'modifier');
    const next = body.modifierChoices.map((choice) => ({
      categoryId: ObjectId.createFromHexString(choice.categoryId),
      freeQt: choice.freeQuantity,
      priceType: CHOICE_PRICE_RULES[choice.priceRule],
      products: (choice.productIds ?? []).map((id) => ({ _id: ObjectId.createFromHexString(id) })),
    }));
    if (!isDeepStrictEqual(modifierChoicesOf(next), modifierChoicesOf(stored['selectableVariantsBundleProducts'])) || !Array.isArray(stored['selectableVariantsBundleProducts'])) {
      set['selectableVariantsBundleProducts'] = next;
    }
  }

  // The units of measure are the ones of the group (by value).
  for (const [field, path] of [['loadUnit', 'measureLoad'], ['unloadUnit', 'measureDownload']] as const) {
    const requested = body[field];
    if (requested != null && requested !== textOf(stored[path])) {
      const units = (await deps.catalogs.list(measureUnits, access)) as MeasureUnit[];
      if (!units.some((unit) => unit.value === requested)) {
        issues.push({ field, issue: 'incorrect' });
      }
    }
  }

  // The places of the product, their production centers, and the print stations and the stock of each place.
  const stationIssues = async (field: 'printStations' | 'counterPrintStations', path: 'printStations' | 'printStationsNoRooms', requested: Readonly<Record<string, readonly string[] | null>>): Promise<void> => {
    const outside = Object.keys(requested).filter((placeId) => allowed !== null && !allowed.has(placeId));
    if (outside.length > 0) {
      throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED).map((placeId) => ({ field: `${field}.${placeId}`, issue: 'notAllowed' })) });
    }
    const map = stored[path];
    const current = (placeId: string): unknown => (isRecord(map) ? map[`__${placeId}`] : undefined);
    const given = Object.entries(requested).flatMap(([placeId, ids]) => (ids === null ? [] : [[placeId, ids] as const]));
    const fresh = given.filter(([placeId]) => !(isRecord(map) && Object.hasOwn(map, `__${placeId}`)));
    const missing = new Set((await deps.references.missing(principal, access, { field, collection: 'places', ids: fresh.map(([placeId]) => placeId) })).map((position) => fresh[position]![0]));
    const changed = given.filter(([placeId, ids]) => ids.length > 0 && !missing.has(placeId) && !isDeepStrictEqual(current(placeId), ids));
    const setups = await deps.places.setupOf(principal, access, changed.map(([placeId]) => placeId));
    for (const [placeId, ids] of given) {
      if (missing.has(placeId)) {
        issues.push({ field: `${field}.${placeId}`, issue: 'incorrect' });
      } else if (changed.some(([changedId]) => changedId === placeId)) {
        const had = new Set(Array.isArray(current(placeId)) ? (current(placeId) as unknown[]) : []);
        ids.forEach((id, index) => !had.has(id) && !setups.get(placeId)!.stationIds.has(id) && issues.push({ field: `${field}.${placeId}.${String(index)}`, issue: 'incorrect' }));
      }
    }
    for (const [placeId, ids] of Object.entries(requested)) {
      const key = `__${placeId}`;
      const exists = isRecord(map) && Object.hasOwn(map, key);
      if (ids === null) {
        if (exists) {
          unset[`${path}.${key}`] = '';
        }
      } else if (exists ? !isDeepStrictEqual(stationsOf(map, null)[placeId], ids) || !Array.isArray((map as Document)[key]) : ids.length > 0 || creating) {
        set[`${path}.${key}`] = [...ids];
      }
    }
  };
  if (body.printStations !== undefined) {
    await stationIssues('printStations', 'printStations', body.printStations);
  }
  if (body.counterPrintStations !== undefined) {
    await stationIssues('counterPrintStations', 'printStationsNoRooms', body.counterPrintStations);
  }
  if (body.stock !== undefined) {
    const outside = Object.keys(body.stock).filter((placeId) => allowed !== null && !allowed.has(placeId));
    if (outside.length > 0) {
      throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED).map((placeId) => ({ field: `stock.${placeId}`, issue: 'notAllowed' })) });
    }
    const quantity = stored['quantity'];
    const had = (placeId: string, storageId?: string): boolean => isRecord(quantity) && isRecord(quantity[`__${placeId}`]) && (storageId === undefined || Object.hasOwn(quantity[`__${placeId}`] as Document, `__${storageId}`));
    const placeIds = Object.keys(body.stock);
    const freshPlaces = placeIds.filter((placeId) => !had(placeId));
    const missing = new Set((await deps.references.missing(principal, access, { field: 'stock', collection: 'places', ids: freshPlaces })).map((position) => freshPlaces[position]!));
    const freshStorages = placeIds.filter((placeId) => !missing.has(placeId) && Object.keys(body.stock![placeId]!).some((storageId) => !had(placeId, storageId)));
    const setups = await deps.places.setupOf(principal, access, freshStorages);
    const current = stockOf(quantity, null);
    for (const [placeId, storages] of Object.entries(body.stock)) {
      if (missing.has(placeId)) {
        issues.push({ field: `stock.${placeId}`, issue: 'incorrect' });
        continue;
      }
      for (const [storageId, leaves] of Object.entries(storages)) {
        if (!had(placeId, storageId) && !setups.get(placeId)!.storageIds.has(storageId)) {
          issues.push({ field: `stock.${placeId}.${storageId}`, issue: 'incorrect' });
          continue;
        }
        const now = current[placeId]?.[storageId];
        for (const leaf of ['min', 'max', 'location'] as const) {
          const requested = leaves[leaf];
          if (requested !== undefined && (now === undefined || now[leaf] !== requested)) {
            set[`quantity.__${placeId}.__${storageId}.${leaf}`] = requested === null || typeof requested === 'string' ? requested : storedNumber(requested);
          }
        }
      }
    }
  }
  if (creating || body.places !== undefined) {
    const requested: ProductPlace[] = (body.places ?? []).map((entry) => ({ placeId: entry.placeId, favorite: entry.favorite ?? false, favoriteHandheld: entry.favoriteHandheld ?? false, position: entry.position ?? null, productionCenterId: entry.productionCenterId ?? null }));
    (body.places ?? []).forEach((entry, index) => entry.favoriteHandheld !== undefined && !features.rooms && issues.push({ field: `places.${String(index)}.favoriteHandheld`, issue: 'notAllowed' }));
    const next = productPlacesDocument(principal, stored['placesAvailability'], requested);
    // A company or place administrator cannot limit a product that is for every place, nor end up with one that is.
    if (!creating && restricted && productPlacesOf(stored['placesAvailability']).length === 0) {
      throw new AppError('FORBIDDEN', { details: [{ field: 'places', issue: 'notAllowed' }] });
    }
    assertPlacesInPerimeter(principal, requested.map((entry) => entry.placeId), next.length);
    const current = new Map(productPlacesOf(stored['placesAvailability']).entries.map((entry) => [entry.placeId, entry]));
    const added = requested.filter((entry) => !current.has(entry.placeId));
    const missing = new Set(
      added.length === 0 ? [] : (await deps.references.missing(principal, access, { field: 'places', collection: 'places', ids: added.map((entry) => entry.placeId) })).map((position) => added[position]!.placeId),
    );
    requested.forEach((entry, index) => missing.has(entry.placeId) && issues.push({ field: `places.${String(index)}.placeId`, issue: 'incorrect' }));
    const centers = requested.filter((entry) => entry.productionCenterId !== null && !missing.has(entry.placeId) && current.get(entry.placeId)?.productionCenterId !== entry.productionCenterId);
    const setups = await deps.places.setupOf(principal, access, centers.map((entry) => entry.placeId));
    centers.forEach((entry) => !setups.get(entry.placeId)!.centerIds.has(entry.productionCenterId!) && issues.push({ field: `places.${String(requested.indexOf(entry))}.productionCenterId`, issue: 'incorrect' }));
    if (!samePlaces(stored['placesAvailability'], next)) {
      set['placesAvailability'] = next;
    }
  }

  // The images, the gallery, the file name and the external address (all of them need `media`).
  if (features.media) {
    const media: Partial<Record<MediaWriteKey, unknown>> = {};
    if (body.image !== undefined) {
      const descriptor = body.image === null ? null : await deps.images.imageSource(principal, access, ObjectId.createFromHexString(body.image.imageId));
      if (body.image !== null && descriptor === null) {
        issues.push({ field: 'image', issue: 'incorrect' });
      } else if ((descriptor?._id ?? null) !== ((logo.read(valueAt(stored, 'medias.images.main')) as MediaLogo | null)?._id ?? null)) {
        media['main'] = descriptor === null ? null : legacyLogoDescriptor(descriptor);
      }
    }
    if (body.gallery !== undefined) {
      const rawGallery = valueAt(stored, 'medias.images.gallery');
      const currentGallery = (Array.isArray(rawGallery) ? (rawGallery as unknown[]) : []).flatMap((item) => {
        const descriptor = logo.read(item) as MediaLogo | null;
        return descriptor === null ? [] : [{ descriptor, raw: item }];
      });
      const requestedIds = body.gallery.map((item) => item.imageId);
      if (!isDeepStrictEqual(requestedIds, currentGallery.map((item) => item.descriptor._id)) || !Array.isArray(rawGallery)) {
        const next: unknown[] = [];
        for (const [index, imageId] of requestedIds.entries()) {
          const old = currentGallery.find((item) => item.descriptor._id === imageId);
          const descriptor = old === undefined ? await deps.images.imageSource(principal, access, ObjectId.createFromHexString(imageId)) : old.descriptor;
          if (descriptor === null) {
            issues.push({ field: `gallery.${String(index)}.imageId`, issue: 'incorrect' });
          } else {
            next.push(old === undefined ? legacyLogoDescriptor(descriptor) : old.raw);
          }
        }
        media['gallery'] = next;
      }
    }
    for (const field of ['internalFileName', 'externalUrl'] as const) {
      if (body[field] !== undefined && body[field] !== (textOf(valueAt(stored, `medias.images.${field}`)) ?? null)) {
        media[field] = body[field];
      }
    }
    const written = mediaWrites(stored['medias'], media);
    Object.assign(set, written.set);
    Object.assign(unset, written.unset);
  }

  const touched = [...Object.keys(set), ...Object.keys(unset)];
  const intact = ancestorsOf(touched);
  const readValues = Object.fromEntries(touched.filter((path) => path !== 'placesAvailability').map((path) => [path, valueAt(stored, path)]));
  return { set, unset, issues, intact, readValues, componentsAdded };
}
