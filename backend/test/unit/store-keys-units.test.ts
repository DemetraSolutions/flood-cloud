import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { createCredentialDispatcher } from '../../src/modules/auth/authenticate.ts';
import { createAuthenticateStore } from '../../src/modules/store-keys/authenticate-store.ts';
import type { AuthenticateStoreDeps } from '../../src/modules/store-keys/authenticate-store.ts';
import { toStoreKeyStatus } from '../../src/modules/store-keys/store-keys.mapper.ts';
import { auditActivationCode, auditKeyRevoked } from '../../src/modules/store-keys/store-keys.audit.ts';
import { activationBody, requireNoBodyContent } from '../../src/modules/store-keys/store-keys.schemas.ts';
import { createStoreKeysService } from '../../src/modules/store-keys/store-keys.service.ts';
import type { StoreKeysRepository } from '../../src/modules/store-keys/store-keys.repository.ts';
import type { StoreKey } from '../../src/modules/store-keys/store-keys.types.ts';
import type { StoreAssessment, StoreStateReader } from '../../src/modules/store-keys/store-state.ts';
import { actorOf, responseActorOf } from '../../src/shared/activity-log/actor.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { requireStorePermission, requireStorePlace } from '../../src/shared/security/scope/store-guards.ts';
import { generateSecret, hashSecret } from '../../src/shared/security/secrets.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';

const GROUP = fixtureId('group', 1);
const PLACE = fixtureId('place', 1);
const COMPANY = fixtureId('company', 1);
const NOW = Date.parse('2026-11-13T10:00:00.000Z');
const client = { requestId: 'req-1', ip: null, userAgent: null };

const keyOf = (overrides: Partial<StoreKey> = {}): StoreKey => ({
  id: fixtureId('user', 70),
  groupId: GROUP,
  placeId: PLACE,
  hint: 'AbC1',
  status: 'active',
  activatedAt: new Date(NOW),
  activatedBy: { userId: fixtureId('user', 2), role: 'PSA' },
  installation: { userAgent: null, appVersion: null, platform: null },
  activationIp: null,
  lastSeenAt: new Date(NOW),
  lastSeenIp: null,
  lastSeenUserAgent: null,
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  ...overrides,
});

/** A request with an `Authorization` header (and optionally an address and a user agent), and a response with locals. */
function exchangeOf(authorization: string | undefined, extra: { ip?: string; userAgent?: string } = {}): { req: Request; res: Response } {
  const headers: Record<string, string | undefined> = { authorization, 'user-agent': extra.userAgent };
  const req = { get: (name: string) => headers[name.toLowerCase()], ip: extra.ip } as unknown as Request;
  const res = { locals: { requestId: 'req-1' }, set: () => undefined } as unknown as Response;
  return { req, res };
}

