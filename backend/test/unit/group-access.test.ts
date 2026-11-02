import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ObjectId } from 'mongodb';
import { errorHandler } from '../../src/shared/http/error-handler.ts';
import { requirePermission } from '../../src/shared/security/rbac/require-permission.ts';
import { groupDatabaseFor, reportCrossGroupAccess, requireGroupAccess, resolveGroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { GroupAvailability } from '../../src/shared/security/scope/groups.repository.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { memoryLogger } from '../helpers/app.ts';
import { principalOf } from '../helpers/principal.ts';

const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);
const g3 = fixtureId('group', 3);
const hex = (id: ObjectId): string => id.toHexString();

const psa = principalOf('PSA');
const dealer = principalOf('D', { dealerGroupIds: [g1, g2] });
const sa = principalOf('SA', { groupId: g1 });
const ca = principalOf('CA', { groupId: g1, companyIds: [fixtureId('company', 1)] });
const pa = principalOf('PA', { groupId: g1, placeIds: [fixtureId('place', 1)] });
const employee = principalOf('E', { groupId: g1 });
const noGroup: AuthPrincipal = { ...principalOf('SA'), groupId: null, scope: { kind: 'none' } };

describe('resolveGroupAccess', () => {
  it('gives PSA every group, flagged as cross-group', () => {
    for (const group of [g1, g2, g3]) {
      const access = resolveGroupAccess(psa, hex(group));
      assert.ok(access !== null && access.groupId.equals(group) && access.crossGroup);
    }
  });

  it('gives D only the groups of the dealer, flagged as cross-group', () => {
    assert.equal(resolveGroupAccess(dealer, hex(g1))?.crossGroup, true);
    assert.equal(resolveGroupAccess(dealer, hex(g2))?.crossGroup, true);
    assert.equal(resolveGroupAccess(dealer, hex(g3)), null);
  });

  it('gives SA, CA and PA only their own group, not flagged', () => {
    for (const principal of [sa, ca, pa]) {
      assert.equal(resolveGroupAccess(principal, hex(g1))?.crossGroup, false);
      assert.equal(resolveGroupAccess(principal, hex(g2)), null);
    }
  });

  it('gives E and a user without group nothing', () => {
    assert.equal(resolveGroupAccess(employee, hex(g1)), null);
    assert.equal(resolveGroupAccess(noGroup, hex(g1)), null);
  });

  it('rejects malformed ids, even for PSA', () => {
    for (const raw of ['', 'abc', 'A'.repeat(24), `${hex(g1)}0`, hex(g1).slice(1), 'z'.repeat(24), `{"$ne":1}`, 5 as unknown as string]) {
      assert.equal(resolveGroupAccess(psa, raw), null, String(raw));
    }
  });

  it('returns a frozen access', () => {
    assert.ok(Object.isFrozen(resolveGroupAccess(psa, hex(g1))));
  });
});

describe('groupDatabaseFor', () => {
  const opened: ObjectId[] = [];
  const databases = { group: (id: ObjectId) => (opened.push(id), { name: hex(id) }) } as never;

  it('opens only the database of a verified access', () => {
    const access = resolveGroupAccess(sa, hex(g1))!;
    const db = groupDatabaseFor(sa, access, databases) as unknown as { name: string };
    assert.equal(db.name, hex(g1));
  });

  it('refuses an access it did not issue, even a look-alike', () => {
    const forged: GroupAccess = { groupId: g1, crossGroup: false };
    assert.throws(() => groupDatabaseFor(sa, forged, databases), /verified group access/);
    assert.throws(() => groupDatabaseFor(psa, { ...resolveGroupAccess(psa, hex(g1))! }, databases), /verified group access/);
  });

  it('refuses an access presented by another principal', () => {
    const access = resolveGroupAccess(psa, hex(g2))!;
    assert.throws(() => groupDatabaseFor(sa, access, databases), /verified group access/);
    assert.equal(opened.length, 1);
  });
});

