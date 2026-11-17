import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/http/errors.ts';
import { issueOf, settleItem, trashedAtOf } from '../../src/shared/trash/trash.ts';

describe('trashedAtOf', () => {
  it('is the ISO string of a valid date and none for anything else', () => {
    assert.equal(trashedAtOf(new Date('2026-11-17T09:30:00.000Z')), '2026-11-17T09:30:00.000Z');
    for (const junk of [undefined, null, '2026-11-17', 5, new Date('nope'), {}]) {
      assert.equal(trashedAtOf(junk), null);
    }
  });
});

describe('issueOf', () => {
  it('maps the refusals of the single-item operations to the issue of a skipped item', () => {
    const conflict = (field: string, issue: string) => new AppError('CONFLICT', { details: [{ field, issue }] });
    assert.equal(issueOf(new AppError('NOT_FOUND')), 'notFound');
    assert.equal(issueOf(new AppError('FORBIDDEN')), 'forbidden');
    assert.equal(issueOf(new AppError('PRECONDITION_FAILED')), 'notTrashed');
    assert.equal(issueOf(new AppError('CONFLICT')), 'notTrashed');
    assert.equal(issueOf(conflict('places', 'referenced')), 'referenced');
    assert.equal(issueOf(conflict('groups', 'referenced')), 'referenced');
    assert.equal(issueOf(conflict('vatNumber', 'taken')), 'taken');
    // A conflict that is not a state of the trash is a fault of the data and is not hidden.
    assert.equal(issueOf(conflict('x', 'other')), null);
    assert.equal(issueOf(new AppError('CONFLICT', { message: 'The stored company has a block that cannot be written' })), null);
  });

  it('is none for anything that is not a refusal: a fault must not be hidden', () => {
    assert.equal(issueOf(new AppError('INTERNAL_ERROR')), null);
    assert.equal(issueOf(new AppError('VALIDATION_ERROR')), null);
    assert.equal(issueOf(new Error('boom')), null);
    assert.equal(issueOf('boom'), null);
  });
});

describe('settleItem', () => {
  it('is done when the operation succeeds, the issue when it is refused, and throws a fault', async () => {
    assert.deepEqual(await settleItem(async () => 1), { done: true });
    assert.deepEqual(await settleItem(() => Promise.reject(new AppError('NOT_FOUND'))), { done: false, issue: 'notFound' });
    const fault = new Error('boom');
    await assert.rejects(settleItem(() => Promise.reject(fault)), (error: unknown) => error === fault);
  });
});
