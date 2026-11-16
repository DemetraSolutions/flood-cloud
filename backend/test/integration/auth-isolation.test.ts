import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectId } from 'mongodb';
import { startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { assertIsolation, isolationCases } from '../helpers/isolation.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let office: Backoffice;
const accessTokens = new Map<string, string>();

before(async () => {
  ctx = await openTestDatabases();
  // The place detail route of the places module is the route under test (it replaces the probe of the isolation model).
  office = await startBackoffice(ctx);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

/** Access token of a seeded user, from a real login (kept for the whole file). */
async function tokenOf(actor: ObjectId): Promise<string> {
  const key = actor.toHexString();
  if (!accessTokens.has(key)) {
    accessTokens.set(key, (await office.tokens(userName(actor))).accessToken);
  }
  return accessTokens.get(key)!;
}

describe('isolation through real sessions', () => {
  it('passes the standard cases of the isolation model with tokens obtained by logging in', async () => {
    const employees = new Set(office.cluster.groups.map((group) => group.employee.toHexString()));
    const cases = isolationCases(office.cluster).filter((isolationCase) => !employees.has(isolationCase.actor.toHexString()));
    assert.ok(cases.length >= 15);
    await assertIsolation(cases, async (isolationCase) => {
      const response = await office.call('GET', `/groups/${encodeURIComponent(isolationCase.groupId)}/places/${isolationCase.placeId.toHexString()}`, await tokenOf(isolationCase.actor));
      const body = (await response.json()) as { error?: { code: string } };
      return { status: response.status, code: body.error?.code };
    });
  });

  it('cannot even sign in an employee, so the employee cases never reach a group', async () => {
    for (const group of office.cluster.groups) {
      assert.equal((await office.login(userName(group.employee))).status, 401);
    }
  });

  it('refuses the same request without a token', async () => {
    const group = office.cluster.groups[0]!;
    const response = await office.call('GET', `/groups/${group.groupId.toHexString()}/places/${group.ownPlaceId.toHexString()}`, undefined);
    assert.equal(response.status, 401);
  });
});
