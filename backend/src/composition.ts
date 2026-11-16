import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Config } from './config.ts';
import type { MediaStorage } from './integrations/gcs/index.ts';
import type { Databases } from './db/databases.ts';
import type { ActivityLog } from './shared/activity-log/activity-log.ts';
import type { RouteDefinition } from './shared/http/routes.ts';
import type { Logger } from './shared/logging/logger.ts';
import type { RateLimiter } from './shared/security/rate-limit/rate-limiter.ts';
import { createRateLimitRules } from './shared/security/rate-limit/rules.ts';
import { createCompanyPlacesRepository } from './shared/security/scope/company-places.repository.ts';
import { createDealerGroupsRepository } from './shared/security/scope/dealer-groups.repository.ts';
import { createGroupsRepository } from './shared/security/scope/groups.repository.ts';
import type { GroupsRepository } from './shared/security/scope/groups.repository.ts';
import { createActivityLogController } from './modules/activity-log/activity-log.controller.ts';
import { createActivityLogRepository } from './modules/activity-log/activity-log.repository.ts';
import { createActivityLogRoutes } from './modules/activity-log/activity-log.routes.ts';
import { createActivityLogService } from './modules/activity-log/activity-log.service.ts';
import { createAuthController } from './modules/auth/auth.controller.ts';
import { createAuthRoutes } from './modules/auth/auth.routes.ts';
import { createAuthService } from './modules/auth/auth.service.ts';
import { createAuthenticate } from './modules/auth/authenticate.ts';
import { createLookupController } from './modules/group-lookup/lookup.controller.ts';
import { createLookupRepository } from './modules/group-lookup/lookup.repository.ts';
import { createLookupRoutes } from './modules/group-lookup/lookup.routes.ts';
import { createLookupService } from './modules/group-lookup/lookup.service.ts';
import { createGroupServicesController } from './modules/group-services/services.controller.ts';
import { createServicesRepository } from './modules/group-services/services.repository.ts';
import { createGroupServicesRoutes } from './modules/group-services/services.routes.ts';
import { createGroupServicesService } from './modules/group-services/services.service.ts';
import { createClientErrorsController } from './modules/client-errors/client-errors.controller.ts';
import { createClientErrorsRoutes } from './modules/client-errors/client-errors.routes.ts';
import { createClientErrorsService } from './modules/client-errors/client-errors.service.ts';
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
import { createIdempotencyStore } from './shared/http/idempotency.ts';
import { createReferenceController } from './modules/reference/reference.controller.ts';
import { createReferenceRepository } from './modules/reference/reference.repository.ts';
import { createReferenceRoutes } from './modules/reference/reference.routes.ts';
import { createReferenceService } from './modules/reference/reference.service.ts';
import { createSessionsRepository } from './modules/sessions/sessions.repository.ts';
import { createAuthenticateStore } from './modules/store-keys/authenticate-store.ts';
import { createStoreKeysController } from './modules/store-keys/store-keys.controller.ts';
import { createStoreKeysRepository } from './modules/store-keys/store-keys.repository.ts';
import { createStoreKeysRoutes } from './modules/store-keys/store-keys.routes.ts';
import { createStoreKeysService } from './modules/store-keys/store-keys.service.ts';
import { createStoreStateReader } from './modules/store-keys/store-state.ts';
import { companiesPlacesReader, companiesPlacesWriter } from './shared/legacy-write/companies-places.writer.ts';
import { createCredentialsRepository } from './modules/users/credentials.repository.ts';
import { createGroupDirectoryRepository } from './modules/users/group-directory.repository.ts';
import { createGroupOptionsReader } from './modules/users/group-options.ts';
import { createUsersController } from './modules/users/users.controller.ts';
import { createUsersRoutes } from './modules/users/users.routes.ts';
import { createUsersService } from './modules/users/users.service.ts';
import { createUsersRepository } from './modules/users/users.repository.ts';

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
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Composition root of the backoffice (`/v1`) modules: builds the repositories over the databases and
 * the services, controllers and routes of login and sessions, the profile, the user management, the dealer registry, the reference lists, the companies, the places, the store keys of the points of sale, the media (images), the groups, the activity log monitor and the browser error reports. The only place that
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
  const dealersController = createDealersController(createDealersService({ dealers, users, usersService, activityLog, now }));
  const groupsController = createGroupsController(
    createGroupsService({ groups: createManagedGroupsRepository(databases), users, sessions, activityLog, logger, transaction: (work) => databases.transaction(work), now }),
  );
  const groupServices = createGroupServicesController(createGroupServicesService({ services, users }));
  const catalogsService = createCatalogsService({
    catalogs: catalogsRepository,
    references: createReferencesRepository(databases),
    activityLog,
    logger,
    newId: newElementId,
    now,
  });
  const lookup = createLookupController(createLookupService({ lookup: createLookupRepository(databases), users, catalogs: catalogsService }));
  const reference = createReferenceController(createReferenceService(createReferenceRepository(databases)));
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
  const companies = createCompaniesController(
    createCompaniesService({
      repository: companiesRepository,
      writerFor: (principal, access) => companiesPlacesWriter(principal, access, databases, { now: () => new Date(now()), versionKey }),
      images: mediaService,
      activityLog,
      newId: () => randomBytes(12).toString('hex'),
    }),
  );
  const idempotency = createIdempotencyStore(databases, now);
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
  const places = createPlacesController(
    createPlacesService({
      repository: createPlacesRepository(databases, companiesRepository),
      writerFor: (principal, access) => companiesPlacesWriter(principal, access, databases, { now: () => new Date(now()), versionKey }),
      readerFor: (principal, access) => companiesPlacesReader(principal, access, databases, { versionKey }),
      logger,
      activityLog,
      references: createReferencesRepository(databases),
      images: mediaService,
      storeKeys: storeKeysService,
      newId: () => newPaymentTypeId(now),
    }),
  );
  const activity = createActivityLogController(createActivityLogService(createActivityLogRepository(databases)));
  const clientErrors = createClientErrorsController(createClientErrorsService({ activityLog, logger, now }));
  return {
    routes: [...createAuthRoutes(auth, rules), ...createMeRoutes(me, rules), ...createUsersRoutes(usersController, rules), ...createDealersRoutes(dealersController, rules), ...createReferenceRoutes(reference), ...createCompaniesRoutes(companies, idempotency), ...createPlacesRoutes(places, idempotency), ...createStoreKeysRoutes(storeKeys, rules), ...createMediaRoutes(media, rules, () => mediaService.available), ...createGroupsRoutes(groupsController),
      ...createCatalogRoutes(catalogsService, CATALOGS),
      ...createGroupServicesRoutes(groupServices),
      ...createLookupRoutes(lookup),
      ...createActivityLogRoutes(activity),
      ...createClientErrorsRoutes(clientErrors, rules),
    ],
    authenticate,
    authenticateStore,
    groups,
  };
}
