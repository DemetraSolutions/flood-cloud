import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Config } from './config.ts';
import { createCervedClient } from './integrations/cerved/index.ts';
import type { CervedHttpOptions } from './integrations/cerved/index.ts';
import type { MediaStorage } from './integrations/gcs/index.ts';
import type { Databases } from './db/databases.ts';
import type { ActivityLog } from './shared/activity-log/activity-log.ts';
import type { RouteDefinition } from './shared/http/routes.ts';
import type { Logger } from './shared/logging/logger.ts';
import type { RateLimiter } from './shared/security/rate-limit/rate-limiter.ts';
import type { PublicApiLimits } from './shared/security/public-api-limits.ts';
import { createRateLimitRules } from './shared/security/rate-limit/rules.ts';
import { createCompanyPlacesRepository } from './shared/security/scope/company-places.repository.ts';
import { createDealerGroupsRepository } from './shared/security/scope/dealer-groups.repository.ts';
import { createGroupsRepository } from './shared/security/scope/groups.repository.ts';
import type { GroupsRepository } from './shared/security/scope/groups.repository.ts';
import { createActivityLogController } from './modules/activity-log/activity-log.controller.ts';
import { createActivityLogRepository } from './modules/activity-log/activity-log.repository.ts';
import { createActivityLogRoutes } from './modules/activity-log/activity-log.routes.ts';
import { createActivityLogService } from './modules/activity-log/activity-log.service.ts';
import { createApiKeysController } from './modules/api-keys/api-keys.controller.ts';
import { createApiKeysRepository } from './modules/api-keys/api-keys.repository.ts';
import { createApiKeysRoutes } from './modules/api-keys/api-keys.routes.ts';
import { createApiKeysService } from './modules/api-keys/api-keys.service.ts';
import { createAuthenticateApiKey } from './modules/api-keys/authenticate-api-key.ts';
import { createUsageMeter } from './modules/api-keys/usage-meter.ts';
import type { UsageMeter } from './modules/api-keys/usage-meter.ts';
import { createPublicController } from './modules/public-api/public.controller.ts';
import { createPublicRepository } from './modules/public-api/public.repository.ts';
import { createPublicRoutes } from './modules/public-api/public.routes.ts';
import { createPublicService } from './modules/public-api/public.service.ts';
import { createAuthController } from './modules/auth/auth.controller.ts';
import { createAuthRoutes } from './modules/auth/auth.routes.ts';
import { createAuthService } from './modules/auth/auth.service.ts';
import { createAuthenticate } from './modules/auth/authenticate.ts';
import { createLookupController } from './modules/group-lookup/lookup.controller.ts';
import { createLookupRepository } from './modules/group-lookup/lookup.repository.ts';
import { createLookupRoutes } from './modules/group-lookup/lookup.routes.ts';
import { createLookupService } from './modules/group-lookup/lookup.service.ts';
import { createDiagnosticsController } from './modules/diagnostics/diagnostics.controller.ts';
import { createDiagnosticsRepository } from './modules/diagnostics/diagnostics.repository.ts';
import { createDiagnosticsRoutes } from './modules/diagnostics/diagnostics.routes.ts';
import { createDiagnosticsService } from './modules/diagnostics/diagnostics.service.ts';
import { createErrorDocumentsController } from './modules/error-documents/error-documents.controller.ts';
import { createErrorDocumentsRepository } from './modules/error-documents/error-documents.repository.ts';
import { createErrorDocumentsRoutes } from './modules/error-documents/error-documents.routes.ts';
import { createErrorDocumentsService } from './modules/error-documents/error-documents.service.ts';
import { createCountriesController } from './modules/countries/countries.controller.ts';
import { createCountriesRepository } from './modules/countries/countries.repository.ts';
import { createCountriesRoutes } from './modules/countries/countries.routes.ts';
import { createCountriesService } from './modules/countries/countries.service.ts';
import { createTobaccosController } from './modules/tobaccos/tobaccos.controller.ts';
import { createTobaccosRepository } from './modules/tobaccos/tobaccos.repository.ts';
import { createTobaccosRoutes } from './modules/tobaccos/tobaccos.routes.ts';
import { createTobaccosService } from './modules/tobaccos/tobaccos.service.ts';
import { createEmailTemplatesController } from './modules/email-templates/email-templates.controller.ts';
import { createEmailTemplatesRepository } from './modules/email-templates/email-templates.repository.ts';
import { createEmailTemplatesRoutes } from './modules/email-templates/email-templates.routes.ts';
import { createEmailTemplatesService } from './modules/email-templates/email-templates.service.ts';
import { createGroupServicesController } from './modules/group-services/services.controller.ts';
import { createServicesRepository } from './modules/group-services/services.repository.ts';
import { createGroupServicesRoutes } from './modules/group-services/services.routes.ts';
import { createGroupServicesService } from './modules/group-services/services.service.ts';
import { createClientErrorsController } from './modules/client-errors/client-errors.controller.ts';
import { createClientErrorsRoutes } from './modules/client-errors/client-errors.routes.ts';
import { createClientErrorsService } from './modules/client-errors/client-errors.service.ts';
import { createActivationsController } from './modules/activations/activations.controller.ts';
import { createActivationsRepository } from './modules/activations/activations.repository.ts';
import { createActivationsRoutes } from './modules/activations/activations.routes.ts';
import { createActivationsService } from './modules/activations/activations.service.ts';
import { createSettingsController } from './modules/settings/settings.controller.ts';
import { createSettingsRepository } from './modules/settings/settings.repository.ts';
import { createSettingsRoutes } from './modules/settings/settings.routes.ts';
import { createSettingsService } from './modules/settings/settings.service.ts';
import { createDealersController } from './modules/dealers/dealers.controller.ts';
import { createDealersRepository } from './modules/dealers/dealers.repository.ts';
import { createDealersRoutes } from './modules/dealers/dealers.routes.ts';
import { createDealersService } from './modules/dealers/dealers.service.ts';
import { CATALOGS } from './modules/groups/catalogs/registry.ts';
import { createCatalogsRepository } from './modules/groups/catalogs/catalogs.repository.ts';
import { createCatalogRoutes } from './modules/groups/catalogs/catalogs.routes.ts';
import { createCatalogsService } from './modules/groups/catalogs/catalogs.service.ts';
import { newElementId } from './modules/groups/catalogs/kit.ts';
import { createReferencesRepository } from './modules/groups/catalogs/references.repository.ts';
import { createEntityController } from './modules/product-catalog/entity.controller.ts';
import { createGroupLanguages } from './modules/product-catalog/group-languages.ts';
import { createProductReferences } from './modules/product-catalog/product-references.ts';
import { createAttributeGroupsRepository } from './modules/product-attribute-groups/product-attribute-groups.repository.ts';
import { createProductAttributeGroupsRoutes } from './modules/product-attribute-groups/product-attribute-groups.routes.ts';
import { createAttributeGroupsService } from './modules/product-attribute-groups/product-attribute-groups.service.ts';
import { createBrandsRepository } from './modules/product-brands/product-brands.repository.ts';
import { createProductBrandsRoutes } from './modules/product-brands/product-brands.routes.ts';
import { createBrandsService } from './modules/product-brands/product-brands.service.ts';
import { createDepartmentsRepository, createTaxDepartments } from './modules/product-departments/product-departments.repository.ts';
import { createProductDepartmentsRoutes } from './modules/product-departments/product-departments.routes.ts';
import { createDepartmentsService } from './modules/product-departments/product-departments.service.ts';
import { createCategoriesController } from './modules/product-categories/categories.controller.ts';
import { createCategoryPlaces } from './modules/product-categories/categories.places.ts';
import { createCategoriesRepository } from './modules/product-categories/categories.repository.ts';
import { createProductCategoriesRoutes } from './modules/product-categories/categories.routes.ts';
import { createCategoriesService } from './modules/product-categories/categories.service.ts';
import { createProductsController } from './modules/products/products.controller.ts';
import { createProductLinks } from './modules/products/products.links.ts';
import { createProductsRepository } from './modules/products/products.repository.ts';
import { createProductsRoutes } from './modules/products/products.routes.ts';
import { createProductsService } from './modules/products/products.service.ts';
import { createGroupsController } from './modules/groups/groups.controller.ts';
import { createManagedGroupsRepository } from './modules/groups/groups.repository.ts';
import { createGroupsRoutes } from './modules/groups/groups.routes.ts';
import { createGroupsService } from './modules/groups/groups.service.ts';
import { createCompaniesController } from './modules/companies/companies.controller.ts';
import { createCompaniesRepository } from './modules/companies/companies.repository.ts';
import { createCompaniesRoutes } from './modules/companies/companies.routes.ts';
import { createCompaniesService } from './modules/companies/companies.service.ts';
import { createGroupSummaryRepository } from './modules/me/group-summary.repository.ts';
import { createMediaController } from './modules/media/media.controller.ts';
import { createMediaRepository } from './modules/media/media.repository.ts';
import { createMediaRoutes } from './modules/media/media.routes.ts';
import { createMediaService } from './modules/media/media.service.ts';
import { createMeController } from './modules/me/me.controller.ts';
import { createMeRoutes } from './modules/me/me.routes.ts';
import { createMeService } from './modules/me/me.service.ts';
import { newPaymentTypeId } from './modules/places/place-ids.ts';
import { createPlacesController } from './modules/places/places.controller.ts';
import { createPlacesRepository } from './modules/places/places.repository.ts';
import { createPlacesRoutes } from './modules/places/places.routes.ts';
import { createPlacesService } from './modules/places/places.service.ts';
import { createIdempotencyStore, idempotencyBodyKey } from './shared/http/idempotency.ts';
import { createReferenceController } from './modules/reference/reference.controller.ts';
import { createReferenceRepository } from './modules/reference/reference.repository.ts';
import { createReferenceRoutes } from './modules/reference/reference.routes.ts';
import { createReferenceService } from './modules/reference/reference.service.ts';
import { createSessionsRepository } from './modules/sessions/sessions.repository.ts';
import { createAuthenticateStore } from './modules/store-keys/authenticate-store.ts';
import { createConfigurationReadAudit } from './modules/store-context/store-context.audit.ts';
import { createStoreContextController } from './modules/store-context/store-context.controller.ts';
import { createStoreContextRepository } from './modules/store-context/store-context.repository.ts';
import { createStoreContextRoutes } from './modules/store-context/store-context.routes.ts';
import { createStoreContextService } from './modules/store-context/store-context.service.ts';
import { createStoreKeysController } from './modules/store-keys/store-keys.controller.ts';
import { createStoreKeysRepository } from './modules/store-keys/store-keys.repository.ts';
import { createStoreKeysRoutes } from './modules/store-keys/store-keys.routes.ts';
import { createStoreKeysService } from './modules/store-keys/store-keys.service.ts';
import { createStoreStateReader } from './modules/store-keys/store-state.ts';
import { companiesPlacesReader, companiesPlacesWriter, groupCreationWriter } from './shared/legacy-write/companies-places.writer.ts';
import { issueGroupCreationAccess } from './shared/security/scope/group-access.ts';
import { createOnboardingController } from './modules/groups/onboarding.controller.ts';
import { createOnboardingRepository } from './modules/groups/onboarding.repository.ts';
import { createOnboardingRoutes } from './modules/groups/onboarding.routes.ts';
import { createOnboardingService } from './modules/groups/onboarding.service.ts';
import { createCredentialsRepository } from './modules/users/credentials.repository.ts';
import { createGroupDirectoryRepository } from './modules/users/group-directory.repository.ts';
import { createGroupOptionsReader } from './modules/users/group-options.ts';
import { createUsersController } from './modules/users/users.controller.ts';
import { createUsersRoutes } from './modules/users/users.routes.ts';
import { createCrossGroupAuditor } from './shared/activity-log/cross-group-audit.ts';
import { createTrashController } from './modules/trash/trash.controller.ts';
import { createTrashRoutes } from './modules/trash/trash.routes.ts';
import { createTrashService } from './modules/trash/trash.service.ts';
import { createUsersService } from './modules/users/users.service.ts';
import { createVatLookupsController } from './modules/vat-lookups/vat-lookups.controller.ts';
import { createVatLookupsRoutes } from './modules/vat-lookups/vat-lookups.routes.ts';
import { createVatLookupsService } from './modules/vat-lookups/vat-lookups.service.ts';
import { createUsersRepository } from './modules/users/users.repository.ts';

