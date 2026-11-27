import type { Collection } from 'mongodb';
import { createLimiters } from '../../src/limits/limiters.ts';
import type { LimiterDocument, Limiters } from '../../src/limits/limiters.ts';
import { createArubaAdapter } from '../../src/providers/aruba/adapter.ts';
import type { ArubaDeps } from '../../src/providers/aruba/adapter.ts';
import type { Account, OutgoingFile, ProviderAdapter } from '../../src/providers/types.ts';
import { Secret } from '../../src/secret.ts';
import { startFakeAruba, tokenReply } from './fake-aruba.ts';
import type { FakeAruba } from './fake-aruba.ts';
import { createClock, createLogSink } from './world.ts';
import type { LogSink, TestClock } from './world.ts';

/** The password of the test account: the tests check it never reaches a log. */
export const TEST_PASSWORD = 'pw-secret-for-tests';

/** Limiters that keep their state in memory (the production code, over a collection that stores nothing). */
export function memoryLimiters(random: () => number = () => 0): Limiters {
  const collection = { replaceOne: async () => ({}) } as unknown as Collection<LimiterDocument>;
  return createLimiters({ collection, random, loadLimit: 10 });
}

/** A usable account. */
export function testAccount(values: Partial<Account> = {}): Account {
  return { hub: 'aruba', provider: 'aruba', username: 'test-user', password: new Secret(TEST_PASSWORD), maxPerHour: 55, maxPerYear: 10_000, ...values };
}

/** A file to send (the XML is a stand-in: the adapter does not read it). */
export function testFile(values: Partial<OutgoingFile> = {}): OutgoingFile {
  return { queueId: '0123456789abcdef01234567', sellerVat: 'IT01234567890', number: '42', date: '2026-11-27', progressive: '7', documentType: 'TD01', xml: '<xml>fattura &amp; ç</xml>', ...values };
}

/** Everything the adapter tests need. */
export interface ArubaRig {
  readonly fake: FakeAruba;
  readonly adapter: ProviderAdapter;
  readonly clock: TestClock;
  readonly log: LogSink;
  readonly limiters: Limiters;
  /** The accounts the registry knows, by hub (delete an entry to make a hub unusable). */
  readonly accounts: Map<string, Account>;
  /** How each `registry.get` was called: the hub and whether `fresh` was asked. */
  readonly reads: Array<{ hub: string; fresh: boolean }>;
  readonly account: Account;
  close(): Promise<void>;
}

/** Starts a fake Aruba and an adapter on it; the sign-in answers with a token unless a test routes it otherwise. */
export async function createArubaRig(options: { deps?: Partial<ArubaDeps>; random?: () => number; noSignIn?: boolean } = {}): Promise<ArubaRig> {
  const fake = await startFakeAruba();
  if (options.noSignIn !== true) {
    fake.route('POST /auth/signin', tokenReply());
  }
  const clock = createClock();
  const log = createLogSink();
  const limiters = memoryLimiters(options.random);
  const account = testAccount();
  const accounts = new Map<string, Account>([[account.hub, account]]);
  const reads: Array<{ hub: string; fresh: boolean }> = [];
  const adapter = createArubaAdapter({
    environment: 'demo',
    registry: {
      get: async (hub, readOptions) => {
        reads.push({ hub, fresh: readOptions?.fresh === true });
        return accounts.get(hub);
      },
    },
    limiters,
    logger: log.logger,
    clock: clock.now,
    sleep: clock.sleep,
    hosts: fake.hosts,
    ...options.deps,
  });
  return { fake, adapter, clock, log, limiters, accounts, reads, account, close: () => fake.close() };
}

/** A signal that never fires. */
export const live = (): AbortSignal => new AbortController().signal;
