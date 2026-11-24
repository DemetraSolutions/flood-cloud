import type { ObjectId } from 'mongodb';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';
import type { EntityResult } from '../product-catalog/entity.service.ts';
import type { AttributeGroupsService } from '../product-attribute-groups/product-attribute-groups.service.ts';
import type { BrandsService } from '../product-brands/product-brands.service.ts';
import type { CategoriesService } from '../product-categories/categories.service.ts';
import type { DepartmentsService } from '../product-departments/product-departments.service.ts';
import type { ProductsService } from '../products/products.service.ts';
import type { ApiKeyCallers } from './public-catalog.caller.ts';
import { preserveCategory, preserveProduct } from './public-catalog.preserve.ts';
import {
  referencedProductIds,
  toCreateCategoryBody,
  toCreateProductBody,
  toPatchCategoryBody,
  toPatchProductBody,
  toPublicAttributeGroup,
  toPublicBrand,
  toPublicCategory,
  toPublicCategoryNode,
  toPublicDepartment,
  toPublicProduct,
  toPublicStock,
} from './public-catalog.mapper.ts';
import type { ProductSource, PublicAttributeGroup, PublicBrand, PublicCategory, PublicCategoryNode, PublicDepartment, PublicProduct, PublicStock } from './public-catalog.mapper.ts';
import { PUBLIC_CATALOG_DEFAULT_PAGE, PUBLIC_PRODUCTS_DEFAULT_PAGE } from './public-catalog.schemas.ts';
import type { PublicChangesQuery, PublicCreateCategoryBody, PublicCreateProductBody, PublicPatchCategoryBody, PublicPatchProductBody, PublicProductsQuery, PublicStockQuery } from './public-catalog.schemas.ts';

/** A page of public entries. */
export interface PublicCatalogPage<T> {
  readonly items: readonly T[];
  readonly page: PageInfo;
}

/** An entry with its version (the `ETag` of the response, the `If-Match` of the next write). */
export type PublicEntry<T> = { readonly entity: T; readonly version: string };

/**
 * The catalog of the public API (`doc/Public-API.md`): what an integration with a public key reads (`catalog:read`) and writes (`catalog:write`). Every operation goes through the same services of the backoffice, with all their
 * rules, as a caller built from the key alone ({@link ApiKeyCallers}); the group is the one of the key, never a value of the client. A read without `updatedSince` lists what is active; with it, everything changed from that
 * instant, the disabled and the trashed ones included, so the integration can take them away (an entry deleted for good cannot be told).
 */
