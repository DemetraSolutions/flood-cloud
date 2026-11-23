/** The two catalog resources that share the list and the detail pages. */
export type CatalogKind = 'departments' | 'brands';

/** What tells the departments from the brands in the shared pages. */
export interface KindSettings {
  /** Path segment of the resource, under `/v1/groups/{groupId}` and under `/groups/:groupId` in the router. */
  readonly segment: string;
  /** Name of the group of dictionary keys (`PRODUCT_CATALOG.<text>.*`). */
  readonly text: 'DEPARTMENTS' | 'BRANDS';
  /** Sort keys the server accepts, besides the descending form. */
  readonly sortKeys: readonly string[];
}

/** The settings of each kind. */
export const KINDS: Readonly<Record<CatalogKind, KindSettings>> = Object.freeze({
  departments: { segment: 'product-departments', text: 'DEPARTMENTS', sortKeys: ['name', 'code'] },
  brands: { segment: 'product-brands', text: 'BRANDS', sortKeys: ['name'] },
});

/** Segment of the attribute groups under `/v1/groups/{groupId}`. */
export const ATTRIBUTE_GROUPS_SEGMENT = 'product-attribute-groups';

/** Texts by language: `{ "it": "Bibite", "en": "Drinks" }`. */
export type LocalizedText = Readonly<Record<string, string>>;

/** The image of a department or brand as the server returns it (the descriptor of the library file). */
export interface CatalogImage {
  readonly _id: string | null;
  readonly basename: string | null;
  readonly extension: string | null;
  readonly filename: string | null;
  readonly mimetype: string | null;
  readonly title: string | null;
  readonly alt: string | null;
  readonly dirname: string | null;
  readonly type: string | null;
  readonly filectime: number | null;
}

/** What departments and brands have in common. */
export interface CatalogItem {
  readonly id: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  /** The state of the entry (`status` in the stored document). */
  readonly enabled: boolean;
  /** Stores the entry is for; empty means every store. A company or store administrator receives only their own. */
  readonly placeIds: readonly string[];
  /** Only for the groups with the `media` feature. */
  readonly image?: CatalogImage | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /**
   * Whether the caller may change and delete the entry (computed by the server: a company or
   * store administrator changes only the entries that are for their stores alone). Absent
   * means yes. This is the only place that names the field.
   */
  readonly editable?: boolean;
}

/** The copy of the tax rate a department holds (read only). */
export interface DepartmentTax {
  readonly rate: number | null;
  readonly department: number | null;
  readonly vatNature: string | null;
  readonly description: string | null;
}

/** A department of the cash register. */
export interface Department extends CatalogItem {
  /** Number on the register; `null` for a stored code that is not a whole number. */
  readonly code: number | null;
  readonly taxId: string | null;
  readonly tax: DepartmentTax | null;
  readonly noDiscount: boolean;
  readonly secondaryFiscalPrinter: boolean;
}

/** A brand. */
export type Brand = CatalogItem;

/** A department or a brand. */
export type CatalogEntry = Department | Brand;

/** An attribute of a group. */
export interface Attribute {
  readonly id: string;
  readonly name: LocalizedText;
}

/** A group of attributes with its attributes. */
export interface AttributeGroup {
  readonly id: string;
  readonly name: LocalizedText;
  readonly attributes: readonly Attribute[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** An entry with the version (`ETag`) the next write must present in `If-Match`. */
export interface Versioned<T> {
  readonly item: T;
  readonly etag: string | null;
}

/** A tax rate of the group, as the departments offer it (`GET /v1/groups/{groupId}/taxes`). */
export interface GroupTax {
  readonly id: string;
  readonly rate: number;
  readonly department: number | null;
  readonly description: string | null;
  readonly vatNature: string | null;
}

/** Limits of the server (`doc/API.md`). */
export const CATALOG_LIMITS = Object.freeze({
  name: 150,
  description: 1000,
  attributes: 200,
});

/** Language the interface and the texts fall back to. */
export const FALLBACK_LANGUAGE = 'it';

/** Every control character, refused in a name. */
const NAME_CONTROL = /[\u0000-\u001F\u007F]/;

/** Control characters other than tab, carriage return and line feed, refused in a description. */
const DESCRIPTION_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Whether a name holds a control character. */
export function hasNameControl(value: string): boolean {
  return NAME_CONTROL.test(value);
}

/** Whether a description holds a control character the server refuses. */
export function hasDescriptionControl(value: string): boolean {
  return DESCRIPTION_CONTROL.test(value);
}

/**
 * Router link of the list of a kind, of one entry, or of the page of a new one.
 *
 * @param groupId Group of the entries.
 * @param kind Departments or brands.
 * @param itemId The entry; `null` for the page of a new one, omitted for the list.
 */
export function catalogRoute(groupId: string, kind: CatalogKind, itemId?: string | null): string[] {
  const base = ['/groups', groupId, KINDS[kind].segment];
  return itemId === undefined ? base : [...base, itemId === null ? 'new' : itemId];
}

/** Router link of the page of the attribute groups. */
export function attributesRoute(groupId: string): string[] {
  return ['/groups', groupId, ATTRIBUTE_GROUPS_SEGMENT];
}

/**
 * The text of a tax rate as the legacy form showed it: `<value>% - Rep.<n> - <nature> | <description>`;
 * the parts the rate does not have are left out.
 */
export function taxLabel(tax: {
  readonly rate: number | null;
  readonly department: number | null;
  readonly vatNature: string | null;
  readonly description: string | null;
}): string {
  const parts = [
    tax.rate === null ? '' : `${tax.rate}%`,
    tax.department === null ? '' : `Rep.${tax.department}`,
    tax.vatNature ?? '',
  ].filter((part) => part !== '');
  const base = parts.join(' - ');
  return tax.description === null ? base : `${base} | ${tax.description}`;
}

/**
 * The text of an entry to show: the one in the preferred language, otherwise the first the entry has.
 *
 * @param texts Texts by language.
 * @param preferred Language of the user.
 */
export function textOf(texts: LocalizedText, preferred: string): string {
  return texts[preferred] ?? Object.values(texts)[0] ?? '';
}

/**
 * The language a name must be given in on creation: the one of the user when the group has it,
 * otherwise the first of the group.
 *
 * @param groupLanguages Languages of the group (never empty).
 * @param preferred Language of the user.
 */
export function requiredLanguage(groupLanguages: readonly string[], preferred: string): string {
  return groupLanguages.includes(preferred) ? preferred : groupLanguages[0];
}

/** Whether the server lets the caller change and delete an entry (`true` when it does not say otherwise). */
export function isEditable(item: { readonly editable?: boolean }): boolean {
  return item.editable !== false;
}
