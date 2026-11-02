import assert from 'node:assert/strict';
import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { sendData } from '../../src/shared/http/envelope.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { createDealerGroupsRepository } from '../../src/shared/security/scope/dealer-groups.repository.ts';
import { createCompanyPlacesRepository } from '../../src/shared/security/scope/company-places.repository.ts';
import { groupDatabaseFor } from '../../src/shared/security/scope/group-access.ts';
import type { CrossGroupAccessHandler, GroupAccessDeps } from '../../src/shared/security/scope/group-access.ts';
import { createGroupsRepository } from '../../src/shared/security/scope/groups.repository.ts';
import { placesScopeFilter, withScope } from '../../src/shared/security/scope/scope-filters.ts';
import { fixtureId, legacyUser, seedLegacyCluster } from './legacy-fixtures.ts';
import { principalFromLegacyUser } from './principal.ts';

/** Header the test authenticator reads: the hex id of the legacy user to act as. */
export const TEST_USER_HEADER = 'x-test-user';

/** Number of groups of the isolation cluster: two for each of the two dealers. */
const GROUPS = 4;

/** Per-group users, companies and places of the isolation cluster (ids are deterministic). */
export interface IsolationGroup {
  readonly groupId: ObjectId;
  readonly dealerId: ObjectId;
  readonly sa: ObjectId;
  readonly ca: ObjectId;
  readonly pa: ObjectId;
  readonly employee: ObjectId;
  /** Place of company 1, the one the CA and the PA own. */
  readonly ownPlaceId: ObjectId;
  /** Place of company 2: same group, but outside the CA and the PA perimeter. */
  readonly otherPlaceId: ObjectId;
}

/** What {@link seedIsolationCluster} created. */
export interface IsolationCluster {
  readonly psa: ObjectId;
  readonly dealerA: ObjectId;
  readonly dealerB: ObjectId;
  /** Groups 0 and 1 belong to dealer A, groups 2 and 3 to dealer B. */
  readonly groups: readonly IsolationGroup[];
}

/**
 * Seeds the standard cluster of the isolation model with {@link seedLegacyCluster}: two dealers,
 * two groups each, and per group an SA, a CA (company 1), a PA (place 1), an E, two companies
 * and two places.
 *
 * @param databases Accessor over a throw-away prefix.
 */
export async function seedIsolationCluster(databases: Databases): Promise<IsolationCluster> {
  const seeded = await seedLegacyCluster(databases, { groups: GROUPS });
  const dealerB = fixtureId('user', 500);
  await databases.common().collection('users').insertOne(legacyUser(500, { role: 'D' }));
  await databases.common().collection('groups').updateMany({ _id: { $in: seeded.groupIds.slice(2) } }, { $set: { dealerId: dealerB } });
  // The fixtures carry no core module in their matrix: give everybody full legacy permissions (the role ceiling still applies).
  const full = { r: true, w: true };
  await databases
    .common()
    .collection('users')
    .updateMany({}, { $set: { permissions: { status: true, groups: full, users: full, companies: full, places: full, logs: full } } });
  const groups = seeded.groupIds.map((groupId, index): IsolationGroup => ({
    groupId,
    dealerId: index < 2 ? seeded.dealerId : dealerB,
    sa: fixtureId('user', 3 + 4 * index),
    ca: fixtureId('user', 4 + 4 * index),
    pa: fixtureId('user', 5 + 4 * index),
    employee: fixtureId('user', 6 + 4 * index),
    ownPlaceId: fixtureId('place', 1 + 2 * index),
    otherPlaceId: fixtureId('place', 2 + 2 * index),
  }));
  return { psa: fixtureId('user', 2), dealerA: seeded.dealerId, dealerB, groups };
}

/** One request of the standard isolation matrix. */
export interface IsolationCase {
  readonly name: string;
  /** The user the request acts as. */
  readonly actor: ObjectId;
  /** The raw `:groupId` of the path. */
  readonly groupId: string;
  /** The place requested inside that group. */
  readonly placeId: ObjectId;
  /** `200` visible, `403` permission missing, `404` outside the perimeter. */
  readonly expected: 200 | 403 | 404;
}

const STATUS_CODE = { 200: undefined, 403: 'FORBIDDEN', 404: 'NOT_FOUND' } as const;

/**
 * The standard cases every endpoint on a group resource must pass: another group, another
 * dealer, a CA outside the company, a PA outside the place, an E without scope, and a malformed
 * group id, plus the positive controls.
 *
 * @param cluster The seeded cluster.
 * @returns The cases, each with the expected status.
 */
