import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { compressionMiddleware, COMPRESSION_THRESHOLD_BYTES } from '../../src/shared/http/compression.ts';

describe('compressionMiddleware', () => {
  let server: Server;
  let port: number;

  before(async () => {
    const app = express();
    app.use(compressionMiddleware());
    app.get('/big', (_req, res) => void res.type('text/plain').send('a'.repeat(COMPRESSION_THRESHOLD_BYTES + 1)));
    app.get('/small', (_req, res) => void res.type('text/plain').send('a'.repeat(COMPRESSION_THRESHOLD_BYTES - 1)));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function get(path: string): Promise<{ encoding: string | undefined; body: Buffer }> {
    return new Promise((resolve, reject) => {
      request({ port, path, headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
      })
        .on('error', reject)
        .end();
    });
  }

  it('compresses responses at or above the threshold', async () => {
    const { encoding, body } = await get('/big');
    assert.equal(encoding, 'gzip');
    assert.equal(gunzipSync(body).length, COMPRESSION_THRESHOLD_BYTES + 1);
  });

  it('leaves small responses alone', async () => {
    const { encoding, body } = await get('/small');
    assert.equal(encoding, undefined);
    assert.equal(body.length, COMPRESSION_THRESHOLD_BYTES - 1);
  });
});
