import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Config } from './config.ts';
import { createIntegrations } from './integrations/index.ts';
import type { IntegrationsConfig, IntegrationsDeps } from './integrations/index.ts';
import type { MediaStorage } from './infrastructure/gcs/index.ts';
import type { Databases } from './db/databases.ts';
import type { GroupAccess } from './shared/security/scope/group-access.ts';
import type { AuthPrincipal } from './shared/security/scope/principal.ts';
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
import { createApiKeyCallers } from './modules/public-catalog/public-catalog.caller.ts';
import { createPublicCatalogController } from './modules/public-catalog/public-catalog.controller.ts';
import { createPublicCatalogRoutes } from './modules/public-catalog/public-catalog.routes.ts';
import { createPublicCatalogService } from './modules/public-catalog/public-catalog.service.ts';
import { createPublicContactsController } from './modules/public-contacts/public-contacts.controller.ts';
import { createPublicContactsRoutes } from './modules/public-contacts/public-contacts.routes.ts';
import { createPublicContactsService } from './modules/public-contacts/public-contacts.service.ts';
import { createPublicSalesController } from './modules/public-sales/public-sales.controller.ts';
import { createPublicSalesRepository } from './modules/public-sales/public-sales.repository.ts';
import { createPublicSalesRoutes } from './modules/public-sales/public-sales.routes.ts';
import { createPublicSalesService } from './modules/public-sales/public-sales.service.ts';
import { createPublicFidelityCardsController } from './modules/public-fidelity-cards/public-fidelity-cards.controller.ts';
import { createPublicFidelityCardsRoutes } from './modules/public-fidelity-cards/public-fidelity-cards.routes.ts';
import { createPublicFidelityCardsService } from './modules/public-fidelity-cards/public-fidelity-cards.service.ts';
import { createPublicController } from './modules/public-api/public.controller.ts';
import { createPublicRepository } from './modules/public-api/public.repository.ts';
import { createPublicRoutes } from './modules/public-api/public.routes.ts';
import { createPublicService } from './modules/public-api/public.service.ts';
import { createDpopRejectedAudit } from './shared/security/dpop-audit.ts';
import { createNonBrowserGuard } from './shared/security/non-browser-signal.ts';
import type { NonBrowserGuard } from './shared/security/non-browser-signal.ts';
import type { SecurityPolicyProvider } from './shared/security/security-policy.ts';
import { createSecurityPolicyProvider } from './shared/security/security-policy.ts';
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
import { createCatalogXlsxController } from './modules/catalog-xlsx/catalog-xlsx.controller.ts';
import { createCatalogXlsxRoutes, createWorkbookRoutes } from './modules/catalog-xlsx/catalog-xlsx.routes.ts';
import { createCatalogXlsxService } from './modules/catalog-xlsx/catalog-xlsx.service.ts';
import { CONTACTS_EXPORT_SEGMENT, CONTACTS_IMPORT_SEGMENT } from './modules/contacts-xlsx/contacts-xlsx.columns.ts';
import { createContactsXlsxService } from './modules/contacts-xlsx/contacts-xlsx.service.ts';
import { CARDS_EXPORT_SEGMENT, CARDS_IMPORT_SEGMENT } from './modules/fidelity-cards-xlsx/fidelity-cards-xlsx.columns.ts';
import { createCardsXlsxService } from './modules/fidelity-cards-xlsx/fidelity-cards-xlsx.service.ts';
import { createTobaccoSyncController } from './modules/tobacco-sync/tobacco-sync.controller.ts';
import { createTobaccoSyncRoutes } from './modules/tobacco-sync/tobacco-sync.routes.ts';
import { createTobaccoSyncService } from './modules/tobacco-sync/tobacco-sync.service.ts';
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
import { createEInvoicingAccountsController } from './modules/einvoicing-accounts/einvoicing-accounts.controller.ts';
import { createEInvoicingAccountsRepository } from './modules/einvoicing-accounts/einvoicing-accounts.repository.ts';
import { createEInvoicingAccountsRoutes } from './modules/einvoicing-accounts/einvoicing-accounts.routes.ts';
import { createEInvoicingAccountsService } from './modules/einvoicing-accounts/einvoicing-accounts.service.ts';
import { createDealersService } from './modules/dealers/dealers.service.ts';
import { CATALOGS } from './modules/groups/catalogs/registry.ts';
import { createCatalogsRepository } from './modules/groups/catalogs/catalogs.repository.ts';
import { createCatalogRoutes } from './modules/groups/catalogs/catalogs.routes.ts';
import { createCatalogsService } from './modules/groups/catalogs/catalogs.service.ts';
import { newElementId } from './modules/groups/catalogs/kit.ts';
import { createReferencesRepository } from './modules/groups/catalogs/references.repository.ts';
import { createPlaceCounter, withSoleLocation } from './modules/product-catalog/availability.ts';
import { createEntityController } from './modules/product-catalog/entity.controller.ts';
import { createGroupLanguages } from './modules/product-catalog/group-languages.ts';
import { createProductReferences } from './modules/product-catalog/product-references.ts';
import { createAttributeGroupsRepository } from './modules/product-attribute-groups/product-attribute-groups.repository.ts';
import { createProductAttributeGroupsRoutes } from './modules/product-attribute-groups/product-attribute-groups.routes.ts';
import type { AttributeGroupsService } from './modules/product-attribute-groups/product-attribute-groups.service.ts';
import type { BrandsService } from './modules/product-brands/product-brands.service.ts';
import type { DepartmentsService } from './modules/product-departments/product-departments.service.ts';
import type { CategoriesService } from './modules/product-categories/categories.service.ts';
import type { ProductsService } from './modules/products/products.service.ts';
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
import { createCardsController } from './modules/fidelity-cards/fidelity-cards.controller.ts';
import { createCardsRepository } from './modules/fidelity-cards/fidelity-cards.repository.ts';
import { createCardsRoutes } from './modules/fidelity-cards/fidelity-cards.routes.ts';
import { createCardIndexGuard } from './modules/fidelity-cards/fidelity-cards.indexes.ts';
import { createCardsService } from './modules/fidelity-cards/fidelity-cards.service.ts';
import type { CardsService } from './modules/fidelity-cards/fidelity-cards.service.ts';
import { createContactGroupsController } from './modules/contact-groups/contact-groups.controller.ts';
import { createContactGroupsRepository } from './modules/contact-groups/contact-groups.repository.ts';
import { createContactGroupsRoutes } from './modules/contact-groups/contact-groups.routes.ts';
import { createContactGroupsService } from './modules/contact-groups/contact-groups.service.ts';
import type { ContactGroupsService } from './modules/contact-groups/contact-groups.service.ts';
import { createSalesAdminController } from './modules/sales/sales.admin.controller.ts';
import { createSalesAdminRoutes } from './modules/sales/sales.admin.routes.ts';
import { createSalesAdminService } from './modules/sales/sales.admin.service.ts';
import { createSalesController } from './modules/sales/sales.controller.ts';
import { createSalesIndexGuard } from './modules/sales/sales.indexes.ts';
import { createSalesKeyIndexGuard } from './modules/sales/sales.key-index.ts';
import { createSalesWriteService } from './modules/sales/sales.write.service.ts';
import { createNumberingIndexGuard } from './modules/document-numbering/numbering.indexes.ts';
import { createNumberingService } from './modules/document-numbering/numbering.service.ts';
import { createInvoiceGuard } from './modules/sales/sales.invoice.guard.ts';
import { createLoyaltyService } from './modules/loyalty/loyalty.service.ts';
import { createStockIndexGuard } from './modules/stock/stock.indexes.ts';
import { createStockService } from './modules/stock/stock.service.ts';
import { createStoreSalesController } from './modules/store-sales/store-sales.controller.ts';
import { createStoreSalesRoutes } from './modules/store-sales/store-sales.routes.ts';
import { createSalesRepository } from './modules/sales/sales.repository.ts';
import { createSalesRoutes } from './modules/sales/sales.routes.ts';
import { createSalesService } from './modules/sales/sales.service.ts';
import { createContactsController } from './modules/contacts/contacts.controller.ts';
import { createContactsRepository } from './modules/contacts/contacts.repository.ts';
import { createContactsRoutes } from './modules/contacts/contacts.routes.ts';
import { createContactsService } from './modules/contacts/contacts.service.ts';
import type { ContactsService } from './modules/contacts/contacts.service.ts';
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
import { createPlaceIntegrationsPort } from './modules/places/place-integrations.port.ts';
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
import { createOperatorAudit } from './modules/store-catalog/store-catalog.audit.ts';
import { createStoreCatalogController } from './modules/store-catalog/store-catalog.controller.ts';
import { createRequireOperator } from './modules/store-catalog/store-catalog.operator.ts';
import { createStoreCatalogRoutes } from './modules/store-catalog/store-catalog.routes.ts';
import { createStoreCatalogService } from './modules/store-catalog/store-catalog.service.ts';
import { createStoreContactsAudit } from './modules/store-contacts/store-contacts.audit.ts';
import { createStoreContactsController } from './modules/store-contacts/store-contacts.controller.ts';
import { createStoreContactsRoutes } from './modules/store-contacts/store-contacts.routes.ts';
import { createStoreContactsService } from './modules/store-contacts/store-contacts.service.ts';
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
  /** DPoP authentication of the users of `/v1`. */
  readonly authenticate: RequestHandler;
  /** Authentication of the store keys of `/v1` (`fc_sk_…`): the app mounts it next to `authenticate`, which dispatches by the prefix of the secret. */
  readonly authenticateStore: RequestHandler;
  /** Group lookup for the routes declaring `group: true`. */
  readonly groups: GroupsRepository;
  /** The guard of the requests of a user that do not look like a browser's; absent when `REQUEST_ORIGIN_SIGNAL` is `off`. */
  readonly nonBrowserGuard: NonBrowserGuard | undefined;
  /** The security policy in memory, shared by the guard, the limits and the settings service of this instance. */
  readonly securityPolicy: SecurityPolicyProvider;
  /** The services of the product catalog (already wrapped by the rule of the single place), which the public API uses as it is. */
  readonly catalog: CatalogServices;
  /** The services of the contacts, their groups and the advanced loyalty cards, which the public API uses as they are. */
  readonly crm: CrmServices;
}

