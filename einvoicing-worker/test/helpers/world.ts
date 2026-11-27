import { ObjectId } from 'mongodb';
import type { Collection, Document, MongoClient } from 'mongodb';
import { createCredentialDecryptor, dealerPasswordContext, platformPasswordContext } from '../../src/accounts/credentials.ts';
import { createAccountRegistry } from '../../src/accounts/registry.ts';
import type { AccountRegistry } from '../../src/accounts/registry.ts';
import { commonDatabaseName, groupDatabaseName, queueDatabaseName } from '../../src/db/names.ts';
import type { DatabaseNameContext } from '../../src/db/names.ts';
import { createEngine, forgetHub } from '../../src/engine/engine.ts';
import type { Engine } from '../../src/engine/engine.ts';
import { createGroupStore } from '../../src/engine/groups.ts';
import { createSentHistory, SENT_COLLECTION } from '../../src/engine/history.ts';
import type { SentInvoice } from '../../src/engine/history.ts';
import { createQueueStore } from '../../src/engine/queue.ts';
import type { EngineContext } from '../../src/engine/context.ts';
import { createLimiters, ensureLimiterIndexes, LIMITS_COLLECTION } from '../../src/limits/limiters.ts';
import type { LimiterDocument, Limiters } from '../../src/limits/limiters.ts';
import { createLogger } from '../../src/logger.ts';
import type { Logger } from '../../src/logger.ts';
import type { Account, FindOutcome, InvoiceRef, OutgoingFile, ProviderAdapter, StatusOutcome, UploadOutcome } from '../../src/providers/types.ts';
import type { Job } from '../../src/runner.ts';
import { baseRecord, withValues } from '../fixtures/records.ts';
import type { RecordData } from '../fixtures/records.ts';
import { encrypt, generateKeys } from './credentials.ts';
import type { TestKeys } from './credentials.ts';
import { createTestClient, dropPrefixAndClose, randomTestPrefix } from './mongo.ts';

/** 27 November 2026, 12:00 UTC (13:00 in Rome): the invoice date of the base record is that day. */
export const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);

/** A clock the tests move by hand; its `sleep` only advances the time. */
export interface TestClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Every wait asked of `sleep`, in milliseconds. */
  readonly waits: number[];
}

export function createClock(start = T0): TestClock {
  let current = start;
  const waits: number[] = [];
  return {
    now: () => current,
    set: (ms) => void (current = ms),
    advance: (ms) => void (current += ms),
    waits,
    sleep: async (ms, signal) => {
      waits.push(ms);
      if (signal?.aborted !== true) {
        current += ms;
      }
    },
  };
}

/** A logger that keeps every line. */
export interface LogSink {
  readonly logger: Logger;
  readonly lines: string[];
  /** The parsed lines. */
  entries(): Array<Record<string, unknown>>;
  /** The messages of the lines at a level (or all). */
  messages(level?: string): string[];
}

export function createLogSink(): LogSink {
  const lines: string[] = [];
  const entries = (): Array<Record<string, unknown>> => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    logger: createLogger({ level: 'debug', write: (line) => void lines.push(line), now: () => T0 }),
    lines,
    entries,
    messages: (level) => entries().filter((entry) => level === undefined || entry['level'] === level).map((entry) => String(entry['message'])),
  };
}

/** Disposable databases (common, queue, groups) under one random prefix, and the collections the engine uses. */
export interface World {
  readonly client: MongoClient;
  readonly names: DatabaseNameContext;
  readonly keys: TestKeys;
  readonly queue: Collection<Document>;
  readonly dealers: Collection<Document>;
  readonly settings: Collection<Document>;
  readonly users: Collection<Document>;
  readonly limits: Collection<LimiterDocument>;
  readonly sent: Collection<SentInvoice>;
  /** The `documents` collection of a group. */
  group(groupId: ObjectId): Collection<Document>;
  /** Empties every collection the tests use. */
  reset(): Promise<void>;
  drop(): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const client = await createTestClient();
  const prefix = randomTestPrefix();
  const names: DatabaseNameContext = { prefix, appEnv: 'development' };
  const common = client.db(commonDatabaseName(names));
  const world: World = {
    client,
    names,
    keys: generateKeys('test-key-1'),
    queue: client.db(queueDatabaseName(names)).collection('documents'),
    dealers: common.collection('dealers'),
    settings: common.collection('settings'),
    users: common.collection('users'),
    limits: common.collection<LimiterDocument>(LIMITS_COLLECTION),
    sent: common.collection<SentInvoice>(SENT_COLLECTION),
    group: (groupId) => client.db(groupDatabaseName(names, groupId.toHexString())).collection('documents'),
    reset: async () => {
      for (const collection of [world.queue, world.dealers, world.settings, world.users, world.limits, world.sent]) {
        await collection.deleteMany({});
      }
      await world.limits.dropIndexes().catch(() => undefined);
      await world.sent.dropIndexes().catch(() => undefined);
    },
    drop: () => dropPrefixAndClose(client, prefix),
  };
  return world;
}

