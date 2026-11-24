import type { ObjectId } from 'mongodb';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';
import type { StoreCaller, StoreOperator } from '../product-catalog/caller.ts';
import type { EntityPage, EntityResult } from '../product-catalog/entity.service.ts';
import type { CategoriesService, Category, CategoryTreeNode } from '../product-categories/categories.service.ts';
import type { CreateCategoryBody, PatchCategoryBody } from '../product-categories/categories.schemas.ts';
import type { AttributeGroup, AttributeGroupsService } from '../product-attribute-groups/product-attribute-groups.service.ts';
import type { Brand, BrandsService } from '../product-brands/product-brands.service.ts';
import type { CreateBrandBody, PatchBrandBody } from '../product-brands/product-brands.schemas.ts';
import type { Department, DepartmentsService } from '../product-departments/product-departments.service.ts';
import type { CreateProductBody, PatchProductBody } from '../products/products.schemas.ts';
import type { ProductsService } from '../products/products.service.ts';
import { toStoreProductResult } from './store-catalog.mapper.ts';
import type { StoreProduct, StoreProductResult } from './store-catalog.mapper.ts';
import { STORE_CATEGORIES_DEFAULT_PAGE, STORE_ENTITIES_DEFAULT_PAGE, STORE_PRODUCTS_DEFAULT_PAGE } from './store-catalog.schemas.ts';
import type { StoreAttributeGroupsQuery, StoreBrandsQuery, StoreCategoriesQuery, StoreDepartmentsQuery, StoreProductsQuery } from './store-catalog.schemas.ts';

/** A page of products for a store. */
export interface StoreProductPage {
  readonly items: readonly StoreProduct[];
  readonly page: PageInfo;
}

/**
 * The catalog of the point of sale of a store key: what its server reads (the products, the categories and the departments available in its place or for every place) and writes (products and
 * categories). Every operation goes through the same service of the backoffice, with all of its rules, as a caller limited to one place (`StoreCaller`): the ids of the group, the company and the place
 * come from the store principal alone. A write needs the operator that the `operator` check of the route verified; a read needs none.
 */