/** The services of the contacts, of their groups and of the advanced loyalty cards of a group, shared by the backoffice and the public API. */
export interface CrmServices {
  readonly contacts: ContactsService;
  readonly contactGroups: ContactGroupsService;
  readonly cards: CardsService;
}

/** The services of the product catalog of a group, shared by the backoffice, the server of a point of sale and the public API. */
export interface CatalogServices {
  readonly products: ProductsService;
  readonly categories: CategoriesService;
  readonly brands: BrandsService;
  readonly attributeGroups: AttributeGroupsService;
  readonly departments: DepartmentsService;
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
  /** The `fetch`, the timeout and the size limit of the calls to each provider of the integrations module (Cerved, Dojo, Satispay, TS Hospitality, the geocoding); only a test sets them (the base URLs and the keys come from the configuration). */
  readonly integrationsHttp?: IntegrationsDeps['http'];
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Composition root of the backoffice (`/v1`) modules: builds the repositories over the databases and
 * the services, controllers and routes of login and sessions, the profile, the user management, the dealer registry, the reference lists, the countries and their provinces, the settings (the price list) and the activations (the billing of the dealers), the companies, the places, the store keys of the points of sale, the media (images), the groups, the activity log monitor, the integrations module (company lookup on Cerved and the availability of the providers) and the browser error reports. The only place that
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

