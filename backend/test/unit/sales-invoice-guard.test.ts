import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { createInvoiceGuard } from '../../src/modules/sales/sales.invoice.guard.ts';
import type { StorePrincipal } from '../../src/shared/security/scope/principal.ts';

/** The budget and the daily alert of the invoices of a store key (step VS5). */
const store = { keyId: new ObjectId(), groupId: new ObjectId() } as unknown as StorePrincipal;
const client = { requestId: 'req-1', ip: '10.0.0.1', userAgent: null };

describe('the guard of the invoices of a store key', () => {
  it('lets a key make its budget of invoices in a minute and answers 429 with Retry-After above it, key by key', async () => {
    const limiter = memoryRateLimiter();
    const guard = createInvoiceGuard({ rateLimiter: limiter, activityLog: memoryActivityLog(), logger: memoryLogger().logger, limits: { perMinute: 2, perDay: 10 } });
    await guard.admit(store);
    await guard.admit(store);
    await assert.rejects(() => guard.admit(store), (error: { code: string; headers?: Record<string, string> }) => error.code === 'RATE_LIMITED' && error.headers?.['Retry-After'] !== undefined);
    await guard.admit({ keyId: new ObjectId() } as unknown as StorePrincipal);
    assert.ok(limiter.calls.every((call) => call.bucket === 'storeInvoices:key'));
  });

  it('writes the alert once, when the invoices of the day go over the threshold, with nothing but the threshold', async () => {
    const activity = memoryActivityLog();
    const guard = createInvoiceGuard({ rateLimiter: memoryRateLimiter(), activityLog: activity, logger: memoryLogger().logger, limits: { perMinute: 5, perDay: 2 } });
    for (let count = 0; count < 5; count += 1) {
      await guard.created(store, client);
    }
    assert.equal(activity.entries.length, 1);
    const [entry] = activity.entries;
    assert.deepEqual([entry!.action, entry!.category, entry!.actor, entry!.groupId, entry!.resource, entry!.metadata, entry!.ip], ['store.invoiceAlert', 'security', { kind: 'store', id: store.keyId }, store.groupId, { type: 'storeKey', id: store.keyId.toHexString() }, { threshold: 2 }, '10.0.0.1']);
    // Without an address, none is written.
    const quiet = memoryActivityLog();
    const other = createInvoiceGuard({ rateLimiter: memoryRateLimiter(), activityLog: quiet, logger: memoryLogger().logger, limits: { perMinute: 5, perDay: 1 } });
    await other.created(store, { ...client, ip: null });
    await other.created(store, { ...client, ip: null });
    assert.equal('ip' in quiet.entries[0]!, false);
  });

  it('never rejects when the counter or the log fails: it logs and the invoice stays created', async () => {
    const logs = memoryLogger();
    const broken = createInvoiceGuard({ rateLimiter: { consume: () => Promise.reject(new Error('counter down')) }, activityLog: memoryActivityLog(), logger: logs.logger, limits: { perMinute: 1, perDay: 1 } });
    await broken.created(store, client);
    const silent = createInvoiceGuard({ rateLimiter: memoryRateLimiter(), activityLog: { record: () => Promise.reject(new Error('log down')) }, logger: logs.logger, limits: { perMinute: 1, perDay: 1 } });
    await silent.created(store, client);
    await silent.created(store, client);
    assert.equal(logs.lines.filter((line) => /signal of the invoices of a store failed/.test(line)).length, 2);
    await assert.rejects(() => broken.admit(store), /counter down/);
  });
});
