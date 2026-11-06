import type { RequestHandler } from 'express';
import type { Config } from './config.ts';
import type { Databases } from './db/databases.ts';
import type { ActivityLog } from './shared/activity-log/activity-log.ts';
import type { RouteDefinition } from './shared/http/routes.ts';
import type { Logger } from './shared/logging/logger.ts';
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
import { createGroupSummaryRepository } from './modules/me/group-summary.repository.ts';
import { createMeController } from './modules/me/me.controller.ts';
import { createMeRoutes } from './modules/me/me.routes.ts';
import { createMeService } from './modules/me/me.service.ts';
import { createReferenceController } from './modules/reference/reference.controller.ts';
import { createReferenceRepository } from './modules/reference/reference.repository.ts';
import { createReferenceRoutes } from './modules/reference/reference.routes.ts';
import { createReferenceService } from './modules/reference/reference.service.ts';
import { createSessionsRepository } from './modules/sessions/sessions.repository.ts';
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
  /** Bearer authentication of `/v1`. */
  readonly authenticate: RequestHandler;
  /** Group lookup for the routes declaring `group: true`. */
  readonly groups: GroupsRepository;
}

/** Collaborators of {@link createBackofficeModules}. */
export interface BackofficeDeps {
  readonly config: Config;
  readonly databases: Databases;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Composition root of the backoffice (`/v1`) modules: builds the repositories over the databases and
 * the services, controllers and routes of login and sessions, the profile, the user management, the dealer registry, the reference lists, the groups, the activity log monitor and the browser error reports. The only place that
 * knows how the layers are connected.
 *
 * @param deps Configuration, databases, activity log, logger and clock.
 * @returns Routes, authentication middleware and group lookup, ready for `createApp`.
 */
export function createBackofficeModules(deps: BackofficeDeps): BackofficeModules {
  const { config, databases, activityLog, logger } = deps;
  const now = deps.now ?? Date.now;
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
  const reference = createReferenceController(createReferenceService(createReferenceRepository(databases)));
  const activity = createActivityLogController(createActivityLogService(createActivityLogRepository(databases)));
  const clientErrors = createClientErrorsController(createClientErrorsService({ activityLog, logger, now }));
  return {
    routes: [...createAuthRoutes(auth, rules), ...createMeRoutes(me, rules), ...createUsersRoutes(usersController, rules), ...createDealersRoutes(dealersController, rules), ...createReferenceRoutes(reference), ...createGroupsRoutes(groupsController),
      ...createCatalogRoutes(catalogsService, CATALOGS),
      ...createGroupServicesRoutes(groupServices),
      ...createActivityLogRoutes(activity),
      ...createClientErrorsRoutes(clientErrors, rules),
    ],
    authenticate,
    groups,
  };
}
