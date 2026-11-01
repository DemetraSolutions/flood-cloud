import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../helpers/app.ts';
import { mongoEnv } from '../helpers/mongo.ts';

const SERVER = fileURLToPath(new URL('../../src/server.ts', import.meta.url));

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `node src/server.ts` as a real process in an empty directory (so no `.env`
 * is found). `NODE_V8_COVERAGE` is inherited so the child counts towards coverage.
 */
function spawnServer(env: Record<string, string | undefined>, onStdout?: (text: string, child: ReturnType<typeof spawn>) => void, dotEnv?: string) {
  return mkdtemp(join(tmpdir(), 'flood-server-')).then(
    async (cwd) => {
      if (dotEnv !== undefined) {
        await writeFile(join(cwd, '.env'), dotEnv);
      }
      return new Promise<Outcome>((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER], {
          cwd,
          env: { ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}), ...env } as NodeJS.ProcessEnv,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          onStdout?.(stdout, child);
        });
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
          rm(cwd, { recursive: true, force: true }).then(() => resolve({ code, stdout, stderr }), reject);
        });
      });
    },
  );
}

describe('node src/server.ts', () => {
  it('starts, serves health and exits 0 on SIGTERM', async () => {
    const port = await freePort();
    let probed = false;
    const outcome = await spawnServer(
      mongoEnv({ PORT: String(port), SHUTDOWN_DRAIN_MS: '0' }) as Record<string, string>,
      (stdout, child) => {
        if (!probed && stdout.includes('server started')) {
          probed = true;
          fetch(`http://127.0.0.1:${port}/health/ready`)
            .then(async (res) => {
              assert.equal(res.status, 200);
              await res.arrayBuffer();
            })
            .then(
              () => child.kill('SIGTERM'),
              () => child.kill('SIGKILL'),
            );
        }
      },
    );
    assert.equal(probed, true);
    assert.equal(outcome.code, 0);
    assert.match(outcome.stdout, /shutdown completed/);
  });

  it('exits 1 with the list of problems when the configuration is invalid', async () => {
    const outcome = await spawnServer({ APP_ENV: 'nope', LEGACY_PASSWORD_PEPPER: 'child-secret-value' });
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /APP_ENV/);
    assert.match(outcome.stderr, /MONGODB_URI/);
    assert.ok(!outcome.stderr.includes('child-secret-value'));
  });

  it('refuses to start in production when a .env file exists in the working directory', async () => {
    const dotEnv = Object.entries(mongoEnv({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true&directConnection=true' }))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const outcome = await spawnServer({}, undefined, dotEnv);
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /\.env file exists/);
  });
});