/** The hub of a dealer. */
export const dealerHubName = (provider: string, id: ObjectId): string => `${provider}__${id.toHexString()}`;

/** What a test says about an account; the rest has defaults. */
export interface AccountSpec {
  readonly enabled?: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly maxPerHour?: number;
  readonly maxPerYear?: number | null;
  /** Overrides the stored `password` (a tampered or foreign ciphertext). */
  readonly storedPassword?: unknown;
}

/** The stored subdocument of an account (`integrations.<provider>`), encrypted for the world's key. */
export function accountDocument(world: World, provider: string, place: { dealerId?: ObjectId }, spec: AccountSpec = {}): Document {
  const context = place.dealerId === undefined ? platformPasswordContext(provider) : dealerPasswordContext(provider, place.dealerId.toHexString());
  return {
    enabled: spec.enabled ?? true,
    username: spec.username ?? `user-${place.dealerId?.toHexString().slice(-6) ?? 'platform'}`,
    password: 'storedPassword' in spec ? spec.storedPassword : encrypt(world.keys, spec.password ?? 'test-password', context),
    maxPerHour: spec.maxPerHour ?? 55,
    maxPerYear: spec.maxPerYear === undefined ? 10_000 : spec.maxPerYear,
    updatedAt: new Date(T0),
  };
}

/** Stores a dealer with an account; returns its hub. */
export async function seedDealerAccount(world: World, provider: string, spec: AccountSpec = {}, id = new ObjectId()): Promise<string> {
  await world.dealers.replaceOne({ _id: id }, { _id: id, name: 'Dealer', integrations: { [provider]: accountDocument(world, provider, { dealerId: id }, spec) } }, { upsert: true });
  await world.users.replaceOne({ _id: id }, { _id: id, role: 'D', status: true, trash: false }, { upsert: true });
  return dealerHubName(provider, id);
}

/** Stores the platform's account; returns its hub (the provider). */
export async function seedPlatformAccount(world: World, provider: string, spec: AccountSpec = {}): Promise<string> {
  await world.settings.updateOne({ key: 'INTEGRATIONS' }, { $set: { [`value.${provider}`]: accountDocument(world, provider, {}, spec) } }, { upsert: true });
  return provider;
}

/** An adapter whose answers the test chooses. */
export interface FakeAdapter extends ProviderAdapter {
  readonly uploads: Array<{ account: Account; file: OutgoingFile }>;
  readonly statuses: Array<{ account: Account; providerId: string }>;
  readonly finds: Array<{ account: Account; ref: InvoiceRef }>;
  readonly forgotten: string[];
  onUpload: (account: Account, file: OutgoingFile) => UploadOutcome | Promise<UploadOutcome>;
  onStatus: (account: Account, providerId: string) => StatusOutcome | Promise<StatusOutcome>;
  onFind: (account: Account, ref: InvoiceRef) => FindOutcome | Promise<FindOutcome>;
}

/** @param fast No pacing at all (for end-to-end tests that cannot wait for the real spacing). */
export function createFakeAdapter(provider = 'fake', fast = false): FakeAdapter {
  let counter = 0;
  const adapter: FakeAdapter = {
    provider,
    transmitter: { IdPaese: 'IT', IdCodice: '01879020517' },
    limits: {
      ip: {
        upload: { minIntervalMs: fast ? 0 : 3_000, jitterMs: fast ? 0 : 500, maxPerHour: null, maxPerYear: null },
        status: { minIntervalMs: fast ? 0 : 6_000, jitterMs: fast ? 0 : 1_500, maxPerHour: null, maxPerYear: null },
        auth: { minIntervalMs: 65_000, jitterMs: 3_000, maxPerHour: null, maxPerYear: null },
      },
      account: { minIntervalMs: () => (fast ? 0 : 65_000), jitterMs: fast ? 0 : 3_000, backoffStepsMs: [600_000, 1_500_000, 3_720_000] },
    maxCallMs: 0,
    },
    uploads: [],
    statuses: [],
    finds: [],
    forgotten: [],
    onUpload: () => ({ kind: 'accepted', providerId: `${provider}-file-${++counter}.xml` }),
    onStatus: () => ({ kind: 'status', status: 'takingCharge' }),
    onFind: () => ({ kind: 'notFound' }),
    upload: async (account, file) => {
      adapter.uploads.push({ account, file });
      return await adapter.onUpload(account, file);
    },
    status: async (account, providerId) => {
      adapter.statuses.push({ account, providerId });
      return await adapter.onStatus(account, providerId);
    },
    findSent: async (account, ref) => {
      adapter.finds.push({ account, ref });
      return await adapter.onFind(account, ref);
    },
    forget: (hub) => void adapter.forgotten.push(hub),
  };
  return adapter;
}

