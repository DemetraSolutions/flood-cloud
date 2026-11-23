import { LogoModel } from '../companies/company-model';
import { LogoDescriptor } from '../companies/company.types';
import { CatalogEntry, CatalogImage, CatalogKind, Department } from './product-catalog.types';

/** What the form of a department or brand edits (the brand ignores the fields only departments have). */
export interface ItemModel {
  enabled: boolean;
  noDiscount: boolean;
  secondaryFiscalPrinter: boolean;
  /** The code as typed; a number between 1 and 99 when valid. */
  code: string;
  /** Id of the tax rate of the group, `''` for none. */
  taxId: string;
  /** The name for each language of the form (`''` for none). */
  name: Record<string, string>;
  /** The description for each language of the form (`''` for none). */
  description: Record<string, string>;
  /** Stores the entry is for; empty for every store. */
  placeIds: string[];
  image: LogoModel | null;
}

/** The facts about the group that decide which fields are sent. */
export interface BodyOptions {
  /** The group has the `media` feature: only then the image is part of the entry. */
  readonly media: boolean;
}

/** The logo model of the image an entry has, `null` for none. */
export function logoOf(image: CatalogImage | null | undefined): LogoModel | null {
  if (image === null || image === undefined) {
    return null;
  }
  const descriptor: LogoDescriptor = {
    _id: image._id ?? '',
    basename: image.basename ?? '',
    extension: image.extension ?? '',
    filename: image.filename ?? '',
    mimetype: image.mimetype ?? '',
    title: image.title,
    alt: image.alt,
    dirname: image.dirname ?? '',
    type: image.type ?? '',
    filectime: image.filectime ?? 0,
  };
  return {
    descriptor,
    imageId: null,
    label: image.title ?? image.filename ?? image.basename ?? '',
    previewUrl: null,
  };
}

/** Every language of the form with its text (`''` where the entry has none). */
function textsOf(source: Readonly<Record<string, string>>, languages: readonly string[]) {
  return Object.fromEntries(languages.map((code) => [code, source[code] ?? '']));
}

/**
 * The form model of an entry.
 *
 * @param item The entry; `null` for the defaults of a new one.
 * @param languages The languages of the form (the ones of the group and the ones the entry has).
 */
export function toModel(item: CatalogEntry | null, languages: readonly string[]): ItemModel {
  const department = item as Department | null;
  return {
    enabled: item?.enabled ?? true,
    noDiscount: department?.noDiscount ?? false,
    secondaryFiscalPrinter: department?.secondaryFiscalPrinter ?? false,
    code: String(department?.code ?? ''),
    taxId: department?.taxId ?? '',
    name: textsOf(item?.name ?? {}, languages),
    description: textsOf(item?.description ?? {}, languages),
    placeIds: [...(item?.placeIds ?? [])],
    image: logoOf(item?.image),
  };
}

/** Whether two lists hold the same ids, in any order. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** The texts the user filled in, trimmed. */
export function filled(texts: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(texts)
      .map(([code, text]) => [code, text.trim()] as const)
      .filter(([, text]) => text !== ''),
  );
}

/**
 * The texts that differ from the stored ones, for a modification: a text typed is sent as it is,
 * a text emptied is sent as `null` (the language is taken away).
 */
export function changedTexts(
  texts: Readonly<Record<string, string>>,
  stored: Readonly<Record<string, string>>,
): Record<string, string | null> | undefined {
  const changes: Record<string, string | null> = {};
  for (const [code, raw] of Object.entries(texts)) {
    const text = raw.trim();
    if (text !== (stored[code] ?? '')) {
      changes[code] = text === '' ? null : text;
    }
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/**
 * The body of a creation: everything the user filled in. The code is read only when it is a
 * number (the form does not submit otherwise).
 *
 * @param kind Departments or brands.
 * @param model The form model.
 * @param options What the group has.
 */
export function createBody(kind: CatalogKind, model: ItemModel, options: BodyOptions): object {
  const description = filled(model.description);
  const body: Record<string, unknown> = {
    name: filled(model.name),
    enabled: model.enabled,
    placeIds: model.placeIds,
  };
  if (Object.keys(description).length > 0) {
    body['description'] = description;
  }
  if (kind === 'departments') {
    Object.assign(body, {
      code: Number(model.code),
      taxId: model.taxId,
      noDiscount: model.noDiscount,
      secondaryFiscalPrinter: model.secondaryFiscalPrinter,
    });
  }
  if (options.media && model.image?.imageId) {
    body['image'] = { imageId: model.image.imageId };
  }
  return body;
}

/**
 * The body of a modification: only what differs from the stored entry (the texts language by
 * language, the other fields whole).
 *
 * @param kind Departments or brands.
 * @param model The form model.
 * @param item The entry as the server has it.
 * @param options What the group has.
 */
export function patchBody(
  kind: CatalogKind,
  model: ItemModel,
  item: CatalogEntry,
  options: BodyOptions,
): object {
  const body: Record<string, unknown> = {};
  const name = changedTexts(model.name, item.name);
  const description = changedTexts(model.description, item.description);
  if (name !== undefined) {
    body['name'] = name;
  }
  if (description !== undefined) {
    body['description'] = description;
  }
  if (model.enabled !== item.enabled) {
    body['enabled'] = model.enabled;
  }
  if (!sameIds(model.placeIds, item.placeIds)) {
    body['placeIds'] = model.placeIds;
  }
  if (kind === 'departments') {
    const department = item as Department;
    if (String(department.code ?? '') !== model.code.trim()) {
      body['code'] = Number(model.code);
    }
    if ((department.taxId ?? '') !== model.taxId) {
      body['taxId'] = model.taxId;
    }
    if (model.noDiscount !== department.noDiscount) {
      body['noDiscount'] = model.noDiscount;
    }
    if (model.secondaryFiscalPrinter !== department.secondaryFiscalPrinter) {
      body['secondaryFiscalPrinter'] = model.secondaryFiscalPrinter;
    }
  }
  if (options.media) {
    if (model.image === null && item.image) {
      body['image'] = null;
    } else if (model.image?.imageId) {
      body['image'] = { imageId: model.image.imageId };
    }
  }
  return body;
}
