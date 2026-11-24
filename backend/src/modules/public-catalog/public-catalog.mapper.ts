import type { Texts } from '../product-catalog/texts.ts';
import type { AttributeGroup } from '../product-attribute-groups/product-attribute-groups.service.ts';
import type { Brand } from '../product-brands/product-brands.service.ts';
import type { Category, CategoryTreeNode } from '../product-categories/categories.service.ts';
import type { Department } from '../product-departments/product-departments.service.ts';
import type { DuplicateWarning } from '../products/products.service.ts';
import type { ProductFamily, ProductType, ProductView } from '../products/products.mapper.ts';
import type { PriceView } from '../products/products.pricing.ts';
import type { CreateProductBody, PatchProductBody } from '../products/products.schemas.ts';
import type { CreateCategoryBody, PatchCategoryBody } from '../product-categories/categories.schemas.ts';
import type { PublicCreateCategoryBody, PublicCreateProductBody, PublicPatchCategoryBody, PublicPatchProductBody } from './public-catalog.schemas.ts';

/** What the public representation of a product is built from: the view of the backoffice without the costs, the suppliers and the simple cost (the type refuses them), with the warnings of the code, PLU and barcodes when the answer has them. */
export type ProductSource = Omit<ProductView, 'costs' | 'suppliers' | 'simpleCost'> & { readonly warnings?: readonly DuplicateWarning[] };

/** The state of a product as an integration sees it: `trashed` wins over `disabled`. */
export type PublicProductStatus = 'active' | 'disabled' | 'trashed';

/** A price rule as the public API shows it: in cents, tax included, with the tax rate of the rule. */
export interface PublicPrice {
  readonly id: string | null;
  readonly priceListId: string | null;
  readonly currency: string | null;
  readonly taxId: string | null;
  /** The tax rate of the rule, in percent; read only (the rate is the one of the group's tax `taxId`). */
  readonly taxRatePercent: number | null;
  /** The price with tax, in cents. */
  readonly grossCents: number | null;
  readonly discountPercent: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly dailyFrom: string | null;
  readonly dailyTo: string | null;
  readonly weekDays: readonly number[];
  readonly fromQuantity: number | null;
  readonly maxSaleQuantity: number | null;
}

/** A product as the public API shows it: field by field, never the costs, the suppliers, the images, the stations of the orders, the settings of the rooms, the bill of materials or an internal datum. */
export interface PublicProduct {
  readonly id: string;
  readonly family: ProductFamily;
  readonly type: ProductType | null;
  readonly isModifier: boolean;
  readonly status: PublicProductStatus;
  readonly code: string | null;
  readonly plu?: string | null;
  readonly name: Texts;
  readonly shortName: Texts;
  readonly description: Texts;
  readonly shortDescription: Texts;
  readonly favorite: boolean;
  readonly generic: boolean;
  readonly noDiscount: boolean;
  readonly brandId: string | null;
  readonly categoryIds: readonly string[];
  readonly attributeIds: readonly string[];
  readonly position: number | null;
  readonly duration?: string | null;
  readonly maxConcurrent?: number | null;
  readonly availability?: { readonly pos?: boolean; readonly warehouse?: boolean; readonly scales?: boolean; readonly ecommerce?: boolean };
  readonly featured?: boolean;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly modifier?: { readonly type: string | null; readonly pricePercentagePlus: number | null; readonly pricePercentageMinus: number | null; readonly description: Texts };
  readonly requiredModifierIds?: readonly string[];
  readonly modifierIds?: readonly string[];
  readonly excludedModifierIds?: readonly string[];
  readonly modifierCategoryIds?: readonly string[];
  readonly scaleType?: 'weight' | 'piece' | null;
  readonly loadUnit?: string | null;
  readonly unloadUnit?: string | null;
  readonly conversionRatio?: number | null;
  readonly barcodes: ReadonlyArray<{ readonly value: string; readonly saleQuantity: number | null }>;
  readonly prices: readonly PublicPrice[];
  readonly places: ReadonlyArray<{ readonly placeId: string; readonly favorite: boolean; readonly position: number | null }>;
  readonly menu?: ReadonlyArray<{ readonly categoryId: string | null; readonly quantity: number | null; readonly productIds: readonly string[] }>;
  readonly modifierChoices?: ReadonlyArray<{ readonly categoryId: string | null; readonly freeQuantity: number | null; readonly priceRule: string | null; readonly productIds: readonly string[] }>;
  readonly modularPriceRule?: string | null;
  readonly shipping: { readonly width: number | null; readonly height: number | null; readonly depth: number | null; readonly weight: number | null };
  /** Whether the key may modify the product as a whole (computed by the server). */
  readonly editable: boolean;
  readonly trashedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** Only in the answers of a read of one product and of a write: a code, a PLU or a barcode other products use too (never which products). */
  readonly warnings?: ReadonlyArray<{ readonly field: string; readonly issue: 'duplicate' }>;
}

