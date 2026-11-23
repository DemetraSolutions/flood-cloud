import type { ObjectId } from 'mongodb';
import { PRODUCTS_BRANDS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { referenced } from '../groups/catalogs/kit.ts';
import type { ReferencesRepository } from '../groups/catalogs/references.repository.ts';
import type { EntityRepository } from '../product-catalog/entity.repository.ts';
import { createEntityService } from '../product-catalog/entity.service.ts';
import type { EntityKind, EntityService, EntityView } from '../product-catalog/entity.service.ts';
import type { GroupLanguages } from '../product-catalog/group-languages.ts';
import { userField } from '../product-catalog/product-references.ts';
import type { ProductReferences } from '../product-catalog/product-references.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { brandsListFor } from './product-brands.schemas.ts';
import type { CreateBrandBody, PatchBrandBody } from './product-brands.schemas.ts';

/** A brand as the API shows it. */
export type Brand = EntityView;

/** The service of the brands of a group (`doc/Tasks.md` step C1). */
export type BrandsService = EntityService<Brand, CreateBrandBody, PatchBrandBody>;

/** Collaborators of {@link createBrandsService}. */
export interface BrandsServiceDeps {
  readonly repository: EntityRepository;
  readonly products: Pick<ProductReferences, 'withBrand'>;
  readonly references: Pick<ReferencesRepository, 'missing'>;
  readonly images: { imageSource(principal: CatalogCaller, access: GroupAccess, imageId: ObjectId): Promise<MediaLogo | null> };
  readonly languages: GroupLanguages;
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  readonly versionKey: Buffer;
  readonly now: () => number;
  readonly newId?: () => ObjectId;
}

/** What a brand has of its own: nothing but the rule that a brand some product has is not deleted. */
function createBrandsKind(products: Pick<ProductReferences, 'withBrand'>): EntityKind<object, CreateBrandBody, PatchBrandBody> {
  return {
    resource: 'productBrand',
    actions: { created: 'productBrand.created', updated: 'productBrand.updated', deleted: 'productBrand.deleted' },
    ownedFields: PRODUCTS_BRANDS_OWNED_FIELDS,
    listConfig: brandsListFor,
    extra: () => ({}),
    loggable: () => ({}),
    create: async () => ({}),
    patch: async () => ({}),
    guardRemove: async ({ principal, access }, found) => {
      const users = await products.withBrand(principal, access, found['_id'] as ObjectId);
      if (users.length > 0) {
        throw referenced(users.map((id) => userField('products', id)));
      }
    },
  };
}

/**
 * Builds the service of the brands of a group: the rules of the entries with places and an image, and the refusal to delete a brand that products have.
 *
 * @param deps Repository, products, places, images, languages, users, activity log, version key and clock.
 */
export function createBrandsService(deps: BrandsServiceDeps): BrandsService {
  return createEntityService({
    kind: createBrandsKind(deps.products),
    repository: deps.repository,
    places: deps.references,
    images: deps.images,
    languages: deps.languages,
    users: deps.users,
    activityLog: deps.activityLog,
    logger: deps.logger,
    versionKey: deps.versionKey,
    now: deps.now,
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });
}
