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
import { createAuthController } from './modules/auth/auth.controller.ts';
import { createAuthRoutes } from './modules/auth/auth.routes.ts';
import { createAuthService } from './modules/auth/auth.service.ts';
import { createAuthenticate } from './modules/auth/authenticate.ts';
import { createGroupSummaryRepository } from './modules/me/group-summary.repository.ts';
import { createMeController } from './modules/me/me.controller.ts';
import { createMeRoutes } from './modules/me/me.routes.ts';
import { createMeService } from './modules/me/me.service.ts';
import { createSessionsRepository } from './modules/sessions/sessions.repository.ts';
import { createCredentialsRepository } from './modules/users/credentials.repository.ts';
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
 * the services, controllers and routes of login and sessions, and the profile. The only place that
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
  const rules = createRateLimitRules(config);

  const authenticate = createAuthenticate({
    sessions,
    users,
    groups,
    scope: { ...createDealerGroupsRepository(databases), ...createCompanyPlacesRepository(databases) },
    activityLog,
    logger,
    now,
  });
  const auth = createAuthController(createAuthService({ config, users, credentials, sessions, groups, activityLog, now }));
  const me = createMeController(
    createMeService({ config, users, credentials, sessions, groups: createGroupSummaryRepository(databases), activityLog, now }),
  );
  return { routes: [...createAuthRoutes(auth, rules), ...createMeRoutes(me, rules)], authenticate, groups };
}