/** The ids of the other products a product refers to (modifiers, menus, choices): the ones the public representation shows only when the key reaches them. */
export function referencedProductIds(product: ProductSource): string[] {
  return [
    ...(product.requiredModifierIds ?? []),
    ...(product.modifierIds ?? []),
    ...(product.excludedModifierIds ?? []),
    ...(product.menu ?? []).flatMap((choice) => choice.productIds),
    ...(product.modifierChoices ?? []).flatMap((choice) => choice.productIds),
  ];
}

/**
 * The price in cents of a price in units of currency: rounded to the cent (the tolerance of a binary fraction), `null` when there is none.
 *
 * @param amount The amount, in units of currency.
 */
export function centsOf(amount: number | null): number | null {
  return amount === null ? null : Math.round(Number((amount * 100).toFixed(6)));
}

/**
 * The public price of a rule of a product.
 *
 * @param price The rule as the domain shows it.
 */
export function toPublicPrice(price: PriceView): PublicPrice {
  return {
    id: price.id,
    priceListId: price.priceListId,
    currency: price.currency,
    taxId: price.taxId,
    taxRatePercent: price.tax?.rate ?? null,
    grossCents: centsOf(price.gross),
    discountPercent: price.discount,
    validFrom: price.validFrom,
    validTo: price.validTo,
    dailyFrom: price.dailyFrom,
    dailyTo: price.dailyTo,
    weekDays: price.weekDays,
    fromQuantity: price.fromQuantity,
    maxSaleQuantity: price.maxSaleQuantity,
  };
}

/**
 * The public representation of a product, field by field: whatever else the view holds is never in the result. The references to other products are only the ones in `reachable`.
 *
 * @param product The product.
 * @param reachable The ids of the referenced products the key reaches.
 */
export function toPublicProduct(product: ProductSource, reachable: ReadonlySet<string>): PublicProduct {
  const keep = (ids: readonly string[]): string[] => ids.filter((id) => reachable.has(id));
  return {
    id: product.id,
    family: product.family,
    type: product.type,
    isModifier: product.isModifier,
    status: product.trashed ? 'trashed' : product.enabled ? 'active' : 'disabled',
    code: product.code,
    ...(product.plu === undefined ? {} : { plu: product.plu }),
    name: product.name,
    shortName: product.shortName,
    description: product.description,
    shortDescription: product.shortDescription,
    favorite: product.favorite,
    generic: product.generic,
    noDiscount: product.noDiscount,
    brandId: product.brandId,
    categoryIds: product.categoryIds,
    attributeIds: product.attributeIds,
    position: product.position,
    ...(product.duration === undefined ? {} : { duration: product.duration }),
    ...(product.maxConcurrent === undefined ? {} : { maxConcurrent: product.maxConcurrent }),
    ...(product.availability === undefined ? {} : { availability: { ...product.availability } }),
    ...(product.featured === undefined ? {} : { featured: product.featured }),
    validFrom: product.validFrom,
    validTo: product.validTo,
    ...(product.modifier === undefined ? {} : { modifier: { type: product.modifier.type, pricePercentagePlus: product.modifier.pricePercentagePlus, pricePercentageMinus: product.modifier.pricePercentageMinus, description: product.modifier.description } }),
    ...(product.requiredModifierIds === undefined ? {} : { requiredModifierIds: keep(product.requiredModifierIds) }),
    ...(product.modifierIds === undefined ? {} : { modifierIds: keep(product.modifierIds) }),
    ...(product.excludedModifierIds === undefined ? {} : { excludedModifierIds: keep(product.excludedModifierIds) }),
    ...(product.modifierCategoryIds === undefined ? {} : { modifierCategoryIds: product.modifierCategoryIds }),
    ...(product.scaleType === undefined ? {} : { scaleType: product.scaleType }),
    ...(product.loadUnit === undefined ? {} : { loadUnit: product.loadUnit }),
    ...(product.unloadUnit === undefined ? {} : { unloadUnit: product.unloadUnit }),
    ...(product.conversionRatio === undefined ? {} : { conversionRatio: product.conversionRatio }),
    barcodes: product.barcodes.map((barcode) => ({ value: barcode.value, saleQuantity: barcode.saleQuantity })),
    prices: product.prices.map(toPublicPrice),
    places: product.places.map((place) => ({ placeId: place.placeId, favorite: place.favorite, position: place.position })),
    ...(product.menu === undefined ? {} : { menu: product.menu.map((choice) => ({ categoryId: choice.categoryId, quantity: choice.quantity, productIds: keep(choice.productIds) })) }),
    ...(product.modifierChoices === undefined ? {} : { modifierChoices: product.modifierChoices.map((choice) => ({ categoryId: choice.categoryId, freeQuantity: choice.freeQuantity, priceRule: choice.priceRule, productIds: keep(choice.productIds) })) }),
    ...(product.modularPriceRule === undefined ? {} : { modularPriceRule: product.modularPriceRule }),
    shipping: { width: product.shipping.width, height: product.shipping.height, depth: product.shipping.depth, weight: product.shipping.weight },
    editable: product.editable,
    trashedAt: product.trashedAt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    ...(product.warnings === undefined ? {} : { warnings: product.warnings.map((warning) => ({ field: warning.field, issue: warning.issue })) }),
  };
}