export interface PublicCatalogService {
  listProducts(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicProductsQuery): Promise<PublicCatalogPage<PublicProduct>>;
  getProduct(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicProduct>>;
  /** @throws {AppError} `FEATURE_DISABLED` in a group without the `warehouse` function. */
  getProductStock(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicStock>;
  /** @throws {AppError} `FEATURE_DISABLED` in a group without the `warehouse` function. */
  listStock(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicStockQuery): Promise<PublicCatalogPage<PublicStock>>;
  createProduct(principal: ApiKeyPrincipal, access: GroupAccess, body: PublicCreateProductBody, client: ClientContext): Promise<PublicEntry<PublicProduct>>;
  updateProduct(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, body: PublicPatchProductBody, client: ClientContext): Promise<PublicEntry<PublicProduct>>;
  trashProduct(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<PublicEntry<PublicProduct>>;
  restoreProduct(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<PublicEntry<PublicProduct>>;
  listCategories(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicChangesQuery): Promise<PublicCatalogPage<PublicCategory>>;
  categoryTree(principal: ApiKeyPrincipal, access: GroupAccess): Promise<PublicCategoryNode[]>;
  getCategory(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicCategory>>;
  createCategory(principal: ApiKeyPrincipal, access: GroupAccess, body: PublicCreateCategoryBody, client: ClientContext): Promise<PublicEntry<PublicCategory>>;
  updateCategory(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, body: PublicPatchCategoryBody, client: ClientContext): Promise<PublicEntry<PublicCategory>>;
  deleteCategory(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<void>;
  listBrands(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicChangesQuery): Promise<PublicCatalogPage<PublicBrand>>;
  getBrand(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicBrand>>;
  listAttributeGroups(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicChangesQuery): Promise<PublicCatalogPage<PublicAttributeGroup>>;
  getAttributeGroup(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicAttributeGroup>>;
  /** @throws {AppError} `FEATURE_DISABLED` in a group without the `cash` function. */
  listDepartments(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicChangesQuery): Promise<PublicCatalogPage<PublicDepartment>>;
  /** @throws {AppError} `FEATURE_DISABLED` in a group without the `cash` function. */
  getDepartment(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicDepartment>>;
}

/** Collaborators of {@link createPublicCatalogService}: the services of the catalog, already wrapped by the rule of the single place. */
export interface PublicCatalogServiceDeps {
  readonly products: Pick<ProductsService, 'listChanges' | 'get' | 'create' | 'update' | 'trash' | 'restore' | 'reachableIds'>;
  readonly categories: Pick<CategoriesService, 'listChanges' | 'tree' | 'get' | 'create' | 'update' | 'remove'>;
  readonly brands: Pick<BrandsService, 'listChanges' | 'get'>;
  readonly attributeGroups: Pick<AttributeGroupsService, 'listChanges' | 'get'>;
  readonly departments: Pick<DepartmentsService, 'listChanges' | 'get'>;
  readonly callers: ApiKeyCallers;
}

/**
 * Builds the catalog service of the public API.
 *
 * @param deps The services of the catalog and the factory of the callers of the keys.
 */
export function createPublicCatalogService(deps: PublicCatalogServiceDeps): PublicCatalogService {
  const { products, categories, brands, attributeGroups, departments, callers } = deps;
  const limited = <Q extends { readonly limit?: number }>(query: Q, fallback: number): Q & { readonly limit: number } => ({ ...query, limit: query.limit ?? fallback });
  const requireFeature = (access: GroupAccess, feature: 'cash' | 'warehouse'): void => {
    if (!access.features[feature]) {
      throw new AppError('FEATURE_DISABLED');
    }
  };
  /** The public products, with the references to other products only when the key reaches them (one read for the whole page). */
  const presentProducts = async (caller: Awaited<ReturnType<ApiKeyCallers['callerOf']>>, access: GroupAccess, items: readonly ProductSource[]): Promise<PublicProduct[]> => {
    const reachable = await products.reachableIds(caller, access, [...new Set(items.flatMap(referencedProductIds))]);
    return items.map((item) => toPublicProduct(item, reachable));
  };
  const productResult = async (caller: Awaited<ReturnType<ApiKeyCallers['callerOf']>>, access: GroupAccess, result: { readonly entity: ProductSource; readonly version: string }): Promise<PublicEntry<PublicProduct>> => ({
    entity: (await presentProducts(caller, access, [result.entity]))[0]!,
    version: result.version,
  });
  const categoryResult = async (caller: Awaited<ReturnType<ApiKeyCallers['callerOf']>>, access: GroupAccess, result: EntityResult<Parameters<typeof toPublicCategory>[0]>): Promise<PublicEntry<PublicCategory>> => {
    const reachable = await products.reachableIds(caller, access, [...(result.entity.modifierIds ?? [])]);
    return { entity: toPublicCategory(result.entity, reachable), version: result.version };
  };

  return {
    listProducts: async (principal, access, query) => {
      const caller = await callers.callerOf(principal);
      const { items, page } = await products.listChanges(caller, access, { ...limited(query, PUBLIC_PRODUCTS_DEFAULT_PAGE), activeOnly: query.updatedSince === undefined });
      return { items: await presentProducts(caller, access, items), page };
    },
    getProduct: async (principal, access, id) => {
      const caller = await callers.callerOf(principal);
      return productResult(caller, access, await products.get(caller, access, id));
    },
    getProductStock: async (principal, access, id) => {
      requireFeature(access, 'warehouse');
      return toPublicStock((await products.get(await callers.callerOf(principal), access, id)).entity);
    },
    listStock: async (principal, access, query) => {
      requireFeature(access, 'warehouse');
      const { items, page } = await products.listChanges(await callers.callerOf(principal), access, { ...limited(query, PUBLIC_PRODUCTS_DEFAULT_PAGE), stockOnly: true });
      return { items: items.map(toPublicStock), page };
    },
    createProduct: async (principal, access, body, client) => {
      const caller = await callers.callerOf(principal);
      return productResult(caller, access, await products.create(caller, access, toCreateProductBody(body), client));
    },
    updateProduct: async (principal, access, id, expected, body, client) => {
      const caller = await callers.callerOf(principal);
      // What the key does not see stays as it is: the body is completed with the stored values of the fields that are not in the public representation.
      const got = await products.get(caller, access, id);
      // The completion is made on the version the client read, the one `update` checks and writes over.
      if (got.version !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const current = got.entity;
      const reachable = await products.reachableIds(caller, access, referencedProductIds(current));
      return productResult(caller, access, await products.update(caller, access, id, expected, preserveProduct(toPatchProductBody(body), current, reachable, access.features), client));
    },
    trashProduct: async (principal, access, id, expected, client) => {
      const caller = await callers.callerOf(principal);
      return productResult(caller, access, await products.trash(caller, access, id, expected, client));
    },
    restoreProduct: async (principal, access, id, expected, client) => {
      const caller = await callers.callerOf(principal);
      return productResult(caller, access, await products.restore(caller, access, id, expected, client));
    },
    listCategories: async (principal, access, query) => {
      const caller = await callers.callerOf(principal);
      const { items, page } = await categories.listChanges(caller, access, { ...limited(query, PUBLIC_CATALOG_DEFAULT_PAGE), activeOnly: query.updatedSince === undefined });
      const reachable = await products.reachableIds(caller, access, [...new Set(items.flatMap((item) => item.modifierIds ?? []))]);
      return { items: items.map((item) => toPublicCategory(item, reachable)), page };
    },
    categoryTree: async (principal, access) => (await categories.tree(await callers.callerOf(principal), access)).map(toPublicCategoryNode),
    getCategory: async (principal, access, id) => {
      const caller = await callers.callerOf(principal);
      return categoryResult(caller, access, await categories.get(caller, access, id));
    },
    createCategory: async (principal, access, body, client) => {
      const caller = await callers.callerOf(principal);
      return categoryResult(caller, access, await categories.create(caller, access, toCreateCategoryBody(body), client));
    },
    updateCategory: async (principal, access, id, expected, body, client) => {
      const caller = await callers.callerOf(principal);
      const got = await categories.get(caller, access, id);
      if (got.version !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const current = got.entity;
      const reachable = await products.reachableIds(caller, access, [...(current.modifierIds ?? [])]);
      return categoryResult(caller, access, await categories.update(caller, access, id, expected, preserveCategory(toPatchCategoryBody(body), current, reachable), client));
    },
    deleteCategory: async (principal, access, id, client) => categories.remove(await callers.callerOf(principal), access, id, client),
    listBrands: async (principal, access, query) => {
      const { items, page } = await brands.listChanges(await callers.callerOf(principal), access, { ...limited(query, PUBLIC_CATALOG_DEFAULT_PAGE), activeOnly: query.updatedSince === undefined });
      return { items: items.map(toPublicBrand), page };
    },
    getBrand: async (principal, access, id) => {
      const found = await brands.get(await callers.callerOf(principal), access, id);
      return { entity: toPublicBrand(found.entity), version: found.version };
    },
    listAttributeGroups: async (principal, access, query) => {
      const { items, page } = await attributeGroups.listChanges(await callers.callerOf(principal), access, limited(query, PUBLIC_CATALOG_DEFAULT_PAGE));
      return { items: items.map(toPublicAttributeGroup), page };
    },
    getAttributeGroup: async (principal, access, id) => {
      const found = await attributeGroups.get(await callers.callerOf(principal), access, id);
      return { entity: toPublicAttributeGroup(found.entity), version: found.version };
    },
    listDepartments: async (principal, access, query) => {
      requireFeature(access, 'cash');
      const { items, page } = await departments.listChanges(await callers.callerOf(principal), access, { ...limited(query, PUBLIC_CATALOG_DEFAULT_PAGE), activeOnly: query.updatedSince === undefined });
      return { items: items.map(toPublicDepartment), page };
    },
    getDepartment: async (principal, access, id) => {
      requireFeature(access, 'cash');
      const found = await departments.get(await callers.callerOf(principal), access, id);
      return { entity: toPublicDepartment(found.entity), version: found.version };
    },
  };
}