/** Everything a test needs to run engine rounds. */
export interface Rig {
  readonly world: World;
  readonly clock: TestClock;
  readonly log: LogSink;
  readonly adapter: FakeAdapter;
  readonly registry: AccountRegistry;
  readonly limiters: Limiters;
  readonly context: EngineContext;
  readonly engine: Engine;
  /** Runs one round: every job in order with the given lease epoch. Returns the signal controller to abort. */
  round(epoch?: number, signal?: AbortSignal): Promise<void>;
}

export interface RigOptions {
  readonly hubs: readonly string[];
  readonly adapter?: FakeAdapter;
  readonly adapters?: ReadonlyMap<string, ProviderAdapter>;
  readonly clock?: TestClock;
  readonly budgetMs?: number;
  readonly accountsRefreshMs?: number;
  readonly recordLeaseMs?: number;
  readonly keys?: TestKeys;
  readonly random?: () => number;
  readonly scanLimit?: number;
  readonly loadLimit?: number;
  readonly ensureIndexes?: () => Promise<void>;
}

/** Builds the engine on a world, with real MongoDB collections and a hand-moved clock. */
export function createRig(world: World, options: RigOptions): Rig {
  const clock = options.clock ?? createClock();
  const log = createLogSink();
  const adapter = options.adapter ?? createFakeAdapter();
  const adapters = options.adapters ?? new Map<string, ProviderAdapter>([[adapter.provider, adapter]]);
  const keys = options.keys ?? world.keys;
  const history = createSentHistory(world.sent);
  const registry = createAccountRegistry({
    dealers: world.dealers,
    settings: world.settings,
    users: world.users,
    hubs: options.hubs,
    decrypt: createCredentialDecryptor(keys.privateKey, keys.keyId),
    logger: log.logger,
    onDrop: (hub) => forgetHub(adapters, hub),
    scanLimit: options.scanLimit ?? 1000,
  });
  const limiters = createLimiters({ collection: world.limits, random: options.random ?? (() => 0), loadLimit: options.loadLimit ?? 1000 });
  const context: EngineContext = {
    queue: createQueueStore({ collection: world.queue, recordLeaseMs: options.recordLeaseMs ?? 120_000 }),
    history,
    groups: createGroupStore(world.client, world.names),
    registry,
    limiters,
    adapters,
    logger: log.logger,
    clock: clock.now,
    sleep: clock.sleep,
  };
  const engine = createEngine({
    context,
    hubs: options.hubs,
    budgetMs: options.budgetMs ?? 30_000,
    accountsRefreshMs: options.accountsRefreshMs ?? 120_000,
    ensureIndexes:
      options.ensureIndexes ??
      (async () => {
        await history.ensureIndexes();
        await ensureLimiterIndexes(world.limits);
        await context.queue.ensureIndexes();
      }),
  });
  return {
    world,
    clock,
    log,
    adapter,
    registry,
    limiters,
    context,
    engine,
    round: async (epoch = 1, signal = new AbortController().signal) => {
      for (const job of engine.jobs as readonly Job[]) {
        await job.run({ epoch, signal });
      }
    },
  };
}

/** The check digit that completes ten digits into an Italian VAT number. */
function vatCheckDigit(ten: string): string {
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const digit = Number(ten[index]);
    sum += index % 2 === 0 ? digit : digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
  }
  return String((10 - (sum % 10)) % 10);
}

/** The VAT number made of ten digits and their check digit. */
export const vatWithCheck = (ten: string): string => `${ten}${vatCheckDigit(ten)}`;

/** Two valid (synthetic) Italian VAT numbers for the two sellers the tests use. */
export const SELLER_A = `0123456789${vatCheckDigit('0123456789')}`;
export const SELLER_B = '01879020517';

/** The `company` fields of a seller with a valid VAT number (the queue fixtures' own number has a wrong check digit). */
export const sellerFields = (vat: string): Record<string, unknown> => ({ 'company.code': `IT${vat}`, 'company.code2': vat });

/** A queue record ready to be sent through `hub`, with the id of its group and a group document for it. */
export async function seedRecord(world: World, hub: string, values: Record<string, unknown> = {}, options: { group?: boolean } = {}): Promise<Document> {
  const id = new ObjectId();
  const groupId = new ObjectId();
  const record: Document = {
    ...(withValues(baseRecord(), { 'company.fattura_elettronica.hub': hub, ...sellerFields(SELLER_A), ...values }) as RecordData),
    _id: id,
    groupId,
  };
  await world.queue.insertOne(record);
  if (options.group !== false) {
    await world.group(groupId).insertOne({ _id: id, sendStatus: 'new' });
  }
  return record;
}

/** Reads a queue record. */
export async function queueRecordOf(world: World, record: Document): Promise<Document | null> {
  return await world.queue.findOne({ _id: record['_id'] });
}

/** Reads the `sendStatus` of the group document of a record. */
export async function groupStatusOf(world: World, record: Document): Promise<unknown> {
  return (await world.group(record['groupId'] as ObjectId).findOne({ _id: record['_id'] }))?.['sendStatus'];
}