describe('the authentication of a store key, with its collaborators scripted', () => {
  const secret = generateSecret('fc_sk_');
  function build(scripted: { key?: StoreKey | null; assessment?: StoreAssessment; revokeResult?: StoreKey | null; touch?: () => Promise<void> }) {
    const touched: unknown[] = [];
    const revoked: unknown[] = [];
    const lookups: string[] = [];
    const activity = memoryActivityLog();
    const logs = memoryLogger();
    const deps: AuthenticateStoreDeps = {
      repository: {
        findByHash: async (hash: string) => {
          lookups.push(hash);
          return hash === hashSecret(secret) ? (scripted.key === undefined ? keyOf() : scripted.key) : null;
        },
        revokeKey: async (...args: unknown[]) => {
          revoked.push(args);
          return scripted.revokeResult === undefined ? keyOf() : scripted.revokeResult;
        },
        touch: async (...args: unknown[]) => {
          touched.push(args);
          return scripted.touch === undefined ? undefined : scripted.touch();
        },
      } as unknown as StoreKeysRepository,
      state: { assess: async () => scripted.assessment ?? { kind: 'ok', companyId: COMPANY } } as unknown as StoreStateReader,
      activityLog: activity,
      rateLimiter: memoryRateLimiter(),
      logger: logs.logger,
      apiRule: { bucket: 'api:store', limit: 600, key: () => null },
      now: () => NOW,
    };
    return { deps, handler: createAuthenticateStore(deps), touched, revoked, lookups, activity, logs };
  }
  const run = async (handler: ReturnType<typeof build>['handler'], req: Request, res: Response): Promise<unknown> => {
    let result: unknown = 'not called';
    try {
      await handler(req, res, () => {
        result = 'next';
      });
    } catch (error) {
      result = error;
    }
    return result;
  };

  it('puts a frozen principal in res.locals.store, never in res.locals.auth, and touches the key without an address or a user agent when the request has none', async () => {
    const { handler, touched } = build({});
    const { req, res } = exchangeOf(`Bearer ${secret}`);
    assert.equal(await run(handler, req, res), 'next');
    assert.equal(res.locals.auth, undefined);
    const store = res.locals.store!;
    assert.ok(Object.isFrozen(store) && Object.isFrozen(store.scope));
    assert.deepEqual([store.kind, store.keyId, store.groupId, store.companyId, store.placeId, [...store.permissions]], ['store', keyOf().id, GROUP, COMPANY, PLACE, ['places:read']]);
    assert.deepEqual(touched, [[keyOf().id, { at: new Date(NOW), ip: null, userAgent: null }]]);
  });

  it('touches the key with the address and the user agent, cut at 200 characters', async () => {
    const { handler, touched } = build({});
    const { req, res } = exchangeOf(`Bearer ${secret}`, { ip: '203.0.113.7', userAgent: 'U'.repeat(250) });
    assert.equal(await run(handler, req, res), 'next');
    assert.deepEqual(touched, [[keyOf().id, { at: new Date(NOW), ip: '203.0.113.7', userAgent: 'U'.repeat(200) }]]);
  });

  it('logs, and does not fail, when the update of the last contact fails', async () => {
    const { handler, logs } = build({ touch: async () => Promise.reject(new Error('mongo down')) });
    const { req, res } = exchangeOf(`Bearer ${secret}`);
    assert.equal(await run(handler, req, res), 'next');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logs.events.at(-1)?.['msg'], 'updating the last use of a store key failed');
    assert.ok(!logs.lines.join('').includes(secret));
  });

  it('answers 401 without querying anything for a header that is not a key of exact format', async () => {
    const { handler, lookups } = build({});
    for (const header of [undefined, '', 'Bearer', `Bearer ${secret.slice(0, -1)}`, `Basic ${secret}`, `Bearer ${secret} x`]) {
      const { req, res } = exchangeOf(header);
      const outcome = await run(handler, req, res);
      assert.ok(outcome instanceof AppError && outcome.code === 'UNAUTHENTICATED', String(header));
    }
    assert.deepEqual(lookups, [], 'no query for a value that cannot be a key');
  });

  it('records a revoked key that is presented without an address too, once', async () => {
    const { handler, activity } = build({ key: keyOf({ status: 'revoked', revokedAt: new Date(NOW), revokeReason: 'revoked' }) });
    for (let i = 0; i < 2; i += 1) {
      const { req, res } = exchangeOf(`Bearer ${secret}`);
      assert.ok((await run(handler, req, res)) instanceof AppError);
    }
    assert.equal(activity.entries.length, 1);
    assert.equal('ip' in activity.entries[0]!, false);
    const { req, res } = exchangeOf(`Bearer ${secret}`, { ip: '203.0.113.7' });
    assert.ok((await run(build({ key: keyOf({ status: 'revoked' }) }).handler, req, res)) instanceof AppError);
  });

  it('revokes as the system when the place is gone, records it once, and does not record a revocation another request already made', async () => {
    const gone: StoreAssessment = { kind: 'revoke', reason: 'placeDeleted' };
    const first = build({ assessment: gone });
    const { req, res } = exchangeOf(`Bearer ${secret}`);
    assert.ok((await run(first.handler, req, res)) instanceof AppError);
    assert.deepEqual(first.revoked, [[keyOf().id, { at: new Date(NOW), by: { kind: 'system' }, reason: 'placeDeleted' }]]);
    assert.deepEqual(first.activity.entries.map((entry) => [entry.action, entry.actor, entry.metadata]), [['store.keyRevoked', { kind: 'system' }, { reason: 'placeDeleted', keyHint: 'AbC1' }]]);
    const raced = build({ assessment: gone, revokeResult: null });
    const again = exchangeOf(`Bearer ${secret}`);
    const outcome = await run(raced.handler, again.req, again.res);
    assert.ok(outcome instanceof AppError && outcome.code === 'UNAUTHENTICATED');
    assert.deepEqual(raced.activity.entries, []);
  });

  it('answers 429 over the limit of the key before anything else is read, recording the first excess only (without an address too)', async () => {
    const tight = build({});
    // A rule of one request a minute: the second request is over, the third is the same excess.
    const handler = createAuthenticateStore({ ...tight.deps, apiRule: { bucket: 'api:store', limit: 1, key: () => null } });
    const codes: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { req, res } = exchangeOf(`Bearer ${secret}`, i === 2 ? { ip: '203.0.113.7' } : {});
      const outcome = await run(handler, req, res);
      codes.push(outcome instanceof AppError ? outcome.code : outcome);
    }
    assert.deepEqual(codes, ['next', 'RATE_LIMITED', 'RATE_LIMITED']);
    assert.deepEqual(tight.activity.entries.map((entry) => [entry.action, entry.actor.kind, 'ip' in entry]), [['rateLimit.exceeded', 'store', false]]);
    assert.equal(tight.touched.length, 1, 'a request over the limit reads and touches nothing');
  });

  it('answers 401 for a key whose group is gone and 403 STORE_DISABLED for a blocked store, touching the key in the second case', async () => {
    const unknown = build({ assessment: { kind: 'unauthenticated' } });
    const a = exchangeOf(`Bearer ${secret}`);
    const outcomeA = await run(unknown.handler, a.req, a.res);
    assert.ok(outcomeA instanceof AppError && outcomeA.code === 'UNAUTHENTICATED' && unknown.touched.length === 0);
    const blocked = build({ assessment: { kind: 'blocked' } });
    const b = exchangeOf(`Bearer ${secret}`);
    const outcomeB = await run(blocked.handler, b.req, b.res);
    assert.ok(outcomeB instanceof AppError && outcomeB.code === 'STORE_DISABLED' && blocked.touched.length === 1);
    assert.equal(b.res.locals.store, undefined);
  });
});

