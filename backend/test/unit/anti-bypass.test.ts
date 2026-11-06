import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Every `.ts` file under a directory, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []),
    ),
  );
  return nested.flat();
}

describe('database access cannot be bypassed outside src/db', () => {
  const forbidden = ['.db(', 'new Db(', "['db']", '["db"]', '.admin(', '.client.', '$out', '$merge', 'renameCollection'];
  const mayCreateDatabases = (file: string): boolean => {
    const path = relative(SRC, file).split('\\').join('/');
    return path === 'server.ts' || /^tools\/[^/]+\/main\.ts$/.test(path);
  };

  it('uses no raw database selector, admin handle, client back-reference or pipeline output outside src/db', async () => {
    const files = (await filesUnder(SRC)).filter((file) => !relative(SRC, file).startsWith(`db${'/'}`));
    assert.ok(files.length > 10);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const word of forbidden) {
        assert.ok(!text.includes(word), `${relative(SRC, file)} contains "${word}"`);
      }
    }
  });

  it('calls createDatabases only from the server and from tool entry points', async () => {
    const callers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file);
      if (path.startsWith(`db${'/'}`)) {
        continue;
      }
      if ((await readFile(file, 'utf8')).includes('createDatabases(')) {
        callers.push(path);
        assert.ok(mayCreateDatabases(file), `${path} must not call createDatabases`);
      }
    }
    assert.deepEqual(callers.sort(), ['server.ts', 'tools/migrate-dealers/main.ts', 'tools/profile-legacy/main.ts']);
  });

  it('creates the cluster clients only from the server and from tool entry points', async () => {
    const callers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path.startsWith('db/')) {
        continue;
      }
      const text = await readFile(file, 'utf8');
      if (text.includes('createClusterClients') || text.includes('createMongoClient') || text.includes('new MongoClient(')) {
        callers.push(path);
        assert.ok(mayCreateDatabases(file), `${path} must not create database clients`);
      }
    }
    assert.deepEqual(callers.sort(), ['server.ts', 'tools/migrate-dealers/main.ts', 'tools/profile-legacy/main.ts']);
  });

  it('keeps the analytics handles unused outside src/db until a report needs them', async () => {
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (!path.startsWith('db/')) {
        const text = await readFile(file, 'utf8');
        assert.ok(!text.includes('analyticsGroup(') && !text.includes('analyticsCommon('), `${path} must not use the analytics handles yet`);
      }
    }
  });

  it('issues group accesses only inside group-access.ts', async () => {
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path !== 'shared/security/scope/group-access.ts') {
        const text = await readFile(file, 'utf8');
        assert.ok(!text.includes('resolveGroupAccess(') && !text.includes('issueGroupAccess('), `${path} must not issue group accesses`);
      }
    }
    const own = await readFile(join(SRC, 'shared/security/scope/group-access.ts'), 'utf8');
    assert.ok(own.includes('issueGroupAccess(') && !own.includes('export function issueGroupAccess') && !own.includes('export function resolveGroupAccess'));
  });

  it('opens a group database only from the verified group access, the stored-user company lookup and the tools (always with an explicit cluster)', async () => {
    const allowed = new Set(['shared/security/scope/group-access.ts', 'shared/security/scope/company-places.repository.ts']);
    const callers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path.startsWith('db/')) {
        continue;
      }
      if (/\.group\(/.test(await readFile(file, 'utf8'))) {
        callers.push(path);
        assert.ok(allowed.has(path) || path.startsWith('tools/'), `${path} must not open a group database`);
      }
    }
    assert.ok(callers.includes('shared/security/scope/group-access.ts') && callers.includes('shared/security/scope/company-places.repository.ts'));
  });

  it('recognizes the allowed entry points', () => {
    assert.equal(mayCreateDatabases(join(SRC, 'server.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'main.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'other.ts')), false);
    assert.equal(mayCreateDatabases(join(SRC, 'app.ts')), false);
  });
});
