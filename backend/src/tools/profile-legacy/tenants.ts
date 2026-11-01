import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { emptyRefKinds, emptyRefProfile, tallyKind, tallyRef } from './classify.ts';
import type { RefKinds, RefProfile } from './classify.ts';
import { countDuplicates, valueCounts } from './duplicates.ts';
import type { DuplicateCount } from './duplicates.ts';
import { createFieldProfiler } from './fields.ts';
import type { FieldProfile } from './fields.ts';
import { indexUnion, listIndexInfo } from './indexes.ts';
import type { IndexUsage } from './indexes.ts';
import { hasCollection, streamDocuments } from './read.ts';

/** Default number of group databases between two progress notifications. */
export const PROGRESS_INTERVAL = 50;

/** Ids that exist inside one group database, as lowercase hex. */
export interface GroupScope {
  companies: ReadonlySet<string>;
  places: ReadonlySet<string>;
}

/** Everything the user and group checks need to know about identity and tenancy. */
export interface TenancyIndex {
  /** Ids of the documents of `groups`. */
  groupHexes: ReadonlySet<string>;
  /** Ids of the users with role `D`. */
  dealerHexes: ReadonlySet<string>;
  /** Companies and places of each existing group database. */
  perGroup: ReadonlyMap<string, GroupScope>;
}

/** How the `groupId` stored in a document compares with the database it lives in. */
export interface GroupIdMatch {
  match: number;
  mismatch: number;
  missing: number;
  notObjectId: number;
}

/** Profile of a collection aggregated over every group database. */
export interface GroupCollectionProfile {
  /** Group databases in which the collection exists. */
  databasesWithCollection: number;
  fields: FieldProfile;
  indexes: IndexUsage[];
}

/** Duplicates of `companies.code`. */
export interface CompanyCodeDuplicates {
  /** Duplicates inside a single group database. */
  perGroup: DuplicateCount & { groupsWithDuplicates: number };
  /** Duplicates across all group databases. */
  global: DuplicateCount & { valuesSpanningGroups: number };
}

/** Result of reading every group database. */
export interface GroupDatabasesProfile {
  companies: GroupCollectionProfile;
  places: GroupCollectionProfile;
  groupIdVsDatabase: { companies: GroupIdMatch; places: GroupIdMatch };
  references: {
    'companies.groupId': RefKinds;
    'places.groupId': RefKinds;
    'places.companyId': RefProfile;
  };
  companyCodeDuplicates: CompanyCodeDuplicates;
  scopes: ReadonlyMap<string, GroupScope>;
}

function tallyGroupId(match: GroupIdMatch, value: unknown, expected: ObjectId): void {
  if (value === undefined || value === null) {
    match.missing += 1;
  } else if (!(value instanceof ObjectId)) {
    match.notObjectId += 1;
  } else if (value.equals(expected)) {
    match.match += 1;
  } else {
    match.mismatch += 1;
  }
}

/**
 * Reads `companies` and `places` of every group database, one database at a time, and aggregates
 * field inventories, indexes, reference checks and `groupId` consistency. Read-only.
 *
 * @param databases Database accessor.
 * @param groupIds Ids of the group databases to read.
 * @param onProgress Called with `(done, total)` after every `progressEvery` databases.
 * @param progressEvery Progress interval ({@link PROGRESS_INTERVAL} by default).
 * @returns The aggregated profile plus the ids found in each database.
 */
export async function profileGroupDatabases(
  databases: Databases,
  groupIds: readonly ObjectId[],
  onProgress?: (done: number, total: number) => void,
  progressEvery: number = PROGRESS_INTERVAL,
): Promise<GroupDatabasesProfile> {
  const companyFields = createFieldProfiler({ booleans: ['status', 'trash'] });
  const placeFields = createFieldProfiler({
    enums: ['plan', 'devices[].type'],
    booleans: ['status', 'trash'],
  });
  const companyIndexes = indexUnion();
  const placeIndexes = indexUnion();
  const groupIdVsDatabase = {
    companies: { match: 0, mismatch: 0, missing: 0, notObjectId: 0 },
    places: { match: 0, mismatch: 0, missing: 0, notObjectId: 0 },
  };
  const companiesGroupRefs = emptyRefKinds();
  const placesGroupRefs = emptyRefKinds();
  const placesCompanyRefs = emptyRefProfile();
  const perGroupDuplicates = { duplicateValues: 0, documentsInvolved: 0, groupsWithDuplicates: 0 };
  const codes = new Map<string, { documents: number; groups: number }>();
  const scopes = new Map<string, GroupScope>();
  let companyDatabases = 0;
  let placeDatabases = 0;

  for (const [position, groupId] of groupIds.entries()) {
    const db = databases.group(groupId);
    const companies = (await hasCollection(db, 'companies')) ? db.collection('companies') : undefined;
    const places = (await hasCollection(db, 'places')) ? db.collection('places') : undefined;
    const companyIds = new Set<string>();
    const placeIds = new Set<string>();

    if (companies !== undefined) {
      companyDatabases += 1;
      for await (const document of streamDocuments(companies, {}, {})) {
        companyFields.add(document);
        companyIds.add(String(document['_id']));
        tallyKind(companiesGroupRefs, document['groupId']);
        tallyGroupId(groupIdVsDatabase.companies, document['groupId'], groupId);
      }
      const duplicates = await countDuplicates(companies, 'code');
      if (duplicates.duplicateValues > 0) {
        perGroupDuplicates.groupsWithDuplicates += 1;
        perGroupDuplicates.duplicateValues += duplicates.duplicateValues;
        perGroupDuplicates.documentsInvolved += duplicates.documentsInvolved;
      }
      for await (const [code, documents] of valueCounts(companies, 'code')) {
        const known = codes.get(code);
        if (known === undefined) {
          codes.set(code, { documents, groups: 1 });
        } else {
          known.documents += documents;
          known.groups += 1;
        }
      }
      companyIndexes.add(await listIndexInfo(db, companies));
    }

    if (places !== undefined) {
      placeDatabases += 1;
      for await (const document of streamDocuments(places, {}, {})) {
        placeFields.add(document);
        placeIds.add(String(document['_id']));
        tallyKind(placesGroupRefs, document['groupId']);
        tallyGroupId(groupIdVsDatabase.places, document['groupId'], groupId);
        tallyRef(placesCompanyRefs, document['companyId'], companyIds);
      }
      placeIndexes.add(await listIndexInfo(db, places));
    }

    scopes.set(groupId.toHexString(), { companies: companyIds, places: placeIds });
    if ((position + 1) % progressEvery === 0) {
      onProgress?.(position + 1, groupIds.length);
    }
  }

  const global = { duplicateValues: 0, documentsInvolved: 0, valuesSpanningGroups: 0 };
  for (const { documents, groups } of codes.values()) {
    if (documents > 1) {
      global.duplicateValues += 1;
      global.documentsInvolved += documents;
    }
    if (groups > 1) {
      global.valuesSpanningGroups += 1;
    }
  }

  return {
    companies: { databasesWithCollection: companyDatabases, fields: companyFields.result(), indexes: companyIndexes.result() },
    places: { databasesWithCollection: placeDatabases, fields: placeFields.result(), indexes: placeIndexes.result() },
    groupIdVsDatabase,
    references: {
      'companies.groupId': companiesGroupRefs,
      'places.groupId': placesGroupRefs,
      'places.companyId': placesCompanyRefs,
    },
    companyCodeDuplicates: { perGroup: perGroupDuplicates, global },
    scopes,
  };
}