/** The defaults of the public API of the platform, from the configuration. */
const publicApiLimitsOf = (config: Config): PublicApiLimits => ({
  rateLimitPerMinute: config.publicApiDefaultRateLimitPerMinute,
  dailyQuota: config.publicApiDefaultDailyQuota,
  groupRateLimitPerMinute: config.publicApiDefaultGroupRateLimitPerMinute,
  groupDailyQuota: config.publicApiDefaultGroupDailyQuota,
});

/** Everything the application needs from the backoffice modules, wired over real repositories. */
export interface BackofficeModules {
  /** Routes to mount on `/v1`. */
  readonly routes: readonly RouteDefinition[];
  /** Bearer authentication of the users of `/v1`. */
  readonly authenticate: RequestHandler;
  /** Authentication of the store keys of `/v1` (`fc_sk_…`): the app mounts it next to `authenticate`, which dispatches by the prefix of the secret. */
  readonly authenticateStore: RequestHandler;
  /** Group lookup for the routes declaring `group: true`. */
  readonly groups: GroupsRepository;
}

/** Collaborators of {@link createBackofficeModules}. */
export interface BackofficeDeps {
  readonly config: Config;
  readonly databases: Databases;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** The rate limit counters (the store keys use them to record a revoked key in use, and a failed exchange, once an hour). */
  readonly rateLimiter: RateLimiter;
  /** The media storage built at start-up (`createMediaStorage`); `null` or absent when it is disabled (the upload answers `503`). */
  readonly mediaStorage?: MediaStorage | null;
  /** The `fetch`, the timeout and the size limit of the calls to Cerved; only a test sets them (the base URL and the key come from the configuration). */
  readonly cervedHttp?: CervedHttpOptions;
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Composition root of the backoffice (`/v1`) modules: builds the repositories over the databases and
 * the services, controllers and routes of login and sessions, the profile, the user management, the dealer registry, the reference lists, the countries and their provinces, the settings (the price list) and the activations (the billing of the dealers), the companies, the places, the store keys of the points of sale, the media (images), the groups, the activity log monitor, the company lookup on Cerved and the browser error reports. The only place that
 * knows how the layers are connected.
 *
 * @param deps Configuration, databases, activity log, logger and clock.
 * @returns Routes, authentication middleware and group lookup, ready for `createApp`.
 */
export function createBackofficeModules(deps: BackofficeDeps): BackofficeModules {
  const { config, databases, activityLog, logger, rateLimiter } = deps;
  const now = deps.now ?? Date.now;
  const versionKey = Buffer.from(config.versionHmacKey.reveal(), 'base64');
  const users = createUsersRepository(databases);
  const credentials = createCredentialsRepository(databases);
  const sessions = createSessionsRepository(databases);
  const groups = createGroupsRepository(databases);
  const dealers = createDealersRepository(databases);
  const rules = createRateLimitRules(config);

  const authenticate = createAuthenticate({
    sessions,
    users,
    credentials,
    groups,
    scope: { ...createDealerGroupsRepository(databases), ...createCompanyPlacesRepository(databases) },
    activityLog,
    logger,
    now,
  });
  const auth = createAuthController(createAuthService({ config, users, credentials, sessions, groups, activityLog, now }));
  const catalogsRepository = createCatalogsRepository(databases);
  const groupOptions = createGroupOptionsReader(catalogsRepository);
  const services = createServicesRepository(databases);
  const me = createMeController(
    createMeService({ config, users, credentials, sessions, groups: createGroupSummaryRepository(databases), groupOptions, dealers, activityLog, now }),
  );
  const usersService = createUsersService({
    config,
    users,
    credentials,
    sessions,
    directory: createGroupDirectoryRepository(databases),
    dealers,
    services,
    groupOptions,
    activityLog,
    transaction: (work) => databases.transaction(work),
    now,
  });
  const usersController = createUsersController(usersService);
  const settingsService = createSettingsService({ repository: createSettingsRepository(databases), activityLog, versionKey, now });
  const dealersController = createDealersController(createDealersService({ dealers, users, usersService, priceLists: settingsService, versionKey, activityLog, now }));
  const managedGroups = createManagedGroupsRepository(databases, publicApiLimitsOf(config));
  const groupsService = createGroupsService({ groups: managedGroups, users, sessions, activityLog, logger, transaction: (work) => databases.transaction(work), now });
  const groupsController = createGroupsController(groupsService);
  const groupServices = createGroupServicesController(createGroupServicesService({ services, users }));
  const referencesRepository = createReferencesRepository(databases);
  const catalogsService = createCatalogsService({
    catalogs: catalogsRepository,
    references: referencesRepository,
    activityLog,
    logger,
    newId: newElementId,
    now,
    taxDepartments: createTaxDepartments(databases),
  });
  const lookup = createLookupController(createLookupService({ lookup: createLookupRepository(databases), users, catalogs: catalogsService }));
  const referenceService = createReferenceService(createReferenceRepository(databases));
  const reference = createReferenceController(referenceService);
  const companiesRepository = createCompaniesRepository(databases, catalogsRepository);
  const mediaService = createMediaService({
    repository: createMediaRepository(databases),
    storage: deps.mediaStorage ?? null,
    logger,
    now,
    // The company of an image: one of the group, inside the caller's perimeter, not in the trash (read from the copies, scoped like every company read).
    companyUsable: async (principal, access, companyId) =>
      (await companiesRepository.list(principal, access, { _id: companyId, trash: { $ne: true } }, { limit: 1, sort: 'name', q: null, cursor: null })).items.length === 1,
  });
  const media = createMediaController(mediaService);
  const companiesService = createCompaniesService({
    repository: companiesRepository,
    writerFor: (principal, access) => companiesPlacesWriter(principal, access, databases, { now: () => new Date(now()), versionKey }),
    images: mediaService,
    activityLog,
    newId: () => randomBytes(12).toString('hex'),
  });
  const companies = createCompaniesController(companiesService);
  const idempotency = createIdempotencyStore(databases, idempotencyBodyKey(versionKey), now);
  const onboarding = createOnboardingController(
    createOnboardingService({
      repository: createOnboardingRepository(databases),
      users: usersService,
      directory: companiesRepository,
      newAccess: (principal) => issueGroupCreationAccess(principal, databases),
      writerFor: (principal, access) => groupCreationWriter(principal, access, databases, { now: () => new Date(now()), versionKey }),
      activityLog,
      transaction: (work) => databases.transaction(work),
      filesHost: config.groupFilesHost,
      now,
    }),
  );
  const storeKeysState = createStoreStateReader({ groups, databases });
  const storeKeysRepository = createStoreKeysRepository(databases);
  const storeKeysService = createStoreKeysService({
    repository: storeKeysRepository,
    state: storeKeysState,
    activityLog,
    rateLimiter,
    transaction: (work) => databases.transaction(work),
    failureRule: rules.unauthenticatedPerIp,
    activationCodeTtlMinutes: config.storeActivationCodeTtlMinutes,
    now,
  });
  const authenticateStore = createAuthenticateStore({ repository: storeKeysRepository, state: storeKeysState, activityLog, rateLimiter, logger, apiRule: rules.apiPerStore, now });
  const storeKeys = createStoreKeysController(storeKeysService, now);
  const storeContext = createStoreContextController(
    createStoreContextService({
      groups: managedGroups,
      repository: createStoreContextRepository(databases),
      users,
      catalogs: catalogsService,
      readerFor: (store, access) => companiesPlacesReader(store, access, databases, { versionKey }),
      logger,
    }),
    versionKey,
    createConfigurationReadAudit({ activityLog, rateLimiter, logger }),
    referenceService,
  );
  const placesService = createPlacesService({
    repository: createPlacesRepository(databases, companiesRepository),
    writerFor: (principal, access) => companiesPlacesWriter(principal, access, databases, { now: () => new Date(now()), versionKey }),
    readerFor: (principal, access) => companiesPlacesReader(principal, access, databases, { versionKey }),
    logger,
    activityLog,
    references: createReferencesRepository(databases),
    images: mediaService,
    storeKeys: storeKeysService,
    newId: () => newPaymentTypeId(now),
  });
  const places = createPlacesController(placesService);
  // The product catalog of a group (steps C1, C2 and C3): what the departments, the brands, the groups of attributes, the categories and the products share.
  const productReferences = createProductReferences(databases);
  const groupLanguages = createGroupLanguages(databases);
  const catalogDeps = { references: referencesRepository, images: mediaService, languages: groupLanguages, users, activityLog, logger, versionKey, now };
  const categoryPlaces = createCategoryPlaces(databases);
  const productsService = createProductsService({
    repository: createProductsRepository(databases),
    links: createProductLinks(databases),
    places: categoryPlaces,
    references: referencesRepository,
    catalogs: catalogsService,
    images: mediaService,
    languages: groupLanguages,
    users,
    activityLog,
    logger,
    versionKey,
    now,
  });
  // The trash page: bulk operations that call the single-item operations of the domains above.
  const trash = createTrashController(
    createTrashService({ companies: companiesService, places: placesService, users: usersService, groups: groupsService, products: productsService, activityLog }),
  );
  const activity = createActivityLogController(createActivityLogService(createActivityLogRepository(databases)));
  const diagnostics = createDiagnosticsController(createDiagnosticsService({ repository: createDiagnosticsRepository(databases), storeKeys: storeKeysRepository }), now);
  const errorDocuments = createErrorDocumentsController(createErrorDocumentsService({ repository: createErrorDocumentsRepository(databases), dealerGroups: createDealerGroupsRepository(databases) }), now);
  const emailTemplates = createEmailTemplatesController(createEmailTemplatesService({ repository: createEmailTemplatesRepository(databases), activityLog, versionKey, now }));
  const productDepartments = createEntityController(createDepartmentsService({ ...catalogDeps, repository: createDepartmentsRepository(databases), catalogs: catalogsService, products: productReferences }));
  const productBrands = createEntityController(createBrandsService({ ...catalogDeps, repository: createBrandsRepository(databases), products: productReferences }));
  const productCategories = createCategoriesController(
    createCategoriesService({ repository: createCategoriesRepository(databases), places: categoryPlaces, catalogs: catalogsService, products: productReferences, ...catalogDeps }),
  );
  const productAttributeGroups = createEntityController(
    createAttributeGroupsService({ repository: createAttributeGroupsRepository(databases), products: productReferences, languages: groupLanguages, users, activityLog, versionKey, now, newAttributeId: newElementId }),
  );
  const countries = createCountriesController(createCountriesService({ repository: createCountriesRepository(databases, logger), activityLog, versionKey, now }));
  const tobaccos = createTobaccosController(createTobaccosService({ repository: createTobaccosRepository(databases), activityLog, now }));
  const vatLookups = createVatLookupsController(
    createVatLookupsService({ cerved: createCervedClient({ apiKey: config.cervedApiKey, baseUrl: config.cervedBaseUrl, ...deps.cervedHttp }), activityLog, logger }),
  );
  const settings = createSettingsController(settingsService);
  const activations = createActivationsController(createActivationsService({ repository: createActivationsRepository(databases), priceLists: settingsService, activityLog, now }));
  const apiKeys = createApiKeysController(createApiKeysService({ repository: createApiKeysRepository(databases, publicApiLimitsOf(config)), groups: managedGroups, activityLog, now }));
  const clientErrors = createClientErrorsController(createClientErrorsService({ activityLog, logger, now }));
  return {
    routes: [...createAuthRoutes(auth, rules), ...createMeRoutes(me, rules), ...createUsersRoutes(usersController, rules), ...createDealersRoutes(dealersController, rules), ...createReferenceRoutes(reference), ...createCompaniesRoutes(companies, idempotency), ...createPlacesRoutes(places, idempotency), ...createStoreKeysRoutes(storeKeys, rules), ...createStoreContextRoutes(storeContext), ...createApiKeysRoutes(apiKeys, rules), ...createMediaRoutes(media, rules, () => mediaService.available), ...createGroupsRoutes(groupsController), ...createOnboardingRoutes(onboarding, idempotency, rules),
      ...createCatalogRoutes(catalogsService, CATALOGS),
      ...createGroupServicesRoutes(groupServices),
      ...createLookupRoutes(lookup),
      ...createActivityLogRoutes(activity),
      ...createDiagnosticsRoutes(diagnostics, rules),
      ...createErrorDocumentsRoutes(errorDocuments, rules),
      ...createEmailTemplatesRoutes(emailTemplates, idempotency),
      ...createProductDepartmentsRoutes(productDepartments, idempotency),
      ...createProductBrandsRoutes(productBrands, idempotency),
      ...createProductCategoriesRoutes(productCategories, idempotency),
      ...createProductsRoutes(createProductsController(productsService), idempotency),
      ...createProductAttributeGroupsRoutes(productAttributeGroups, idempotency),
      ...createTobaccosRoutes(tobaccos, rules, idempotency),
      ...createCountriesRoutes(countries, rules),
      ...createSettingsRoutes(settings, rules),
      ...createActivationsRoutes(activations, rules),
      ...createTrashRoutes(trash, rules, groups, createCrossGroupAuditor({ activityLog, now })),
      ...createVatLookupsRoutes(vatLookups, rules),
      ...createClientErrorsRoutes(clientErrors, rules),
    ],
    authenticate,
    authenticateStore,
    groups,
  };
}

/** Everything the public API (`/public/v1`) needs, wired over real repositories. */
export interface PublicApiModules {
  /** Routes to mount on `/public/v1`. */
  readonly routes: readonly RouteDefinition[];
  /** `X-Api-Key` authentication of the public surface, with the per-key rate limit and the daily quota. */
  readonly authenticate: RequestHandler;
  /** The usage meter: the server starts it with the process and stops it (which writes what is left) before the database is closed. */
  readonly meter: UsageMeter;
}

/** Collaborators of {@link createPublicApiModules}. */
export interface PublicApiDeps {
  readonly config: Config;
  readonly databases: Databases;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** The rate limit counters (the per-key limit and the daily quota use them). */
  readonly rateLimiter: RateLimiter;
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Composition root of the public API: the API key authentication (with the usage meter), the reads of places, companies and the group catalogs, and their routes.
 *
 * @param deps Configuration, databases, activity log, logger, counters and clock.
 * @returns Routes, authentication and meter, ready for `createApp` and the server.
 */
export function createPublicApiModules(deps: PublicApiDeps): PublicApiModules {
  const { config, databases, activityLog, logger, rateLimiter } = deps;
  const now = deps.now ?? Date.now;
  const keys = createApiKeysRepository(databases, publicApiLimitsOf(config));
  const meter = createUsageMeter({ repository: keys, logger, flushIntervalMs: config.publicApiUsageFlushSeconds * 1000 });
  const groups = createManagedGroupsRepository(databases, publicApiLimitsOf(config));
  const controller = createPublicController(createPublicService({ repository: createPublicRepository(databases), groups, rateLimiter }));
  return { routes: createPublicRoutes(controller), authenticate: createAuthenticateApiKey({ repository: keys, rateLimiter, activityLog, logger, meter, now }), meter };
}