describe('requireGroupAccess and reportCrossGroupAccess', () => {
  const states = new Map<string, GroupAvailability>();
  const audit: Array<{ role: string; groupId: string; method: string; granted: boolean }> = [];
  let failAudit: 'throw' | 'reject' | null = null;
  let current: AuthPrincipal | undefined;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const groups = { findAvailability: async (id: ObjectId) => states.get(hex(id)) ?? null };
    const report = reportCrossGroupAccess(({ principal, groupId, req, granted }) => {
      if (failAudit === 'throw') {
        throw new Error('audit down');
      }
      if (failAudit === 'reject') {
        return Promise.reject(new Error('audit down'));
      }
      audit.push({ role: principal.role, groupId: hex(groupId), method: req.method, granted });
    });
    const app = express();
    app.use((_req, res, next) => {
      if (current !== undefined) {
        res.locals.auth = current;
      }
      next();
    });
    app.get('/groups/:groupId', requireGroupAccess(groups), requirePermission('places:read', report), (_req, res) => {
      res.json({ groupId: hex(res.locals.groupAccess!.groupId) });
    });
    app.use(errorHandler(memoryLogger().logger));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    states.clear();
    for (const group of [g1, g2, g3]) {
      states.set(hex(group), 'available');
    }
    audit.length = 0;
    failAudit = null;
  });

  const get = async (groupId: string): Promise<{ status: number; body: { code: string | undefined; groupId: string | undefined } }> => {
    const response = await fetch(`${baseUrl}/groups/${groupId}`);
    const json = (await response.json()) as { error?: { code: string }; groupId?: string };
    return { status: response.status, body: { code: json.error?.code, groupId: json.groupId } };
  };

  it('answers 401 without a principal', async () => {
    current = undefined;
    assert.deepEqual(await get(hex(g1)), { status: 401, body: { code: 'UNAUTHENTICATED', groupId: undefined } });
  });

  it('answers 404 outside the perimeter or for a malformed id, without auditing', async () => {
    current = sa;
    assert.equal((await get(hex(g2))).status, 404);
    assert.equal((await get('not-a-group')).body.code, 'NOT_FOUND');
    current = dealer;
    assert.equal((await get(hex(g3))).status, 404);
    assert.deepEqual(audit, []);
  });

  it('answers 404 to everybody, PSA included, for a group that does not exist', async () => {
    states.delete(hex(g1));
    for (const principal of [psa, dealer, sa]) {
      current = principal;
      assert.equal((await get(hex(g1))).status, 404, principal.role);
    }
    assert.deepEqual(audit, []);
  });

  it('lets only PSA into a suspended or trashed group', async () => {
    states.set(hex(g1), 'unavailable');
    for (const principal of [dealer, sa, ca, pa]) {
      current = principal;
      assert.equal((await get(hex(g1))).status, 404, principal.role);
    }
    current = psa;
    assert.equal((await get(hex(g1))).status, 200);
    assert.deepEqual(audit, [{ role: 'PSA', groupId: hex(g1), method: 'GET', granted: true }]);
  });

  it('passes an own-group access without reporting it', async () => {
    current = sa;
    assert.deepEqual(await get(hex(g1)), { status: 200, body: { code: undefined, groupId: hex(g1) } });
    assert.deepEqual(audit, []);
  });

  it('reports every PSA and D access to a group', async () => {
    current = psa;
    assert.equal((await get(hex(g3))).status, 200);
    current = dealer;
    assert.equal((await get(hex(g2))).status, 200);
    assert.deepEqual(audit, [
      { role: 'PSA', groupId: hex(g3), method: 'GET', granted: true },
      { role: 'D', groupId: hex(g2), method: 'GET', granted: true },
    ]);
  });

  it('reports a denied request as denied (a 403 is not an access)', async () => {
    current = { ...dealer, permissions: new Set() };
    assert.deepEqual(await get(hex(g1)), { status: 403, body: { code: 'FORBIDDEN', groupId: undefined } });
    assert.deepEqual(audit, [{ role: 'D', groupId: hex(g1), method: 'GET', granted: false }]);
  });

  it('fails the request when the report throws or its promise rejects (no unaudited cross-group access)', async () => {
    current = psa;
    for (const mode of ['throw', 'reject'] as const) {
      failAudit = mode;
      assert.deepEqual(await get(hex(g1)), { status: 500, body: { code: 'INTERNAL_ERROR', groupId: undefined } });
    }
  });
});
