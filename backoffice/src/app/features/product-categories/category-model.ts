import { LogoModel } from '../companies/company-model';
import { numberOrNull, numberText } from '../groups/catalogs/catalog-fields';
import { changedTexts, filled, logoOf, sameIds } from '../product-catalog/catalog-item-model';
import {
  Category,
  CategoryFeatures,
  CategoryPlace,
  DEFAULT_COLOR,
  DiningType,
  StationsByPlace,
} from './category.types';

/** A store of the availability tab as the form edits it. */
export interface PlaceRow {
  readonly placeId: string;
  /** The position as typed; a whole number when valid, `''` for none. */
  readonly position: string;
  /** Id of the production center of the store, `''` for none. */
  readonly productionCenterId: string;
}

/** The print stations of the form: the ids chosen for each store, for the orders in the rooms and at the counter. */
export interface StationsModel {
  readonly rooms: Readonly<Record<string, readonly string[]>>;
  readonly counter: Readonly<Record<string, readonly string[]>>;
}

/** The settings of a restaurant as the form edits them. */
export interface DiningModel {
  endOfMeal: boolean;
  hiddenOnHandheld: boolean;
  /** As typed; a number from 0 to 100 when valid. */
  feePercentage: string;
  /** As typed; a whole number when valid. */
  printGroup: string;
  alwaysFirstCourse: boolean;
  notAffiliatedMenu: boolean;
  type: DiningType;
}

/** What the form of a category edits. The names are the ones of the server, so that its errors land on the right field. */
export interface CategoryModel {
  enabled: boolean;
  availability: { pos: boolean; ecommerce: boolean };
  noDiscount: boolean;
  requiresLegalAge: boolean;
  secondaryFiscalPrinter: boolean;
  featured: boolean;
  integrations: { floodOrders: boolean; yellgo: boolean; leggimenu: boolean };
  /** Id of the parent, `''` for a root. */
  parentId: string;
  /** As typed; a whole number from 0 to 1,000,000 when valid. */
  position: string;
  productionValue: string;
  name: Record<string, string>;
  description: Record<string, string>;
  dining: DiningModel;
  tobacco: boolean;
  backgroundColor: string;
  textColor: string;
  modifierIds: string[];
  modifierCategoryIds: string[];
  stations: StationsModel;
  places: PlaceRow[];
  image: LogoModel | null;
  icon: LogoModel | null;
  internalFileName: string;
  externalUrl: string;
}

/** Every language of the form with its text (`''` where the category has none). */
function textsOf(source: Readonly<Record<string, string>>, languages: readonly string[]) {
  return Object.fromEntries(languages.map((code) => [code, source[code] ?? '']));
}

/** The stations of a map, without the stores that have none. */
function chosen(map: StationsByPlace | undefined): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, ids]) => ids.length > 0));
}

/** The row of a store of the availability. */
function rowOf(place: CategoryPlace): PlaceRow {
  return {
    placeId: place.placeId,
    position: numberText(place.position),
    productionCenterId: place.productionCenterId ?? '',
  };
}

/**
 * The form model of a category.
 *
 * @param item The category; `null` for the defaults of a new one.
 * @param languages The languages of the form (the ones of the group and the ones the category has).
 */
export function toModel(item: Category | null, languages: readonly string[]): CategoryModel {
  return {
    enabled: item?.enabled ?? true,
    availability: {
      pos: item?.availability?.pos ?? false,
      ecommerce: item?.availability?.ecommerce ?? false,
    },
    noDiscount: item?.noDiscount ?? false,
    requiresLegalAge: item?.requiresLegalAge ?? false,
    secondaryFiscalPrinter: item?.secondaryFiscalPrinter ?? false,
    featured: item?.featured ?? false,
    integrations: {
      floodOrders: item?.integrations.floodOrders ?? false,
      yellgo: item?.integrations.yellgo ?? false,
      leggimenu: item?.integrations.leggimenu ?? false,
    },
    parentId: item?.parentId ?? '',
    position: numberText(item?.position ?? null),
    productionValue: numberText(item?.productionValue ?? null),
    name: textsOf(item?.name ?? {}, languages),
    description: textsOf(item?.description ?? {}, languages),
    dining: {
      endOfMeal: item?.dining?.endOfMeal ?? false,
      hiddenOnHandheld: item?.dining?.hiddenOnHandheld ?? false,
      feePercentage: numberText(item?.dining?.feePercentage ?? null),
      printGroup: numberText(item?.dining?.printGroup ?? null),
      alwaysFirstCourse: item?.dining?.alwaysFirstCourse ?? false,
      notAffiliatedMenu: item?.dining?.notAffiliatedMenu ?? false,
      type: item?.dining?.type ?? 'other',
    },
    tobacco: item?.tobacco ?? false,
    backgroundColor: item?.backgroundColor ?? DEFAULT_COLOR,
    textColor: item?.textColor ?? DEFAULT_COLOR,
    modifierIds: [...(item?.modifierIds ?? [])],
    modifierCategoryIds: [...(item?.modifierCategoryIds ?? [])],
    stations: { rooms: chosen(item?.printStations), counter: chosen(item?.counterPrintStations) },
    places: (item?.places ?? []).map(rowOf),
    image: logoOf(item?.image),
    icon: logoOf(item?.icon),
    internalFileName: item?.internalFileName ?? '',
    externalUrl: item?.externalUrl ?? '',
  };
}