describe('the credential dispatcher', () => {
  it('hands a secret with the prefix of a store key to the store check, and every other request to the user check', () => {
    const calls: string[] = [];
    const dispatch = createCredentialDispatcher(
      () => void calls.push('user'),
      () => void calls.push('store'),
    );
    for (const header of ['Bearer fc_sk_abc', 'bearer FC_SK_abc', 'Bearer  fc_sk_x']) {
      dispatch(exchangeOf(header).req, {} as Response, () => undefined);
    }
    for (const header of [undefined, 'Bearer fc_at_abc', 'Bearer fc_pk_abc', 'Basic fc_sk_abc', ' Bearer fc_sk_abc']) {
      dispatch(exchangeOf(header).req, {} as Response, () => undefined);
    }
    assert.deepEqual(calls, ['store', 'store', 'user', 'user', 'user', 'user', 'user', 'user']);
  });
});

describe('the guards of a store', () => {
  const store = { placeId: PLACE, permissions: new Set(['places:read']) };
  const run = (guard: (req: Request, res: Response, next: () => void) => void, req: object, locals: object): unknown => {
    try {
      let passed = false;
      guard(req as Request, { locals } as unknown as Response, () => void (passed = true));
      return passed ? 'next' : 'stopped';
    } catch (error) {
      return error instanceof AppError ? error.code : error;
    }
  };

  it('keeps a route to the place of the key, and refuses a request that has no store at all', () => {
    const guard = requireStorePlace as never;
    assert.equal(run(guard, { params: { placeId: PLACE.toHexString() } }, { store }), 'next');
    assert.equal(run(guard, { params: { placeId: new ObjectId().toHexString() } }, { store }), 'NOT_FOUND');
    assert.equal(run(guard, { params: {} }, { store }), 'NOT_FOUND');
    assert.equal(run(guard, { params: { placeId: PLACE.toHexString() } }, {}), 'UNAUTHENTICATED');
  });

  it('holds a store to its profile: a permission that is not in it is 403, and without a store principal 401', () => {
    assert.equal(run(requireStorePermission('places:read') as never, {}, { store }), 'next');
    assert.equal(run(requireStorePermission('places:update') as never, {}, { store }), 'FORBIDDEN');
    assert.equal(run(requireStorePermission('storeKeys:manage') as never, {}, { store }), 'FORBIDDEN');
    assert.equal(run(requireStorePermission('places:read') as never, {}, {}), 'UNAUTHENTICATED');
  });
});

describe('the actor of a response', () => {
  it('is the store for a store key, the user for a session and anonymous otherwise', () => {
    const keyId = fixtureId('user', 70);
    assert.deepEqual(responseActorOf({ locals: { store: { keyId } } } as never), { kind: 'store', id: keyId });
    const user = principalOf('SA');
    assert.deepEqual(responseActorOf({ locals: { auth: user } } as never), actorOf(user));
    assert.deepEqual(responseActorOf({ locals: {} } as never), { kind: 'anonymous' });
  });
});

describe('the audit of the store keys without a client address', () => {
  it('leaves the address out of the entry', async () => {
    const activity = memoryActivityLog();
    await auditKeyRevoked(activity, { key: keyOf(), reason: 'revoked', actor: { kind: 'system' }, client });
    await auditActivationCode(activity, { action: 'store.activationCodeCreated', actor: { kind: 'system' }, groupId: GROUP, placeId: PLACE, client });
    await auditKeyRevoked(activity, { key: keyOf(), reason: 'revoked', actor: { kind: 'system' }, client: { ...client, ip: '203.0.113.7' } });
    await auditActivationCode(activity, { action: 'store.activationCodeCancelled', actor: { kind: 'system' }, groupId: GROUP, placeId: PLACE, client: { ...client, ip: '203.0.113.7' } });
    assert.deepEqual(activity.entries.map((entry) => entry.ip ?? null), [null, null, '203.0.113.7', '203.0.113.7']);
  });
});