  const dpopAudit = createDpopRejectedAudit({ activityLog, rateLimiter, logger });
  const authenticate = createAuthenticate({
    sessions,
    users,
    credentials,
    groups,
    scope: { ...createDealerGroupsRepository(databases), ...createCompanyPlacesRepository(databases) },
    activityLog,
    logger,
    dpopAudit,
    apiPublicBaseUrl: config.apiPublicBaseUrl,
    now,
  });
  const settingsRepository = createSettingsRepository(databases);
  // The security policy lives in memory (30 s) so the guard costs nothing per request; the instance that serves a write updates its copy at once. `REQUEST_ORIGIN_SIGNAL=off` turns the guard (and the block) off whatever the database says.
  const securityPolicy = createSecurityPolicyProvider({ read: () => settingsRepository.readSecurityPolicy(), sustainedDefault: config.rateLimitApiSustainedMode, forceReport: config.securityPolicyForceReport === 'on', logger, now });
  const nonBrowserGuard = config.requestOriginSignal === 'on' ? createNonBrowserGuard({ activityLog, rateLimiter, logger, allowedOrigins: config.corsAllowedOrigins, policy: securityPolicy }) : undefined;
  const auth = createAuthController(
    createAuthService({ config, users, credentials, sessions, groups, activityLog, dpopAudit, now }),
    { apiPublicBaseUrl: config.apiPublicBaseUrl, now },
    nonBrowserGuard,
  );
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
  const settingsService = createSettingsService({ repository: settingsRepository, activityLog, versionKey, securityPolicy, sustainedDefault: config.rateLimitApiSustainedMode, forceReport: config.securityPolicyForceReport === 'on', limits: { perMinute: config.rateLimitApiPerUser, perHour: config.rateLimitApiPerUserHour, perDay: config.rateLimitApiPerUserDay }, now });
  const dealersController = createDealersController(createDealersService({ dealers, users, usersService, priceLists: settingsService, versionKey, activityLog, now }));
  const eInvoicingAccounts = createEInvoicingAccountsController(
    createEInvoicingAccountsService({
      repository: createEInvoicingAccountsRepository(databases),
      activityLog,
      versionKey,
      credentialsRecipient: config.credentialsPublicKey === null ? null : { key: config.credentialsPublicKey, id: config.credentialsPublicKeyId! },
      now,
    }),
  );
  const managedGroups = createManagedGroupsRepository(databases, publicApiLimitsOf(config));
  const groupsService = createGroupsService({ groups: managedGroups, users, sessions, activityLog, logger, transaction: (work) => databases.transaction(work), now });
  const groupsController = createGroupsController(groupsService);
  const groupServices = createGroupServicesController(createGroupServicesService({ services, users }));
  const referencesRepository = createReferencesRepository(databases);
  const cardsRepository = createCardsRepository(databases);
  const catalogsService = createCatalogsService({
    catalogs: catalogsRepository,
    references: referencesRepository,
    activityLog,
    logger,
    newId: newElementId,
    now,
    taxDepartments: createTaxDepartments(databases),
    fidelityCards: cardsRepository,
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
      repository: createOnboardingRepository(databases, logger),
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
  const storeContextService = createStoreContextService({
    groups: managedGroups,
    repository: createStoreContextRepository(databases),
    users,
    catalogs: catalogsService,
    readerFor: (store, access) => companiesPlacesReader(store, access, databases, { versionKey }),
    logger,
  });
  const storeContext = createStoreContextController(
    storeContextService,
    versionKey,
    createConfigurationReadAudit({ activityLog, rateLimiter, logger }),
    referenceService,
  );
  // The write service of the places of a group: the one the place service and the place port of the integrations share.
  const placeWriterFor = (principal: AuthPrincipal, access: GroupAccess) => companiesPlacesWriter(principal, access, databases, { now: () => new Date(now()), versionKey });
  const placesService = createPlacesService({
    repository: createPlacesRepository(databases, companiesRepository),
    writerFor: placeWriterFor,
    readerFor: (principal, access) => companiesPlacesReader(principal, access, databases, { versionKey }),
    logger,
    activityLog,
    references: createReferencesRepository(databases),
    images: mediaService,
    storeKeys: storeKeysService,
    newId: () => newPaymentTypeId(now),
  });
  const places = createPlacesController(placesService);
  // The integrations module (Cerved, the status of the providers): the one place the core plugs it in. What it needs of the places goes through the port, which redoes the perimeter and the permission.
  const integrations = createIntegrations({
    config: integrationsConfigOf(config),
    activityLog,
    logger,
    rules,
    places: createPlaceIntegrationsPort({ groups, writerFor: placeWriterFor, activityLog }),
    idempotency,
    rateLimiter,
    ...(deps.integrationsHttp === undefined ? {} : { http: deps.integrationsHttp }),
  });
  // The product catalog of a group (steps C1, C2 and C3): what the departments, the brands, the groups of attributes, the categories and the products share.
  const productReferences = createProductReferences(databases);
  const groupLanguages = createGroupLanguages(databases);
  const catalogDeps = { references: referencesRepository, images: mediaService, languages: groupLanguages, users, activityLog, logger, versionKey, now };
  const categoryPlaces = createCategoryPlaces(databases);
  // The rule of the single place (`withSoleLocation`): the services of the departments, the brands, the categories and the products are the ones every caller uses, the server of a store included.
  const placeCounter = createPlaceCounter(databases);
  const productsService = withSoleLocation(createProductsService({
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
  }), placeCounter, logger);
  // The contacts of the group and their groups (step K1): shared by every place, so they take no rule of the single place.
  const contactsRepository = createContactsRepository(databases);
  const contactsService = createContactsService({ repository: contactsRepository, catalogs: catalogsService, findCountry: (code) => companiesRepository.findCountry(code), activityLog, rateLimiter, deleteRule: rules.contactDeletePerUser, versionKey, now });
  const cardIndexes = createCardIndexGuard(databases, logger);
  const cardsService = createCardsService({ repository: cardsRepository, contacts: contactsRepository, catalogs: catalogsService, activityLog, databases, indexes: cardIndexes, versionKey, now });
  const contactGroupsService = createContactGroupsService({ repository: createContactGroupsRepository(databases), catalogs: catalogsService, activityLog, versionKey, now });
  // The trash page: bulk operations that call the single-item operations of the domains above.
  const trash = createTrashController(
    createTrashService({ companies: companiesService, places: placesService, users: usersService, groups: groupsService, products: productsService, contacts: contactsService, activityLog }),
  );
  const activity = createActivityLogController(createActivityLogService(createActivityLogRepository(databases), now));
  const diagnostics = createDiagnosticsController(createDiagnosticsService({ repository: createDiagnosticsRepository(databases), storeKeys: storeKeysRepository }), now);
  const errorDocuments = createErrorDocumentsController(createErrorDocumentsService({ repository: createErrorDocumentsRepository(databases), dealerGroups: createDealerGroupsRepository(databases) }), now);
  const emailTemplates = createEmailTemplatesController(createEmailTemplatesService({ repository: createEmailTemplatesRepository(databases), activityLog, versionKey, now }));
  const departmentsService = withSoleLocation(createDepartmentsService({ ...catalogDeps, repository: createDepartmentsRepository(databases), catalogs: catalogsService, products: productReferences }), placeCounter, logger);
  const productDepartments = createEntityController(departmentsService);
  const brandsService = withSoleLocation(createBrandsService({ ...catalogDeps, repository: createBrandsRepository(databases), products: productReferences }), placeCounter, logger);
  const productBrands = createEntityController(brandsService);
  const categoriesService = withSoleLocation(createCategoriesService({ repository: createCategoriesRepository(databases), places: categoryPlaces, catalogs: catalogsService, products: productReferences, ...catalogDeps }), placeCounter, logger);
  const productCategories = createCategoriesController(categoriesService);
  const attributeGroupsService = createAttributeGroupsService({ repository: createAttributeGroupsRepository(databases), products: productReferences, languages: groupLanguages, users, activityLog, versionKey, now, newAttributeId: newElementId });
  // The catalog of the server of a point of sale: the same services, for a caller limited to the place of its key, and the check of the operator of its writes.
  const storeCatalog = createStoreCatalogController(createStoreCatalogService({ products: productsService, categories: categoriesService, departments: departmentsService, brands: brandsService, attributeGroups: attributeGroupsService }));
  const operatorDeps = { context: storeContextService, audit: createOperatorAudit({ activityLog, rateLimiter, logger }) };
  const requireOperator = createRequireOperator(operatorDeps);
  // The contacts, their groups and the advanced loyalty cards of the server of a point of sale (step K5): the same services, for the group, and the operator who holds the permission `contacts`.
  const storeContactsAudit = createStoreContactsAudit({ activityLog, rateLimiter, logger, now, limits: { perOperation: config.storeCreditAlertPerOperation, perDay: config.storeCreditAlertPerDay } });
  const storeContacts = createStoreContactsController(createStoreContactsService({ contacts: contactsService, contactGroups: contactGroupsService, cards: cardsService, logger, audit: storeContactsAudit }));
  const requireContactsOperator = createRequireOperator(operatorDeps, 'contacts');
  // The sales of the server of a point of sale (step VS4a): one transaction of the group for the sale, the warehouse and the loyalty cards (the stock and the loyalty services join it); the operator is in the body, so no check of one runs before it.
  const stockIndexes = createStockIndexGuard(databases, logger);
  // The numbering of the invoices of the sales (step VS5): the same guard of the indexes for the service that holds no transaction and for the one that joins the transaction of the sale.
  const numberingIndexes = createNumberingIndexGuard(databases, logger);
  const salesWrite = createSalesWriteService({
    databases,
    keyIndex: createSalesKeyIndexGuard(databases, logger),
    stock: createStockService({ databases, indexes: stockIndexes, now }),
    stockOver: (joined) => createStockService({ databases: joined, nested: true, indexes: stockIndexes, now }),
    loyaltyOver: (joined) => createLoyaltyService({ databases: joined, nested: true }),
    invoiceGuard: createInvoiceGuard({ rateLimiter, activityLog, logger, limits: { perMinute: config.rateLimitStoreInvoicesPerStore, perDay: config.storeInvoiceAlertPerDay } }),
    numbering: createNumberingService({ databases, indexes: numberingIndexes, now }),
    numberingOver: (joined) => createNumberingService({ databases: joined, nested: true, indexes: numberingIndexes, now }),
    activityLog,
    audit: storeContactsAudit,
    storeUsers: storeContextService,
    logger,
    now,
  });
  const storeSales = createStoreSalesController(salesWrite);
  // The writes of the sales from the backoffice (step VS4b): the same service, with the user as the operator and the perimeter of his role.
  const salesAdmin = createSalesAdminController(createSalesAdminService({ writer: salesWrite, repository: createSalesRepository(databases), directory: createGroupDirectoryRepository(databases) }));
  const productAttributeGroups = createEntityController(attributeGroupsService);
  const countries = createCountriesController(createCountriesService({ repository: createCountriesRepository(databases, logger), activityLog, versionKey, now }));
  const tobaccos = createTobaccosController(createTobaccosService({ repository: createTobaccosRepository(databases), activityLog, now }));
  const settings = createSettingsController(settingsService);
  const activations = createActivationsController(createActivationsService({ repository: createActivationsRepository(databases), priceLists: settingsService, activityLog, now }));
  const apiKeys = createApiKeysController(createApiKeysService({ repository: createApiKeysRepository(databases, publicApiLimitsOf(config)), groups: managedGroups, activityLog, now }));
  // The workbook of the catalog (step C6): the import builds the services of the catalog again over its transaction, so it takes the collaborators, not the instances.
  const catalogXlsx = createCatalogXlsxController(createCatalogXlsxService({ databases, catalogs: catalogsService, images: mediaService, users, activityLog, logger, versionKey, now }));
  // The workbooks of the contacts and of the advanced loyalty cards (step K3): they write through the services of the contacts and of the cards, built again over the transaction of the import.
  const contactsXlsx = createCatalogXlsxController(createContactsXlsxService({ databases, catalogs: catalogsService, findCountry: (code) => companiesRepository.findCountry(code), rateLimiter, deleteRule: rules.contactDeletePerUser, versionKey, activityLog, logger, now }));
  const cardsXlsx = createCatalogXlsxController(createCardsXlsxService({ databases, catalogs: catalogsService, indexes: cardIndexes, versionKey, activityLog, logger, now }));
  // The synchronization of the national tobacco price list into the products of a group (step C7).
  const tobaccoSync = createTobaccoSyncController(createTobaccoSyncService({ databases, catalogs: catalogsService, activityLog, logger, now }));
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
      ...createContactsRoutes(createContactsController(contactsService), idempotency),
      ...createCardsRoutes(createCardsController(cardsService), idempotency),
      // The sales of the group, read only (step V1): the legacy point of sale writes them.
      ...createSalesRoutes(createSalesController(createSalesService({ repository: createSalesRepository(databases), users, indexes: createSalesIndexGuard(databases, logger) }))),
      ...createSalesAdminRoutes(salesAdmin, idempotency),
      ...createContactGroupsRoutes(createContactGroupsController(contactGroupsService), idempotency),
      ...createProductAttributeGroupsRoutes(productAttributeGroups, idempotency),
      ...createStoreCatalogRoutes(storeCatalog, idempotency, requireOperator, rules.storeCatalogWritePerStore),
      ...createStoreContactsRoutes(storeContacts, idempotency, requireContactsOperator, rules.storeCatalogWritePerStore),
      ...createStoreSalesRoutes(storeSales, rules.storeSalesWritePerStore),
      ...createTobaccosRoutes(tobaccos, rules, idempotency),
      ...createCatalogXlsxRoutes(catalogXlsx, idempotency),
      ...createWorkbookRoutes({ exportSegment: CONTACTS_EXPORT_SEGMENT, importSegment: CONTACTS_IMPORT_SEGMENT, bucket: 'contacts', read: 'contacts:export', write: 'contacts:import', exportsPerHour: 5 }, contactsXlsx, idempotency),
      ...createWorkbookRoutes({ exportSegment: CARDS_EXPORT_SEGMENT, importSegment: CARDS_IMPORT_SEGMENT, bucket: 'fidelity-cards', read: 'fidelityCards:export', write: 'fidelityCards:import' }, cardsXlsx, idempotency),
      ...createTobaccoSyncRoutes(tobaccoSync, idempotency),
      ...createCountriesRoutes(countries, rules),
      ...createSettingsRoutes(settings, rules),
      ...createEInvoicingAccountsRoutes(eInvoicingAccounts, rules),
      ...createActivationsRoutes(activations, rules),
      ...createTrashRoutes(trash, rules, groups, createCrossGroupAuditor({ activityLog, now })),
      ...integrations.routes,
      ...createClientErrorsRoutes(clientErrors, rules),
    ],
    authenticate,
    authenticateStore,
    groups,
    nonBrowserGuard,
    securityPolicy,
    catalog: { products: productsService, categories: categoriesService, brands: brandsService, attributeGroups: attributeGroupsService, departments: departmentsService },
    crm: { contacts: contactsService, contactGroups: contactGroupsService, cards: cardsService },
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
  /** The services of the product catalog, from {@link createBackofficeModules}: the public API goes through the same rules as the backoffice. */
  readonly catalog: CatalogServices;
  /** The services of the contacts, their groups and the advanced cards, from {@link createBackofficeModules}: the public API goes through the same rules as the backoffice. */
  readonly crm: CrmServices;
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Composition root of the public API: the API key authentication (with the usage meter), the reads of places, companies and the group catalogs, the product catalog (reads and writes), the contacts with their groups and the advanced loyalty cards (reads and writes), and their routes.
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
  const catalog = createPublicCatalogController(createPublicCatalogService({ ...deps.catalog, callers: createApiKeyCallers(databases) }));
  const publicContacts = createPublicContactsController(createPublicContactsService({ contacts: deps.crm.contacts, contactGroups: deps.crm.contactGroups }));
  const publicCards = createPublicFidelityCardsController(createPublicFidelityCardsService({ cards: deps.crm.cards }));
  const publicSales = createPublicSalesController(createPublicSalesService({ repository: createPublicSalesRepository(databases), callers: createApiKeyCallers(databases) }));
  const idempotency = createIdempotencyStore(databases, idempotencyBodyKey(Buffer.from(config.versionHmacKey.reveal(), 'base64')), now);
  const rules = createRateLimitRules(config);
  // One budget of writes per key for the whole public API: the catalog, the contacts and the cards share it.
  const writeLimit = rules.publicCatalogWritePerKey;
  return { routes: [...createPublicRoutes(controller), ...createPublicCatalogRoutes(catalog, idempotency, writeLimit), ...createPublicContactsRoutes(publicContacts, idempotency, writeLimit), ...createPublicFidelityCardsRoutes(publicCards, idempotency, writeLimit), ...createPublicSalesRoutes(publicSales)], authenticate: createAuthenticateApiKey({ repository: keys, rateLimiter, activityLog, logger, meter, now }), meter };
}

/**
 * Picks the settings of the integrations module out of the platform configuration, one field at a time, so the module never receives the rest of it (database URIs, HMAC keys).
 *
 * @param config The configuration of the platform.
 * @returns A new object with exactly the fields of {@link IntegrationsConfig}.
 */
export function integrationsConfigOf(config: Config): IntegrationsConfig {
  return {
    cervedApiKey: config.cervedApiKey,
    cervedBaseUrl: config.cervedBaseUrl,
    dojoBaseUrl: config.dojoBaseUrl,
    dojoResellerId: config.dojoResellerId,
    dojoSoftwareHouseId: config.dojoSoftwareHouseId,
    dojoApiVersion: config.dojoApiVersion,
    satispayAuthBaseUrl: config.satispayAuthBaseUrl,
    satispayPublicKey: config.satispayPublicKey,
    tshAuthBaseUrl: config.tshAuthBaseUrl,
    tshApiBaseUrl: config.tshApiBaseUrl,
    tshTestAuthBaseUrl: config.tshTestAuthBaseUrl,
    tshTestApiBaseUrl: config.tshTestApiBaseUrl,
    googleMapsApiKey: config.googleMapsApiKey,
    geocodingBaseUrl: config.geocodingBaseUrl,
    geocodingDailyLimit: config.geocodingDailyLimit,
  };
}
