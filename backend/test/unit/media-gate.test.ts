import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RequestHandler } from 'express';
import { MAX_RUNNING_UPLOADS, MAX_WAITING_UPLOADS, createGate } from '../../src/modules/media/gate.ts';
import { imageUpload } from '../../src/modules/media/upload.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { errorHandler } from '../../src/shared/http/error-handler.ts';
import { memoryLogger } from '../helpers/app.ts';
import { recordingErrorReporter } from '../helpers/activity.ts';
import { image } from '../helpers/images.ts';

const full = (error: unknown): boolean => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE' && error.headers['Retry-After'] === '5';

describe('upload gate', () => {
  it('lets the given number in, queues the next ones in order and refuses beyond the queue with a Retry-After', async () => {
    assert.deepEqual([MAX_RUNNING_UPLOADS, MAX_WAITING_UPLOADS], [2, 6]);
    const gate = createGate(1, 1);
    const first = await gate.enter();
    const order: string[] = [];
    const second = gate.enter().then((release) => (order.push('second'), release));
    await assert.rejects(() => gate.enter(), full);
    order.push('first released');
    first();
    first();
    const release = await second;
    assert.deepEqual(order, ['first released', 'second']);
    release();
    // Calling a release twice never frees a slot that is not its own: the gate is empty again, one in, one waiting.
    const again = await gate.enter();
    const waiting = gate.enter();
    await assert.rejects(() => gate.enter(), full);
    again();
    (await waiting)();
  });

  it('with no queue refuses everything beyond the slots', async () => {
    const gate = createGate(1, 0);
    const release = await gate.enter();
    await assert.rejects(() => gate.enter(), full);
    release();
    (await gate.enter())();
  });
});

describe('image upload handler and the gate', () => {
  async function serve(gate: ReturnType<typeof createGate>, handler: RequestHandler): Promise<{ url: string; close: () => Promise<void> }> {
    const app = express();
    app.post('/up', imageUpload(() => true, gate), handler);
    app.use(errorHandler(memoryLogger().logger, recordingErrorReporter().reporter));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${String(port)}/up`, close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
  }

  const form = async (): Promise<FormData> => {
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(await image('png'))], { type: 'image/png' }), 'a.png');
    return body;
  };

  it('answers 503 with Retry-After when the queue is full, and gives the slot back when the response is over', async () => {
    const gate = createGate(1, 0);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { url, close } = await serve(gate, async (_req, res) => {
      await held;
      res.status(204).end();
    });
    try {
      const slow = fetch(url, { method: 'POST', body: await form() });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const refused = await fetch(url, { method: 'POST', body: await form() });
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get('retry-after'), '5');
      release();
      assert.equal((await slow).status, 204);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await fetch(url, { method: 'POST', body: await form() })).status, 204, 'the slot was given back');
    } finally {
      release();
      await close();
    }
  });

  it('gives the slot back at once, and reads nothing, when the response closed while the request waited (a timeout of the server)', async () => {
    const gate = createGate(1, 1);
    const handler = imageUpload(() => true, gate);
    let nexted = false;
    const req = { is: () => 'multipart/form-data' } as never;
    await handler(req, { closed: true, once: () => assert.fail('no listener for a response that is over') } as never, () => void (nexted = true));
    assert.equal(nexted, false);
    // The slot is free again: a new request enters at once (the queue is not needed).
    (await gate.enter())();
    const probe = await gate.enter();
    const queued = gate.enter();
    await assert.rejects(() => gate.enter(), full);
    probe();
    (await queued)();
  });

  it('gives the slot back when a request fails or the client goes away while it waits', async () => {
    const gate = createGate(1, 1);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { url, close } = await serve(gate, async (_req, res) => {
      await held;
      res.status(204).end();
    });
    try {
      // A malformed body fails inside the handler: 400, and the slot is free again.
      const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: 'nope' });
      assert.equal(bad.status, 400);
      const slow = fetch(url, { method: 'POST', body: await form() });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const controller = new AbortController();
      const waiting = fetch(url, { method: 'POST', body: await form(), signal: controller.signal }).catch(() => 'aborted');
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      assert.equal(await waiting, 'aborted');
      release();
      assert.equal((await slow).status, 204);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The aborted request took the slot and gave it back: a new one passes at once.
      assert.equal((await fetch(url, { method: 'POST', body: await form() })).status, 204);
    } finally {
      release();
      await close();
    }
  });
});
