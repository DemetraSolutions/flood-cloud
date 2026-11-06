import type { ObjectId } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import type { ServicesQuery } from './services.schemas.ts';
import { SERVICES_LIST, SERVICE_NAME } from './services.list.ts';
import type { ServicesRepository } from './services.repository.ts';

/** A service of a group in the compact form the user form needs. */
export interface ServiceItem {
  readonly id: string;
  /** The name in the language of the user, or in the first language the service has; empty when it has none. */
  readonly name: string;
}

/** A page of services. */
export interface ServicesPage {
  readonly items: readonly ServiceItem[];
  readonly page: PageInfo;
}

/** The compact read of the services of a group. */
export interface GroupServicesService {
  /**
   * Lists the services of a group by name.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit; `NOT_FOUND` if the caller disappeared since the authentication.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: ServicesQuery): Promise<ServicesPage>;
}

/** Collaborators of {@link createGroupServicesService}. */
export interface GroupServicesDeps {
  readonly services: Pick<ServicesRepository, 'list'>;
  /** Reads the language of the caller. */
  readonly users: Pick<UsersRepository, 'findById'>;
}

/**
 * Builds the service of the compact list of the services of a group.
 *
 * @param deps Repository of the services and of the users.
 */
export function createGroupServicesService(deps: GroupServicesDeps): GroupServicesService {
  return {
    list: async (principal, access, query) => {
      const params = listParamsOf(query, SERVICES_LIST);
      const caller = await deps.users.findById(principal.userId);
      if (caller === null) {
        throw new AppError('NOT_FOUND');
      }
      const { items, page } = await deps.services.list(principal, access, params, caller.user.language);
      return { items: items.map((item) => ({ id: (item['_id'] as ObjectId).toHexString(), name: typeof item[SERVICE_NAME] === 'string' ? item[SERVICE_NAME] : '' })), page };
    },
  };
}