export function isolationCases(cluster: IsolationCluster): IsolationCase[] {
  const [a1, a2, b1] = cluster.groups as [IsolationGroup, IsolationGroup, IsolationGroup, IsolationGroup];
  const hex = (group: IsolationGroup): string => group.groupId.toHexString();
  const make = (name: string, actor: ObjectId, group: IsolationGroup | string, placeId: ObjectId, expected: IsolationCase['expected']): IsolationCase => ({
    name,
    actor,
    groupId: typeof group === 'string' ? group : hex(group),
    placeId,
    expected,
  });
  return [
    make('PSA reaches a group of dealer A', cluster.psa, a1, a1.ownPlaceId, 200),
    make('PSA reaches a group of dealer B', cluster.psa, b1, b1.ownPlaceId, 200),
    make('dealer A reaches his first group', cluster.dealerA, a1, a1.ownPlaceId, 200),
    make('dealer A reaches his second group', cluster.dealerA, a2, a2.otherPlaceId, 200),
    make('dealer A does not reach a group of dealer B', cluster.dealerA, b1, b1.ownPlaceId, 404),
    make('dealer B does not reach a group of dealer A', cluster.dealerB, a1, a1.ownPlaceId, 404),
    make('SA reads every place of his group', a1.sa, a1, a1.otherPlaceId, 200),
    make('SA does not reach another group of the same dealer', a1.sa, a2, a2.ownPlaceId, 404),
    make('SA does not reach a group of another dealer', a1.sa, b1, b1.ownPlaceId, 404),
    make('SA cannot read a place of another group through his own group', a1.sa, a1, a2.ownPlaceId, 404),
    make('CA reads a place of his company', a1.ca, a1, a1.ownPlaceId, 200),
    make('CA does not read a place of another company of his group', a1.ca, a1, a1.otherPlaceId, 404),
    make('CA does not reach another group', a1.ca, a2, a2.ownPlaceId, 404),
    make('PA reads his place', a1.pa, a1, a1.ownPlaceId, 200),
    make('PA does not read another place of his company or group', a1.pa, a1, a1.otherPlaceId, 404),
    make('PA does not reach another group', a1.pa, a2, a2.ownPlaceId, 404),
    make('E has no scope at all, not even in his own group', a1.employee, a1, a1.ownPlaceId, 404),
    make('E does not reach another group', a1.employee, a2, a2.ownPlaceId, 404),
    make('a malformed group id is not found', cluster.psa, 'not-a-group', a1.ownPlaceId, 404),
    make('a group id with an operator is not found', a1.sa, '{"$ne":null}', a1.ownPlaceId, 404),
  ];
}

/** What the caller's HTTP client reports for one case. */
export interface IsolationResponse {
  readonly status: number;
  /** The `error.code` of the envelope, if any. */
  readonly code: string | undefined;
}

/**
 * Runs the cases and asserts status and error code of each one.
 *
 * @param cases The cases, usually from {@link isolationCases}.
 * @param send Builds and sends the request of a case (it must act as `case.actor` on `case.groupId` and `case.placeId`).
 */
export async function assertIsolation(cases: readonly IsolationCase[], send: (isolationCase: IsolationCase) => Promise<IsolationResponse>): Promise<void> {
  for (const isolationCase of cases) {
    const response = await send(isolationCase);
    assert.deepEqual({ status: response.status, code: response.code }, { status: isolationCase.expected, code: STATUS_CODE[isolationCase.expected] }, isolationCase.name);
  }
}

/**
 * Authenticator for tests: acts as the legacy user whose hex id is in {@link TEST_USER_HEADER}.
 * Unknown or missing users get `401`. It stands in for the real session middleware.
 *
 * @param databases Accessor over a throw-away prefix.
 */
export function testAuthenticator(databases: Databases): RequestHandler {
  const scopeDeps = { ...createDealerGroupsRepository(databases), ...createCompanyPlacesRepository(databases) };
  return async (req, res, next) => {
    const raw = req.get(TEST_USER_HEADER) ?? '';
    const user = ObjectId.isValid(raw) && raw.length === 24 ? await databases.common().collection('users').findOne({ _id: ObjectId.createFromHexString(raw) }) : null;
    if (user === null) {
      throw new AppError('UNAUTHENTICATED');
    }
    res.locals.auth = await principalFromLegacyUser(user, scopeDeps);
    next();
  };
}

/**
 * Group lookup and audit callback for the app under test.
 *
 * @param databases Accessor over a throw-away prefix.
 * @param onCrossGroupAccess Receives every PSA and D request to a group, with its outcome.
 */
export function isolationGroupAccess(databases: Databases, onCrossGroupAccess: CrossGroupAccessHandler): GroupAccessDeps {
  return { groups: createGroupsRepository(databases), onCrossGroupAccess };
}

/**
 * The probe route of the isolation model: `GET /groups/:groupId/places/:placeId`, protected by
 * group access, the `places:read` permission and the places scope filter, on the group database
 * obtained from the verified access. It exists only in tests.
 *
 * @param databases Accessor over a throw-away prefix.
 */
export function isolationProbeRoute(databases: Databases): RouteDefinition {
  return defineRoute({
    method: 'GET',
    path: '/groups/:groupId/places/:placeId',
    auth: { kind: 'user', permission: 'places:read', group: true },
    handler: async (req, res) => {
      const principal = res.locals.auth!;
      const rawPlaceId = req.params['placeId'] as string;
      if (!/^[0-9a-f]{24}$/.test(rawPlaceId)) {
        throw new AppError('NOT_FOUND');
      }
      const places = groupDatabaseFor(principal, res.locals.groupAccess!, databases).collection('places');
      const place = await places.findOne(withScope(placesScopeFilter(principal.scope), { _id: ObjectId.createFromHexString(rawPlaceId) }), { projection: { name: 1 } });
      if (place === null) {
        throw new AppError('NOT_FOUND');
      }
      sendData(res, { id: place._id.toHexString(), name: place['name'] as string });
    },
  });
}
