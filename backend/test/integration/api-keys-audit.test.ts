import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { createActivityLog } from '../../src/shared/activity-log/activity-log.ts';
import { auditApiKey } from '../../src/modules/api-keys/api-keys.audit.ts';
import { quietLogger } from '../helpers/indexes.ts';
import { memoryLogger } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
});
after(() => ctx.cleanup());

describe('the events of the public API keys, through the real activity log', () => {
  it('keeps the name and the six characters after fc_pk_ of the key, which the log would redact if it started like a key, and never the key', async () => {
    const logs = memoryLogger();
    const log = createActivityLog({ databases: ctx.databases, logger: logs.logger, retentionDays: 365, errorRetentionDays: 90 });
    const key = { id: new ObjectId(), groupId: new ObjectId(), name: 'Webshop', prefix: 'fc_pk_AbCdEf' };
    const actor = { kind: 'user', id: new ObjectId(), role: 'D' } as const;
    const client = { requestId: 'req-12345678', ip: '203.0.113.7', userAgent: null };
    await auditApiKey(log, { action: 'apiKey.created', key, actor, client });
    await auditApiKey(log, { action: 'apiKey.updated', key, actor, client, fields: ['name', 'permissions'] });
    await auditApiKey(log, { action: 'apiKey.revoked', key, actor, client });
    const stored = await ctx.databases.common().collection('activityEvents').find({ 'resource.id': key.id.toHexString() }).sort({ _id: 1 }).toArray();
    assert.deepEqual(stored.map((event) => [event['action'], event['metadata']]), [
      ['apiKey.created', { name: 'Webshop', keyHint: 'AbCdEf' }],
      ['apiKey.updated', { name: 'Webshop', keyHint: 'AbCdEf', fields: 'name,permissions' }],
      ['apiKey.revoked', { name: 'Webshop', keyHint: 'AbCdEf' }],
    ]);
    assert.deepEqual(logs.events, [], 'nothing was refused by the log');
    assert.ok(!JSON.stringify(stored).includes('REDACTED'));
  });

  it('records the excess of a limit with the key as the actor', async () => {
    const logs = memoryLogger();
    const log = createActivityLog({ databases: ctx.databases, logger: logs.logger, retentionDays: 365, errorRetentionDays: 90 });
    const id = new ObjectId();
    await log.record({ category: 'security', action: 'rateLimit.exceeded', outcome: 'denied', actor: { kind: 'apiKey', id }, resource: { type: 'apiKey', id: id.toHexString() }, metadata: { bucket: 'public:group' } });
    const stored = (await ctx.databases.common().collection('activityEvents').findOne({ 'actor.id': id }))!;
    assert.deepEqual([stored['actor'], stored['metadata'], logs.events], [{ kind: 'apiKey', id }, { bucket: 'public:group' }, []]);
    await log.record({ category: 'security', action: 'rateLimit.exceeded', outcome: 'denied', actor: { kind: 'apiKey' } });
    assert.equal(logs.events.length, 1, 'an apiKey actor without an id is refused');
  });
});