export interface StoreCatalogService {
  /** A page of the whole products of the place, oldest change first; with `updatedSince` those changed from that instant, the ones in the trash and the disabled ones included. */
  listProducts(store: StorePrincipal, access: GroupAccess, query: StoreProductsQuery): Promise<StoreProductPage>;
  /** One product with its version. @throws {AppError} `NOT_FOUND` for a product that does not exist, is in another place or in another group. */
  getProduct(store: StorePrincipal, access: GroupAccess, id: ObjectId): Promise<StoreProductResult>;
  /** Creates a product (the errors of `ProductsService.create`). */
  createProduct(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, body: CreateProductBody, client: ClientContext): Promise<StoreProductResult>;
  /** Modifies a product, the prices included (the errors of `ProductsService.update`: `403` for a field of a product that is shared with other places, `412`, `409`). */
  updateProduct(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, body: PatchProductBody, client: ClientContext): Promise<StoreProductResult>;
  /** Duplicates a product. */
  duplicateProduct(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<StoreProductResult>;
  /** Moves a product to the trash. There is no deletion for good and no emptying of the trash for a store. */
  trashProduct(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<StoreProductResult>;
  /** Takes a product out of the trash. */
  restoreProduct(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<StoreProductResult>;
  /** A page of the categories of the place, oldest change first, with `updatedSince` as for the products. */
  listCategories(store: StorePrincipal, access: GroupAccess, query: StoreCategoriesQuery): Promise<EntityPage<Category>>;
  /** The compact tree of the categories of the place (`CONFLICT` in a group with too many). */
  categoryTree(store: StorePrincipal, access: GroupAccess): Promise<CategoryTreeNode[]>;
  /** One category with its version. @throws {AppError} `NOT_FOUND`. */
  getCategory(store: StorePrincipal, access: GroupAccess, id: ObjectId): Promise<EntityResult<Category>>;
  /** Creates a category (the errors of `CategoriesService.create`). */
  createCategory(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, body: CreateCategoryBody, client: ClientContext): Promise<EntityResult<Category>>;
  /** Modifies a category. */
  updateCategory(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, body: PatchCategoryBody, client: ClientContext): Promise<EntityResult<Category>>;
  /** Deletes a category for good, with the rules of the backoffice (`409` when something refers to it, no cascade). */
  deleteCategory(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<void>;
  /** A page of the departments of the place, by name. @throws {AppError} `FEATURE_DISABLED` in a group without the `cash` function. */
  listDepartments(store: StorePrincipal, access: GroupAccess, query: StoreDepartmentsQuery): Promise<EntityPage<Department>>;
  /** A page of the brands of the place, oldest change first, the disabled ones included; with `updatedSince` those changed from that instant. */
  listBrands(store: StorePrincipal, access: GroupAccess, query: StoreBrandsQuery): Promise<EntityPage<Brand>>;
  /** One brand with its version. @throws {AppError} `NOT_FOUND` for a brand that does not exist, is of other places only or is in another group. */
  getBrand(store: StorePrincipal, access: GroupAccess, id: ObjectId): Promise<EntityResult<Brand>>;
  /** Creates a brand (the errors of `BrandsService.create`). */
  createBrand(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, body: CreateBrandBody, client: ClientContext): Promise<EntityResult<Brand>>;
  /** Modifies a brand (`403` for one that is shared with other places or is for every place, `412`, `409`). */
  updateBrand(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, body: PatchBrandBody, client: ClientContext): Promise<EntityResult<Brand>>;
  /** Deletes a brand for good, with the rules of the backoffice (`409` when a product has it). */
  deleteBrand(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<void>;
  /** A page of the groups of attributes, oldest change first; with `updatedSince` those changed from that instant. Read only: a store never writes them. */
  listAttributeGroups(store: StorePrincipal, access: GroupAccess, query: StoreAttributeGroupsQuery): Promise<EntityPage<AttributeGroup>>;
  /** One group of attributes with its version. @throws {AppError} `NOT_FOUND`. */
  getAttributeGroup(store: StorePrincipal, access: GroupAccess, id: ObjectId): Promise<EntityResult<AttributeGroup>>;
}

/** Collaborators of {@link createStoreCatalogService}: the services of the catalog, already wrapped by the rule of the single place. */
export interface StoreCatalogServiceDeps {
  readonly products: Pick<ProductsService, 'listChanges' | 'get' | 'create' | 'update' | 'duplicate' | 'trash' | 'restore'>;
  readonly categories: Pick<CategoriesService, 'listChanges' | 'tree' | 'get' | 'create' | 'update' | 'remove'>;
  readonly departments: Pick<DepartmentsService, 'list'>;
  readonly brands: Pick<BrandsService, 'listChanges' | 'get' | 'create' | 'update' | 'remove'>;
  /** Only the reads: the type does not let the store catalog write a group of attributes. */
  readonly attributeGroups: Pick<AttributeGroupsService, 'listChanges' | 'get'>;
}

/**
 * The caller the services of the catalog see for a store: the perimeter of its key (one place) and, for a write, the operator. Built from the store principal alone, frozen.
 *
 * @param store The verified store principal.
 * @param operator The verified operator of a write, `null` for a read.
 */
function callerOf(store: StorePrincipal, operator: StoreOperator | null): StoreCaller {
  return Object.freeze({ kind: 'store' as const, keyId: store.keyId, scope: store.scope, operator });
}

/**
 * Builds the catalog service of the server of a point of sale.
 *
 * @param deps The services of the products, the categories and the departments.
 */
export function createStoreCatalogService(deps: StoreCatalogServiceDeps): StoreCatalogService {
  const { products, categories, departments, brands, attributeGroups } = deps;
  return {
    listProducts: (store, access, query) => products.listChanges(callerOf(store, null), access, { ...query, limit: query.limit ?? STORE_PRODUCTS_DEFAULT_PAGE }),
    getProduct: async (store, access, id) => toStoreProductResult(await products.get(callerOf(store, null), access, id)),
    createProduct: async (store, operator, access, body, client) => toStoreProductResult(await products.create(callerOf(store, operator), access, body, client)),
    updateProduct: async (store, operator, access, id, expected, body, client) => toStoreProductResult(await products.update(callerOf(store, operator), access, id, expected, body, client)),
    duplicateProduct: async (store, operator, access, id, client) => toStoreProductResult(await products.duplicate(callerOf(store, operator), access, id, client)),
    trashProduct: async (store, operator, access, id, expected, client) => toStoreProductResult(await products.trash(callerOf(store, operator), access, id, expected, client)),
    restoreProduct: async (store, operator, access, id, expected, client) => toStoreProductResult(await products.restore(callerOf(store, operator), access, id, expected, client)),
    listCategories: (store, access, query) => categories.listChanges(callerOf(store, null), access, { ...query, limit: query.limit ?? STORE_CATEGORIES_DEFAULT_PAGE }),
    categoryTree: (store, access) => categories.tree(callerOf(store, null), access),
    getCategory: (store, access, id) => categories.get(callerOf(store, null), access, id),
    createCategory: (store, operator, access, body, client) => categories.create(callerOf(store, operator), access, body, client),
    updateCategory: (store, operator, access, id, expected, body, client) => categories.update(callerOf(store, operator), access, id, expected, body, client),
    deleteCategory: (store, operator, access, id, client) => categories.remove(callerOf(store, operator), access, id, client),
    listBrands: (store, access, query) => brands.listChanges(callerOf(store, null), access, { ...query, limit: query.limit ?? STORE_ENTITIES_DEFAULT_PAGE }),
    getBrand: (store, access, id) => brands.get(callerOf(store, null), access, id),
    createBrand: (store, operator, access, body, client) => brands.create(callerOf(store, operator), access, body, client),
    updateBrand: (store, operator, access, id, expected, body, client) => brands.update(callerOf(store, operator), access, id, expected, body, client),
    deleteBrand: (store, operator, access, id, client) => brands.remove(callerOf(store, operator), access, id, client),
    listAttributeGroups: (store, access, query) => attributeGroups.listChanges(callerOf(store, null), access, { ...query, limit: query.limit ?? STORE_ENTITIES_DEFAULT_PAGE }),
    getAttributeGroup: (store, access, id) => attributeGroups.get(callerOf(store, null), access, id),
    listDepartments: async (store, access, query) => {
      if (!access.features.cash) {
        throw new AppError('FEATURE_DISABLED');
      }
      return departments.list(callerOf(store, null), access, query);
    },
  };
}
