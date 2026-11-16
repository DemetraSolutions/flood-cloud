import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createEmailTemplatesService } from '../../src/modules/email-templates/email-templates.service.ts';
import type { EmailTemplatesRepository } from '../../src/modules/email-templates/email-templates.repository.ts';
import { toSummary, toTemplate, versionOf } from '../../src/modules/email-templates/email-templates.mapper.ts';
import { memoryActivityLog } from '../helpers/activity.ts';

const KEY = Buffer.alloc(32, 7);
const principal = { userId: new ObjectId(), role: 'SA' } as never;
const access = { groupId: new ObjectId() } as never;
const client = { requestId: 'r', ip: null, userAgent: null };
const id = new ObjectId();
const stored = (extra: Document = {}): Document => ({ _id: id, name: 'N', text: 't', html: 'h', insertDate: new Date(1000), updateDate: new Date(2000), ...extra });

function build(overrides: Partial<EmailTemplatesRepository>, now = 5000) {
  const activity = memoryActivityLog();
  const repository: EmailTemplatesRepository = {
    list: () => Promise.reject(new Error('unused')),
    findById: () => Promise.resolve(stored()),
    insert: () => Promise.resolve(),
    update: () => Promise.resolve('updated'),
    remove: () => Promise.resolve(true),
    placesUsing: () => Promise.resolve([]),
    ...overrides,
  };
  return { service: createEmailTemplatesService({ repository, activityLog: activity, versionKey: KEY, now: () => now, newId: () => id }), activity };
}

describe('e-mail templates service', () => {
  it('answers 409 when the template changed between the read and the write, and records nothing', async () => {
    const { service, activity } = build({ update: () => Promise.resolve('conflict') });
    await assert.rejects(() => service.update(principal, access, id, versionOf(stored(), KEY), { name: 'Nuovo' }, client), { code: 'CONFLICT' });
    assert.equal(activity.entries.length, 0);
  });

  it('dates a change strictly after the date it read, even with a clock that is behind', async () => {
    let written: Date | null = null;
    const { service } = build({ update: (_p, _a, _i, change) => ((written = change.updateDate), Promise.resolve('updated')) }, 1000);
    const result = await service.update(principal, access, id, versionOf(stored(), KEY), { text: 'altro' }, client);
    assert.equal((written as Date | null)?.getTime(), 2001);
    assert.equal(result.template.updatedAt, new Date(2001).toISOString());
  });

  it('answers 404 when the template disappears between the check and the deletion', async () => {
    const { service, activity } = build({ remove: () => Promise.resolve(false) });
    await assert.rejects(() => service.remove(principal, access, id, client), { code: 'NOT_FOUND' });
    assert.equal(activity.entries.length, 0);
  });

  it('reads the fields of the legacy whatever their type', () => {
    const odd = { _id: 'not an id', name: 5, text: null, html: 3, insertDate: 'x', updateDate: new Date('nope') };
    assert.deepEqual(toSummary(odd), { id: '', name: '', updatedAt: null });
    assert.deepEqual(toTemplate(odd), { id: '', name: '', updatedAt: null, text: '', html: '', createdAt: null });
    assert.equal(versionOf(odd, KEY).length, 43);
    assert.notEqual(versionOf(stored(), KEY), versionOf(stored({ html: 'x' }), KEY));
    assert.notEqual(versionOf(stored(), KEY), versionOf(stored(), Buffer.alloc(32, 8)));
  });
});
