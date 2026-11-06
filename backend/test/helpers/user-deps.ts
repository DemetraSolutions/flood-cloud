import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createServicesRepository } from '../../src/modules/group-services/services.repository.ts';
import { createGroupOptionsReader } from '../../src/modules/users/group-options.ts';
import type { Databases } from '../../src/db/databases.ts';

/**
 * The collaborators of the users service that read the group (the services and the lists the POS options refer to), over real databases.
 *
 * @param databases Throw-away databases.
 */
export function groupReaders(databases: Databases) {
  return { services: createServicesRepository(databases), groupOptions: createGroupOptionsReader(createCatalogsRepository(databases)) };
}
