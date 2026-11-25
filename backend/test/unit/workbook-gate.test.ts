import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createWorkbookRoutes } from '../../src/modules/catalog-xlsx/catalog-xlsx.routes.ts';

describe('the gates of the XLSX imports', () => {
  it('lets a group hold one place of the process for all its imports, whatever the workbook, and the other groups go on', async () => {
    const controller = { template: () => undefined, export: () => undefined, import: () => undefined };
    const options = { exportSegment: 'e', importSegment: 'i', bucket: 'b', read: 'contacts:export', write: 'contacts:import' } as const;
    const parked: Array<() => void> = [];
    const app = express();
    for (const name of ['catalog', 'contacts', 'cards']) {
      const upload = createWorkbookRoutes({ ...options, importSegment: name }, controller, {} as never).find((route) => route.method === 'POST')!.multipart!;
      app.post(
        `/${name}`,
        (req, res, next) => {
          res.locals['groupAccess'] = { groupId: new ObjectId(req.get('x-group')!) } as never;
          next();
        },
        upload,
        (_req, res) => void parked.push(() => res.status(204).end()),
      );
    }
    app.use((error: { status?: number }, _req: unknown, res: { status(code: number): { json(body: unknown): void } }, _next: unknown) => res.status(error.status ?? 500).json({}));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const send = (name: string, group: ObjectId) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(Buffer.from('PK\u0003\u0004zz'))]), 'a.xlsx');
      return fetch(`http://127.0.0.1:${String(port)}/${name}`, { method: 'POST', headers: { 'x-group': group.toHexString(), 'idempotency-key': randomUUID() }, body: form });
    };
    const wait = async (count: number) => {
      for (let attempt = 0; attempt < 300 && parked.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      const group = new ObjectId();
      const three = ['catalog', 'contacts', 'cards'].map((name) => send(name, group));
      await wait(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(parked.length, 1, 'the three imports of the group hold one place of the process');
      const other = send('contacts', new ObjectId());
      await wait(2);
      assert.equal(parked.length, 2, 'another group is not held up');
      for (let attempt = 0; attempt < 300 && parked.length < 4; attempt += 1) {
        parked.splice(0).forEach((finish) => finish());
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual((await Promise.all([...three, other])).map((response) => response.status), [204, 204, 204, 204]);
    } finally {
      parked.splice(0).forEach((finish) => finish());
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});