/** The `{ imageId }` of a logo the user picked from the library, `undefined` for one already stored or none. */
function pickedId(logo: LogoModel | null): { imageId: string } | undefined {
  return logo?.imageId ? { imageId: logo.imageId } : undefined;
}

/** The stations of a creation: the stores that have some. */
export function stationsBody(map: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(map)
      .filter(([, ids]) => ids.length > 0)
      .map(([placeId, ids]) => [placeId, [...ids]]),
  );
}

/** The stations of a modification: the stores whose choice changed, `null` for a store left with none. */
export function stationsPatch(
  now: Readonly<Record<string, readonly string[]>>,
  before: Readonly<Record<string, readonly string[]>>,
): Record<string, string[] | null> | undefined {
  const changes: Record<string, string[] | null> = {};
  for (const placeId of new Set([...Object.keys(now), ...Object.keys(before)])) {
    const ids = now[placeId] ?? [];
    if (!sameIds(ids, before[placeId] ?? [])) {
      changes[placeId] = ids.length === 0 ? null : [...ids];
    }
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/** The body of one store of the availability. */
function placeBody(row: PlaceRow): CategoryPlace {
  return {
    placeId: row.placeId,
    position: numberOrNull(row.position),
    productionCenterId: row.productionCenterId === '' ? null : row.productionCenterId,
  };
}

/** Whether two availabilities are the same (the order of the stores does not matter). */
function samePlaces(a: readonly PlaceRow[], b: readonly PlaceRow[]): boolean {
  const key = (row: PlaceRow) => JSON.stringify([row.placeId, row.position.trim(), row.productionCenterId]);
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** The text of a field of the media, `null` when blank. */
function mediaText(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

/**
 * The body of a creation: everything the user filled in, limited to the fields of the features
 * the group has (the server refuses the others with `notAllowed`).
 *
 * @param model The form model.
 * @param features What the group has.
 */
export function createBody(model: CategoryModel, features: CategoryFeatures): object {
  const description = filled(model.description);
  const body: Record<string, unknown> = {
    name: filled(model.name),
    enabled: model.enabled,
    noDiscount: model.noDiscount,
    requiresLegalAge: model.requiresLegalAge,
    integrations: { ...model.integrations },
    textColor: model.textColor,
  };
  if (Object.keys(description).length > 0) {
    body['description'] = description;
  }
  if (model.parentId !== '') {
    body['parentId'] = model.parentId;
  }
  if (model.position.trim() !== '') {
    body['position'] = numberOrNull(model.position);
  }
  if (model.productionValue.trim() !== '') {
    body['productionValue'] = numberOrNull(model.productionValue);
  }
  const availability = {
    ...(features.cash ? { pos: model.availability.pos } : {}),
    ...(features.customersApp ? { ecommerce: model.availability.ecommerce } : {}),
  };
  if (Object.keys(availability).length > 0) {
    body['availability'] = availability;
  }
  if (features.customersApp) {
    body['featured'] = model.featured;
  }
  if (features.tobaccosGamesMonopoly) {
    body['secondaryFiscalPrinter'] = model.secondaryFiscalPrinter;
    body['tobacco'] = model.tobacco;
  }
  if (features.rooms) {
    body['dining'] = diningBody(model);
  }
  if (features.cash) {
    body['backgroundColor'] = model.backgroundColor;
  }
  if (features.productsVariants) {
    body['modifierIds'] = model.modifierIds;
    body['modifierCategoryIds'] = model.modifierCategoryIds;
  }
  if (features.ordering) {
    body['printStations'] = stationsBody(model.stations.rooms);
    body['counterPrintStations'] = stationsBody(model.stations.counter);
  }
  if (model.places.length > 0) {
    body['places'] = model.places.map(placeBody);
  }
  if (features.media) {
    Object.assign(body, mediaBody(model));
  }
  return body;
}

/** The settings of a restaurant of a creation. */
function diningBody(model: CategoryModel): object {
  const { dining } = model;
  return {
    endOfMeal: dining.endOfMeal,
    hiddenOnHandheld: dining.hiddenOnHandheld,
    feePercentage: numberOrNull(dining.feePercentage),
    printGroup: numberOrNull(dining.printGroup),
    alwaysFirstCourse: dining.alwaysFirstCourse,
    notAffiliatedMenu: dining.notAffiliatedMenu,
    type: dining.type,
  };
}

/** The media of a creation: the images picked and the texts filled in. */
function mediaBody(model: CategoryModel): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const image = pickedId(model.image);
  const icon = pickedId(model.icon);
  if (image !== undefined) {
    body['image'] = image;
  }
  if (icon !== undefined) {
    body['icon'] = icon;
  }
  if (mediaText(model.internalFileName) !== null) {
    body['internalFileName'] = mediaText(model.internalFileName);
  }
  if (mediaText(model.externalUrl) !== null) {
    body['externalUrl'] = mediaText(model.externalUrl);
  }
  return body;
}

/** Sets `body[key]` to `value` when it differs from `before`. */
function differing<T>(body: Record<string, unknown>, key: string, now: T, before: T): void {
  if (now !== before) {
    body[key] = now;
  }
}

/** The keys of an object of switches that differ, with their new value; `undefined` when none does. */
function changedKeys<T extends object>(now: T, before: T, keys: readonly (keyof T)[]): Partial<T> | undefined {
  const changes: Partial<T> = {};
  for (const key of keys) {
    if (now[key] !== before[key]) {
      changes[key] = now[key];
    }
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/** The changes of the media of a modification. */
function mediaPatch(model: CategoryModel, before: CategoryModel): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ['image', 'icon'] as const) {
    if (model[key] === null && before[key] !== null) {
      body[key] = null;
    } else if (pickedId(model[key]) !== undefined) {
      body[key] = pickedId(model[key]);
    }
  }
  for (const key of ['internalFileName', 'externalUrl'] as const) {
    if (model[key].trim() !== before[key].trim()) {
      body[key] = mediaText(model[key]);
    }
  }
  return body;
}

/** The changes of the settings of a restaurant. */
function diningPatch(model: CategoryModel, before: CategoryModel): object | undefined {
  const changes: Record<string, unknown> = { ...changedKeys(model.dining, before.dining, ['endOfMeal', 'hiddenOnHandheld', 'alwaysFirstCourse', 'notAffiliatedMenu', 'type']) };
  for (const key of ['feePercentage', 'printGroup'] as const) {
    if (model.dining[key].trim() !== before.dining[key].trim()) {
      changes[key] = numberOrNull(model.dining[key]);
    }
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/**
 * The body of a modification: only what differs from the stored category (the texts language by
 * language, the switches of the groups of switches one by one, the lists whole), limited to the
 * fields of the features the group has.
 *
 * @param model The form model.
 * @param before The form model of the category as the server has it.
 * @param features What the group has.
 */
export function patchBody(
  model: CategoryModel,
  before: CategoryModel,
  features: CategoryFeatures,
): object {
  const body: Record<string, unknown> = {};
  const name = changedTexts(model.name, before.name);
  const description = changedTexts(model.description, before.description);
  if (name !== undefined) {
    body['name'] = name;
  }
  if (description !== undefined) {
    body['description'] = description;
  }
  differing(body, 'enabled', model.enabled, before.enabled);
  differing(body, 'noDiscount', model.noDiscount, before.noDiscount);
  differing(body, 'requiresLegalAge', model.requiresLegalAge, before.requiresLegalAge);
  differing(body, 'textColor', model.textColor, before.textColor);
  if (model.parentId !== before.parentId) {
    body['parentId'] = model.parentId === '' ? null : model.parentId;
  }
  for (const key of ['position', 'productionValue'] as const) {
    if (model[key].trim() !== before[key].trim()) {
      body[key] = numberOrNull(model[key]);
    }
  }
  const integrations = changedKeys(model.integrations, before.integrations, ['floodOrders', 'yellgo', 'leggimenu']);
  if (integrations !== undefined) {
    body['integrations'] = integrations;
  }
  const allowed = [...(features.cash ? (['pos'] as const) : []), ...(features.customersApp ? (['ecommerce'] as const) : [])];
  const availability = changedKeys(model.availability, before.availability, allowed);
  if (availability !== undefined) {
    body['availability'] = availability;
  }
  if (features.customersApp) {
    differing(body, 'featured', model.featured, before.featured);
  }
  if (features.tobaccosGamesMonopoly) {
    differing(body, 'secondaryFiscalPrinter', model.secondaryFiscalPrinter, before.secondaryFiscalPrinter);
    differing(body, 'tobacco', model.tobacco, before.tobacco);
  }
  const dining = features.rooms ? diningPatch(model, before) : undefined;
  if (dining !== undefined) {
    body['dining'] = dining;
  }
  if (features.cash) {
    differing(body, 'backgroundColor', model.backgroundColor, before.backgroundColor);
  }
  if (features.productsVariants) {
    if (!sameIds(model.modifierIds, before.modifierIds)) {
      body['modifierIds'] = model.modifierIds;
    }
    if (!sameIds(model.modifierCategoryIds, before.modifierCategoryIds)) {
      body['modifierCategoryIds'] = model.modifierCategoryIds;
    }
  }
  if (features.ordering) {
    const rooms = stationsPatch(model.stations.rooms, before.stations.rooms);
    const counter = stationsPatch(model.stations.counter, before.stations.counter);
    if (rooms !== undefined) {
      body['printStations'] = rooms;
    }
    if (counter !== undefined) {
      body['counterPrintStations'] = counter;
    }
  }
  if (!samePlaces(model.places, before.places)) {
    body['places'] = model.places.map(placeBody);
  }
  if (features.media) {
    Object.assign(body, mediaPatch(model, before));
  }
  return body;
}
