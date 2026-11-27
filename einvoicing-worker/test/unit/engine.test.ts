import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountRegistry } from '../../src/accounts/registry.ts';
import { createEngine, forgetHub } from '../../src/engine/engine.ts';
import type { EngineContext } from '../../src/engine/context.ts';
import { rotate } from '../../src/engine/context.ts';
import type { Limiters } from '../../src/limits/limiters.ts';
import type { ProviderAdapter } from '../../src/providers/types.ts';
import { createFakeAdapter, createLogSink, T0 } from '../helpers/world.ts';

/** A context made of stubs that record what the preparation job does. */
function stubContext(options: { hubs?: string[]; adapters?: Map<string, ProviderAdapter>; refresh?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const log = createLogSink();
  let now = T0;
  const registry: AccountRegistry = {
    refresh: async () => {
      calls.push('refresh');
      await options.refresh?.();
    },
    get: async () => undefined,
    hubs: () => options.hubs ?? ['fake', 'fake__0123456789abcdef01234567', 'ghost'],
  };
  const limiters = {
    attach: async (epoch: number) => void calls.push(`attach:${epoch}`),
    sweep: () => void calls.push('sweep'),
  } as unknown as Limiters;
  const context: EngineContext = {
    queue: {} as never,
    history: {} as never,
    groups: {} as never,
    registry,
    limiters,
    adapters: options.adapters ?? new Map([['fake', createFakeAdapter()]]),
    logger: log.logger,
    clock: () => now,
    sleep: async () => undefined,
  };
  return { context, calls, log, advance: (ms: number) => void (now += ms) };
}

const run = async (job: { run(context: { epoch: number; signal: AbortSignal }): Promise<void> }, epoch = 1): Promise<void> => {
  await job.run({ epoch, signal: new AbortController().signal });
};

describe('rotate', () => {
  it('moves the starting point and copes with an empty list', () => {
    assert.deepEqual(rotate(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
    assert.deepEqual(rotate(['a', 'b', 'c'], 1), ['b', 'c', 'a']);
    assert.deepEqual(rotate(['a', 'b', 'c'], 5), ['c', 'a', 'b']);
    assert.deepEqual(rotate([], 7), []);
  });
});

describe('forgetHub', () => {
  it('tells the adapter of the provider of the hub, and ignores a provider without adapter', () => {
    const adapter = createFakeAdapter();
    forgetHub(new Map([['fake', adapter]]), 'fake__0123456789abcdef01234567');
    forgetHub(new Map([['fake', adapter]]), 'other');
    assert.deepEqual(adapter.forgotten, ['fake__0123456789abcdef01234567']);
  });
});

describe('the preparation job', () => {
  const settings = (stub: ReturnType<typeof stubContext>, hubs: string[], extra: Partial<Parameters<typeof createEngine>[0]> = {}) => {
    let indexed = 0;
    const engine = createEngine({ context: stub.context, hubs, budgetMs: 30_000, accountsRefreshMs: 120_000, ensureIndexes: async () => void (indexed += 1), ...extra });
    return { engine, indexed: () => indexed };
  };

  it('with no hub it touches nothing and says so once', async () => {
    const stub = stubContext();
    const { engine, indexed } = settings(stub, []);
    const [prepare] = engine.jobs;
    await run(prepare as never);
    await run(prepare as never);
    assert.deepEqual(stub.calls, []);
    assert.equal(indexed(), 0);
    assert.deepEqual(stub.log.messages(), ['no hubs enabled (WORKER_HUBS is empty): the worker processes nothing']);
    assert.deepEqual(engine.jobs.map((job) => job.name), ['engine-prepare', 'upload', 'status']);
  });

  it('creates the indexes once, loads the limiters each round and refreshes the accounts only when due', async () => {
    const stub = stubContext();
    const { engine, indexed } = settings(stub, ['fake']);
    const [prepare] = engine.jobs;
    await run(prepare as never, 3);
    assert.deepEqual(stub.calls, ['attach:3', 'sweep', 'refresh']);
    stub.calls.length = 0;
    stub.advance(119_999);
    await run(prepare as never, 3);
    assert.deepEqual(stub.calls, ['attach:3', 'sweep']);
    stub.advance(1);
    await run(prepare as never, 4);
    assert.deepEqual(stub.calls, ['attach:3', 'sweep', 'attach:4', 'sweep', 'refresh']);
    assert.equal(indexed(), 1);
  });

  it('retries the indexes after a failure and does not run the round meanwhile', async () => {
    const stub = stubContext();
    let attempts = 0;
    const { engine } = settings(stub, ['fake'], {
      ensureIndexes: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('not allowed');
        }
      },
    });
    const [prepare] = engine.jobs;
    await assert.rejects(run(prepare as never), /not allowed/);
    assert.deepEqual(stub.calls, []);
    await run(prepare as never);
    assert.deepEqual(stub.calls, ['attach:1', 'sweep', 'refresh']);
  });

  it('a failed refresh stops the round with no active hub and is retried the next round', async () => {
    let fail = true;
    const stub = stubContext({ refresh: async () => { if (fail) { throw new Error('mongo down'); } } });
    const { engine } = settings(stub, ['fake']);
    const [prepare, upload] = engine.jobs;
    await assert.rejects(run(prepare as never), /mongo down/);
    await run(upload as never);
    assert.deepEqual(stub.calls.filter((call) => call === 'refresh'), ['refresh']);
    fail = false;
    await run(prepare as never);
    assert.deepEqual(stub.calls.filter((call) => call === 'refresh'), ['refresh', 'refresh']);
  });

  it('keeps only the usable hubs whose provider has an adapter, saying so once per provider', async () => {
    const stub = stubContext();
    const { engine } = settings(stub, ['fake', 'fake__0123456789abcdef01234567', 'ghost']);
    const [prepare] = engine.jobs;
    await run(prepare as never);
    await run(prepare as never);
    assert.deepEqual(stub.log.messages('warn'), ['no adapter for the provider: its hubs are skipped']);
    assert.equal(stub.log.entries().find((entry) => entry['level'] === 'warn')?.['provider'], 'ghost');
  });
});