/** The stock of a product in one storage of one place, as the public API shows it. */
export interface PublicStockRow {
  readonly placeId: string;
  readonly storageId: string;
  readonly quantity: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly location: string | null;
}

/** The stock of a product: a row for each storage of each place the key reaches. */
export interface PublicStock {
  readonly productId: string;
  readonly code: string | null;
  readonly updatedAt: string | null;
  readonly stock: readonly PublicStockRow[];
}

/**
 * The public stock of a product: flat rows by place and storage, only the places the view holds (the ones of the perimeter of the key).
 *
 * @param product The product, read with the stock: only the callers that have checked that the group has the `warehouse` function reach this.
 */
export function toPublicStock(product: ProductSource): PublicStock {
  return {
    productId: product.id,
    code: product.code,
    updatedAt: product.updatedAt,
    stock: Object.entries(product.stock!).flatMap(([placeId, storages]) =>
      Object.entries(storages).map(([storageId, entry]) => ({ placeId, storageId, quantity: entry.quantity, min: entry.min, max: entry.max, location: entry.location })),
    ),
  };
}

/** A category as the public API shows it. */
export interface PublicCategory {
  readonly id: string;
  readonly name: Texts;
  readonly description: Texts;
  readonly status: 'active' | 'disabled';
  readonly parentId: string | null;
  readonly position: number | null;
  readonly availability?: { readonly pos?: boolean; readonly ecommerce?: boolean };
  readonly noDiscount: boolean;
  readonly requiresLegalAge: boolean;
  readonly featured?: boolean;
  readonly tobacco?: boolean;
  readonly modifierIds?: readonly string[];
  readonly modifierCategoryIds?: readonly string[];
  readonly places: ReadonlyArray<{ readonly placeId: string; readonly position: number | null }>;
  /** Whether the key may modify the category as a whole (computed by the server). */
  readonly editable: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * The public representation of a category, field by field. The modifiers are only the ones in `reachable`.
 *
 * @param category The category.
 * @param reachable The ids of the modifiers the key reaches.
 */
export function toPublicCategory(category: Category, reachable: ReadonlySet<string>): PublicCategory {
  return {
    id: category.id,
    name: category.name,
    description: category.description,
    status: category.enabled ? 'active' : 'disabled',
    parentId: category.parentId,
    position: category.position,
    ...(category.availability === undefined ? {} : { availability: { ...category.availability } }),
    noDiscount: category.noDiscount,
    requiresLegalAge: category.requiresLegalAge,
    ...(category.featured === undefined ? {} : { featured: category.featured }),
    ...(category.tobacco === undefined ? {} : { tobacco: category.tobacco }),
    ...(category.modifierIds === undefined ? {} : { modifierIds: category.modifierIds.filter((id) => reachable.has(id)) }),
    ...(category.modifierCategoryIds === undefined ? {} : { modifierCategoryIds: category.modifierCategoryIds }),
    places: category.places.map((place) => ({ placeId: place.placeId, position: place.position })),
    editable: category.editable,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

/** A category in the compact tree of the public API. */
export interface PublicCategoryNode {
  readonly id: string;
  readonly name: string | null;
  readonly parentId: string | null;
  readonly position: number | null;
  readonly status: 'active' | 'disabled';
  readonly children: readonly PublicCategoryNode[];
}

/**
 * The public node of the tree of the categories, with its children.
 *
 * @param node The node of the tree.
 */
export function toPublicCategoryNode(node: CategoryTreeNode): PublicCategoryNode {
  return { id: node.id, name: node.name, parentId: node.parentId, position: node.position, status: node.enabled ? 'active' : 'disabled', children: node.children.map(toPublicCategoryNode) };
}

/** A brand as the public API shows it. */
export interface PublicBrand {
  readonly id: string;
  readonly name: Texts;
  readonly description: Texts;
  readonly status: 'active' | 'disabled';
  /** The places the brand is for, empty for every place (only the ones of the key). */
  readonly placeIds: readonly string[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * The public representation of a brand, without its image.
 *
 * @param brand The brand.
 */
export function toPublicBrand(brand: Brand): PublicBrand {
  return { id: brand.id, name: brand.name, description: brand.description, status: brand.enabled ? 'active' : 'disabled', placeIds: brand.placeIds, createdAt: brand.createdAt, updatedAt: brand.updatedAt };
}

/** A group of attributes as the public API shows it. */
export interface PublicAttributeGroup {
  readonly id: string;
  readonly name: Texts;
  readonly attributes: ReadonlyArray<{ readonly id: string; readonly name: Texts }>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * The public representation of a group of attributes.
 *
 * @param group The group of attributes.
 */
export function toPublicAttributeGroup(group: AttributeGroup): PublicAttributeGroup {
  return { id: group.id, name: group.name, attributes: group.attributes.map((attribute) => ({ id: attribute.id, name: attribute.name })), createdAt: group.createdAt, updatedAt: group.updatedAt };
}

/** A department as the public API shows it. */
export interface PublicDepartment {
  readonly id: string;
  readonly code: number | null;
  readonly name: Texts;
  readonly description: Texts;
  readonly status: 'active' | 'disabled';
  readonly taxId: string | null;
  readonly taxRatePercent: number | null;
  readonly noDiscount: boolean;
  readonly placeIds: readonly string[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * The public representation of a department, without its image and its fiscal settings.
 *
 * @param department The department.
 */
export function toPublicDepartment(department: Department): PublicDepartment {
  return {
    id: department.id,
    code: department.code,
    name: department.name,
    description: department.description,
    status: department.enabled ? 'active' : 'disabled',
    taxId: department.taxId,
    taxRatePercent: department.tax?.rate ?? null,
    noDiscount: department.noDiscount,
    placeIds: department.placeIds,
    createdAt: department.createdAt,
    updatedAt: department.updatedAt,
  };
}

/**
 * The price of the body of the services from a public price: the gross amount in units of currency (cents over a hundred, exact to the cent), the server works out the amount without tax.
 *
 * @param price The price of the public body.
 */
export function toPriceInput(price: NonNullable<PublicCreateProductBody['prices']>[number]): NonNullable<CreateProductBody['prices']>[number] {
  return {
    ...(price.id === undefined ? {} : { id: price.id }),
    priceListId: price.priceListId,
    currency: price.currency,
    taxId: price.taxId,
    gross: price.grossCents / 100,
    ...(price.discountPercent === undefined ? {} : { discount: price.discountPercent }),
    ...(price.validFrom === undefined ? {} : { validFrom: price.validFrom }),
    ...(price.validTo === undefined ? {} : { validTo: price.validTo }),
    ...(price.dailyFrom === undefined ? {} : { dailyFrom: price.dailyFrom }),
    ...(price.dailyTo === undefined ? {} : { dailyTo: price.dailyTo }),
    ...(price.weekDays === undefined ? {} : { weekDays: price.weekDays }),
    ...(price.fromQuantity === undefined ? {} : { fromQuantity: price.fromQuantity }),
    ...(price.maxSaleQuantity === undefined ? {} : { maxSaleQuantity: price.maxSaleQuantity }),
  };
}

/**
 * The body of the services of the products from a public one: `status` becomes `enabled` and the prices in cents become amounts in units of currency.
 *
 * @param body The validated public body of a creation.
 */
export function toCreateProductBody(body: PublicCreateProductBody): CreateProductBody {
  const { status, prices, ...rest } = body;
  return { ...rest, ...(status === undefined ? {} : { enabled: status === 'active' }), ...(prices === undefined ? {} : { prices: prices.map(toPriceInput) }) };
}

/**
 * The body of the services of the products from a public one, for a modification.
 *
 * @param body The validated public body of a modification.
 */
export function toPatchProductBody(body: PublicPatchProductBody): PatchProductBody {
  const { status, prices, ...rest } = body;
  return { ...rest, ...(status === undefined ? {} : { enabled: status === 'active' }), ...(prices === undefined ? {} : { prices: prices.map(toPriceInput) }) };
}

/**
 * The body of the services of the categories from a public one (`status` becomes `enabled`).
 *
 * @param body The validated public body of a creation.
 */
export function toCreateCategoryBody(body: PublicCreateCategoryBody): CreateCategoryBody {
  const { status, ...rest } = body;
  return { ...rest, ...(status === undefined ? {} : { enabled: status === 'active' }) };
}

/**
 * The body of the services of the categories from a public one, for a modification.
 *
 * @param body The validated public body of a modification.
 */
export function toPatchCategoryBody(body: PublicPatchCategoryBody): PatchCategoryBody {
  const { status, ...rest } = body;
  return { ...rest, ...(status === undefined ? {} : { enabled: status === 'active' }) };
}
