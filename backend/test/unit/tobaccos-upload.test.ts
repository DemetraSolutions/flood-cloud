import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGate } from '../../src/modules/media/gate.ts';
import { acceptWorkbook, workbookUpload } from '../../src/modules/tobaccos/tobaccos.upload.ts';

const KEY = '3f2b8a52-6c1d-4b53-9d7e-0a1b2c3d4e5f'; // gitleaks:allow (fake test value)

describe('workbookUpload', () => {
  it('asks for the idempotency key before it reads a byte, and for multipart', async () => {
    const handler = workbookUpload(createGate(1, 1));
    await assert.rejects(async () => handler({ get: () => undefined } as never, {} as never, () => undefined), { code: 'VALIDATION_ERROR', details: [{ field: 'Idempotency-Key', issue: 'required' }] });
    await assert.rejects(async () => handler({ get: () => 'nope' } as never, {} as never, () => undefined), { code: 'VALIDATION_ERROR', details: [{ field: 'Idempotency-Key', issue: 'format' }] });
    await assert.rejects(async () => handler({ get: () => KEY, is: () => false } as never, {} as never, () => undefined), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('gives the slot back at once, and reads nothing, when the response closed while the request waited', async () => {
    const gate = createGate(1, 0);
    const handler = workbookUpload(gate);
    let nexted = false;
    await handler({ get: () => KEY, is: () => 'multipart/form-data' } as never, { closed: true, once: () => assert.fail('no listener for a response that is over') } as never, () => void (nexted = true));
    assert.equal(nexted, false);
    // The slot is free again: a new request enters at once, and the queue is not needed.
    (await gate.enter())();
  });
});

describe('acceptWorkbook', () => {
  const run = (file: unknown) => {
    const req = { file } as { file: unknown; body?: unknown };
    let nexted = false;
    acceptWorkbook()(req as never, {} as never, () => void (nexted = true));
    return { req, nexted };
  };

  it('refuses a request without a file, and a file that is not a ZIP archive by its first bytes', () => {
    assert.throws(() => run(undefined), { code: 'VALIDATION_ERROR', details: [{ field: 'file', issue: 'required' }] });
    assert.throws(() => run({ buffer: Buffer.from('PK') }), { code: 'UNSUPPORTED_MEDIA_TYPE' });
    assert.throws(() => run({ buffer: Buffer.from('%PDF-1.7 whatever') }), { code: 'UNSUPPORTED_MEDIA_TYPE' });
    assert.throws(() => run({ buffer: Buffer.from('PK\x05\x06 an empty archive') }), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('lets a ZIP archive through, with the hash of the file as the body the idempotency fingerprints', () => {
    const buffer = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('rest of the archive')]);
    const { req, nexted } = run({ buffer });
    assert.equal(nexted, true);
    assert.deepEqual(req.body, { sha256: createHash('sha256').update(buffer).digest('hex') });
  });
});