describe('the schemas of the store keys', () => {
  it('reads the body of the exchange and keeps nothing but the declared fields', async () => {
    const { validate } = await import('../../src/shared/validation/schema.ts');
    assert.deepEqual(validate(activationBody, { activationCode: '', installation: { appVersion: '1.2.3-rc.1+b5', platform: 'Windows 11' } }, '(body)'), { activationCode: '', installation: { appVersion: '1.2.3-rc.1+b5', platform: 'Windows 11' } });
    assert.deepEqual(validate(activationBody, { activationCode: 'x' }, '(body)'), { activationCode: 'x' });
  });

  it('accepts no body and {} for the creation of a code and refuses anything else', () => {
    const run = (body: unknown): string => {
      try {
        requireNoBodyContent({ body } as Request, {} as Response, () => undefined);
        return 'next';
      } catch (error) {
        return error instanceof AppError ? error.code : String(error);
      }
    };
    assert.deepEqual([run(undefined), run({}), run({ a: 1 }), run([]), run('x')], ['next', 'next', 'VALIDATION_ERROR', 'VALIDATION_ERROR', 'VALIDATION_ERROR']);
  });
});

describe('the representation of the key of a place', () => {
  it('names every field it sends and sends nothing else', () => {
    const view = toStoreKeyStatus({
      status: 'active',
      key: keyOf({ installation: { userAgent: 'UA', appVersion: '1', platform: 'p' }, lastSeenIp: '203.0.113.7' }),
      pendingActivation: { createdAt: new Date(NOW), expiresAt: new Date(NOW + 1000), createdBy: { userId: fixtureId('user', 3), role: 'D' } },
      lastRevoked: { revokedAt: new Date(NOW), reason: 'replaced' },
    });
    assert.deepEqual(Object.keys(view.key!).sort(), ['activatedAt', 'activatedBy', 'hint', 'id', 'installation', 'lastSeenAt', 'lastSeenIp']);
    assert.deepEqual(Object.keys(view).sort(), ['key', 'lastRevoked', 'pendingActivation', 'status']);
    assert.ok(!JSON.stringify(view).includes('activationIp'));
  });
});

describe('the service of the store keys with a client that has no address', () => {
  function scripted(state: StoreAssessment) {
    const activity = memoryActivityLog();
    const repository = {
      consumeActivationCode: async () => ({ groupId: GROUP, placeId: PLACE, createdBy: { userId: fixtureId('user', 2), role: 'PSA' as const } }),
      revokeActiveOfPlace: async () => null,
      createKey: async (key: { keyHash: string; hint: string }) => keyOf({ hint: key.hint }),
    } as unknown as StoreKeysRepository;
    const service = createStoreKeysService({
      repository,
      state: { assess: async () => state } as unknown as StoreStateReader,
      activityLog: activity,
      rateLimiter: memoryRateLimiter(),
      transaction: async (work) => work({} as never),
      failureRule: { bucket: 'auth-fail:ip', limit: 300 },
      activationCodeTtlMinutes: 60,
      now: () => NOW,
    });
    return { service, activity };
  }

  it('activates and records it with no address, and records a failure with no address', async () => {
    const ok = scripted({ kind: 'ok', companyId: COMPANY });
    const done = await ok.service.exchange({ activationCode: '0123-4567-89AB-CDEF' }, client);
    assert.deepEqual([done.groupId, done.placeId, done.companyId], [GROUP, PLACE, COMPANY]);
    assert.deepEqual(ok.activity.entries.map((entry) => [entry.action, 'ip' in entry]), [['store.activated', false]]);
    const no = scripted({ kind: 'blocked' });
    await assert.rejects(() => no.service.exchange({ activationCode: '0123-4567-89AB-CDEF' }, client), (error: unknown) => error instanceof AppError && error.code === 'INVALID_CREDENTIALS');
    assert.deepEqual(no.activity.entries.map((entry) => [entry.action, 'ip' in entry]), [['store.activationFailed', false]]);
  });

  it('does nothing when a place that goes to the trash has no key', async () => {
    const { service, activity } = scripted({ kind: 'blocked' });
    await service.revokeForPlace(GROUP, PLACE, 'placeTrashed', principalOf('SA'), client);
    assert.deepEqual(activity.entries, []);
  });
});
