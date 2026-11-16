import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';
import { startBackoffice } from './backoffice.ts';
import type { Backoffice, BackofficeOptions } from './backoffice.ts';
import { fullLegacyCompany } from './company-fixtures.ts';
import { fixtureId, legacyCountry, legacyUser } from './legacy-fixtures.ts';
import { insertCopies } from './mirror.ts';
import type { TestDatabases } from './mongo.ts';
import { actors } from './users.ts';

/** The running backoffice of a company test, with the helpers every one of them needs. */
export interface CompaniesWorld {
  readonly office: Backoffice;
  readonly as: ReturnType<typeof actors>;
  /** Group `index` of the isolation cluster. */
  group(index: number): Backoffice['cluster']['groups'][number];
  /** `/groups/<id>/companies` plus a suffix. */
  path(index: number, rest?: string): string;
  /** The stored company, as the legacy would read it with the exact types, in the group database. */
  stored(index: number, id: ObjectId): Promise<Document | null>;
  /** Its copy in the common database. */
  copyOf(id: ObjectId): Promise<Document | null>;
  /** Inserts a complete legacy company in the group database and its copy. */
  seed(index: number, n: number, overrides?: Document): Promise<ObjectId>;
}

/**
 * Starts the backoffice over a throw-away MongoDB with the data the company routes need: Italy with two provinces, Germany without areas, a second currency for
 * the first group, a second dealer user of the platform in the trash and one dealer that exists.
 *
 * @param ctx Throw-away databases.
 * @param options Environment overrides, limiter and extra routes of the backoffice.
 */
export async function startCompaniesWorld(ctx: TestDatabases, options: BackofficeOptions = {}): Promise<CompaniesWorld> {
  const office = await startBackoffice(ctx, options);
  const common = ctx.databases.common();
  await common.collection('countries').deleteMany({});
  await common.collection('countries').insertMany([
    legacyCountry(1, { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }, { code: 'RM', name: 'Roma' }] }),
    legacyCountry(2, { code: 'DE', name: 'Germania', areas: [] }),
    legacyCountry(3, { code: 'FR', name: 'Francia', areas: 'none' }),
  ]);
  const first = office.cluster.groups[0]!;
  await common.collection('groups').updateOne({ _id: first.groupId }, { $set: { 'currencies.USD': { code: 'USD', symbol: '$' } } });
  await common.collection('users').insertMany([legacyUser(600, { role: 'D', trash: true }), legacyUser(601, { role: 'D', status: false })]);
  const group = (index: number) => office.cluster.groups[index]!;
  return {
    office,
    as: actors(office),
    group,
    path: (index, rest = '') => `/groups/${group(index).groupId.toHexString()}/companies${rest}`,
    stored: (index, id) => ctx.databases.group(group(index).groupId, 'cluster0').collection('companies').findOne({ _id: id }, { ...EXACT_TYPES }),
    copyOf: (id) => common.collection('companies').findOne({ _id: id }, { ...EXACT_TYPES }),
    seed: async (index, n, overrides = {}) => {
      const document = fullLegacyCompany(n, group(index).groupId, overrides);
      await ctx.databases.group(group(index).groupId, 'cluster0').collection('companies').insertOne(document);
      await insertCopies(ctx.databases, 'companies', [document]);
      return document['_id'] as ObjectId;
    },
  };
}

/** The id of a dealer that is in the trash (user 600). */
export const TRASHED_DEALER = fixtureId('user', 600);
