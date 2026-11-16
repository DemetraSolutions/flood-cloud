import type { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';
import type { BackofficeOptions } from './backoffice.ts';
import { startCompaniesWorld } from './companies.ts';
import type { CompaniesWorld } from './companies.ts';
import { fixtureId } from './legacy-fixtures.ts';
import { insertCopies } from './mirror.ts';
import type { TestDatabases } from './mongo.ts';
import { fullLegacyPlace } from './place-fixtures.ts';

/** The running backoffice of a place test: the world of the company tests (countries, currencies, actors) and the helpers every place test needs. */
export interface PlacesWorld extends CompaniesWorld {
  /** `/groups/<id>/places` plus a suffix. */
  placePath(index: number, rest?: string): string;
  /** The stored place, as the legacy would read it with the exact types, in the group database. */
  storedPlace(index: number, id: ObjectId): Promise<Document | null>;
  /** Its copy in the common database. */
  copyOfPlace(id: ObjectId): Promise<Document | null>;
  /** Inserts a complete legacy place (company `companyN` of the group) in the group database and its copy; its id is `fixtureId('place', n)`. */
  seedPlace(index: number, n: number, companyN: number, overrides?: Document): Promise<ObjectId>;
}

/**
 * Starts the backoffice over a throw-away MongoDB with the data the place routes need (the one of {@link startCompaniesWorld}).
 *
 * @param ctx Throw-away databases.
 * @param options Environment overrides, limiter and extra routes of the backoffice.
 */
export async function startPlacesWorld(ctx: TestDatabases, options: BackofficeOptions = {}): Promise<PlacesWorld> {
  const world = await startCompaniesWorld(ctx, options);
  const common = ctx.databases.common();
  return {
    ...world,
    placePath: (index, rest = '') => `/groups/${world.group(index).groupId.toHexString()}/places${rest}`,
    storedPlace: (index, id) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection('places').findOne({ _id: id }, { ...EXACT_TYPES }),
    copyOfPlace: (id) => common.collection('places').findOne({ _id: id }, { ...EXACT_TYPES }),
    seedPlace: async (index, n, companyN, overrides = {}) => {
      const document = fullLegacyPlace(n, world.group(index).groupId, fixtureId('company', companyN), overrides);
      await ctx.databases.group(world.group(index).groupId, 'cluster0').collection('places').insertOne(document);
      await insertCopies(ctx.databases, 'places', [document]);
      return document['_id'] as ObjectId;
    },
  };
}
