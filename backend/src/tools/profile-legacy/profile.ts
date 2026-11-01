import type { AppEnv } from '../../config.ts';
import type { Databases } from '../../db/databases.ts';
import { createFieldProfiler } from './fields.ts';
import type { FieldProfile } from './fields.ts';
import { profileGroups } from './groups.ts';
import type { GroupsProfile } from './groups.ts';
import { listIndexInfo } from './indexes.ts';
import type { IndexInfo } from './indexes.ts';
import { MAX_TIME_MS, streamDocuments } from './read.ts';
import { profileGroupDatabases } from './tenants.ts';
import type { GroupDatabasesProfile, TenancyIndex } from './tenants.ts';
import { profileUsers, readDealerIds } from './users.ts';
import type { UsersProfile } from './users.ts';

/** What the profile says about the databases of the cluster. */
export interface DatabasesSection {
  /** `true` if the common database has at least one collection. */
  commonPresent: boolean;
  /** Group databases found for this prefix and environment. */
  groupDatabases: number;
  /** Groups in `groups` that have no database. */
  groupsWithoutDatabase: number;
  /** Group databases whose group is not in `groups`. */
  databasesWithoutGroup: number;
  /** Other databases of the cluster, as counts only. */
  other: Record<'flite_common' | 'queue' | 'other', number>;
}

/** The report written by the tool. It contains no personal data, secret, value, id or database name. */
export interface LegacyProfile {
  generatedAt: string;
  appEnv: AppEnv;
  serverVersion: string;
  databases: DatabasesSection;
  collections: {
    users: { fields: FieldProfile; indexes: IndexInfo[] };
    groups: { fields: FieldProfile; indexes: IndexInfo[] };
    countries: { fields: FieldProfile; indexes: IndexInfo[] };
    companies: GroupDatabasesProfile['companies'];
    places: GroupDatabasesProfile['places'];
  };
  checks: {
    password: UsersProfile['password'];
    pin: UsersProfile['pin'];
    personalData: {
      users: UsersProfile['personalData'];
      groupsApiKey: GroupsProfile['apiKey'];
      groupsIntegrationApiKeys: GroupsProfile['integrationApiKeys'];
    };
    tokens: UsersProfile['tokens'];
    roleScope: UsersProfile['roleScope'];
    references: UsersProfile['references'] &
      GroupDatabasesProfile['references'] & { 'groups.dealerId': GroupsProfile['dealerId'] };
    groupIdVsDatabase: GroupDatabasesProfile['groupIdVsDatabase'];
    duplicates: {
      users: UsersProfile['duplicates'];
      companyCode: GroupDatabasesProfile['companyCodeDuplicates'];
    };
  };
}

/** Options of {@link profileLegacy}. */
export interface ProfileOptions {
  /** Environment of the databases being profiled. */
  readonly appEnv: AppEnv;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /** Called with `(done, total)` after every `progressEvery` group databases. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Progress interval in group databases (50 by default). */
  readonly progressEvery?: number;
}

/**
 * Profiles the legacy databases of one environment in read-only mode and returns a report made of
 * counts, types, field names and allowlisted enums only. Group databases are read one at a time.
 *
 * @param databases Database accessor over the client of the environment to profile.
 * @param options Environment and clock.
 * @returns The report.
 * @example
 * const report = await profileLegacy(databases, { appEnv: 'development' });
 */
export async function profileLegacy(databases: Databases, options: ProfileOptions): Promise<LegacyProfile> {
  const common = databases.common();
  const serverVersion = await databases.serverVersion();
  const other = await databases.countOtherDatabases();
  const commonPresent = (await common.listCollections({}, { nameOnly: true, maxTimeMS: MAX_TIME_MS }).toArray()).length > 0;
  const groupIds = await databases.listGroupIds();

  const dealerHexes = await readDealerIds(common);
  const groupDatabases = await profileGroupDatabases(databases, groupIds, options.onProgress, options.progressEvery);
  const groups = await profileGroups(common, dealerHexes);

  const countryFields = createFieldProfiler();
  for await (const country of streamDocuments(common.collection('countries'), {}, { _id: 0 })) {
    countryFields.add(country);
  }

  const tenancy: TenancyIndex = { groupHexes: groups.groupHexes, dealerHexes, perGroup: groupDatabases.scopes };
  const users = await profileUsers(common, tenancy);

  const databaseHexes = new Set(groupIds.map((id) => id.toHexString()));
  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    appEnv: options.appEnv,
    serverVersion,
    databases: {
      commonPresent,
      groupDatabases: groupIds.length,
      groupsWithoutDatabase: [...groups.groupHexes].filter((hex) => !databaseHexes.has(hex)).length,
      databasesWithoutGroup: [...databaseHexes].filter((hex) => !groups.groupHexes.has(hex)).length,
      other,
    },
    collections: {
      users: { fields: users.fields, indexes: users.indexes },
      groups: { fields: groups.fields, indexes: groups.indexes },
      countries: { fields: countryFields.result(), indexes: await listIndexInfo(common, common.collection('countries')) },
      companies: groupDatabases.companies,
      places: groupDatabases.places,
    },
    checks: {
      password: users.password,
      pin: users.pin,
      personalData: {
        users: users.personalData,
        groupsApiKey: groups.apiKey,
        groupsIntegrationApiKeys: groups.integrationApiKeys,
      },
      tokens: users.tokens,
      roleScope: users.roleScope,
      references: { ...users.references, ...groupDatabases.references, 'groups.dealerId': groups.dealerId },
      groupIdVsDatabase: groupDatabases.groupIdVsDatabase,
      duplicates: { users: users.duplicates, companyCode: groupDatabases.companyCodeDuplicates },
    },
  };
}
