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
    assert.deepEqual(callers.sort(), ['server.ts', 'tools/migrate-dealers/main.ts', 'tools/profile-legacy/main.ts', 'tools/sync-copies/main.ts']);
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
    assert.deepEqual(callers.sort(), ['server.ts', 'tools/migrate-dealers/main.ts', 'tools/profile-legacy/main.ts', 'tools/sync-copies/main.ts']);
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

  it('opens a group database only from the verified group access and the tools (always with an explicit cluster)', async () => {
    const callers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path.startsWith('db/')) {
        continue;
      }
      if (/\.group\(/.test(await readFile(file, 'utf8'))) {
        callers.push(path);
        assert.ok(path === 'shared/security/scope/group-access.ts' || path.startsWith('tools/'), `${path} must not open a group database`);
      }
    }
    assert.ok(callers.includes('shared/security/scope/group-access.ts'));
  });

  describe('companies and places', () => {
    const MIRROR = 'shared/security/scope/group-mirror.ts';
    // The write service of companies and places (doc/Tasks.md 5.6): the only other file that names the collections, the originals and their copies together.
    const WRITER = 'shared/legacy-write/companies-places.writer.ts';
    const posix = (file: string): string => relative(SRC, file).split('\\').join('/');

    it('reads the copies in common.companies and common.places only through group-mirror.ts', async () => {
      let seen = false;
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path.startsWith('db/') || path.startsWith('tools/') || path === WRITER) {
          // The tools read the originals in the group databases; only sync-copies may touch the copies (checked below); the writer is checked in its own test.
          continue;
        }
        const names = [...(await readFile(file, 'utf8')).matchAll(/\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/g)].map((match) => match[0]);
        if (path === MIRROR) {
          seen = names.length > 0;
        } else {
          assert.deepEqual(names, [], `${path} reads companies or places directly`);
        }
      }
      assert.ok(seen, 'group-mirror.ts is expected to be the single place');
    });

    it('has no file outside group-mirror.ts, src/db and tools/sync-copies that names the common database and a copy collection', async () => {
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path === MIRROR || path === WRITER || path.startsWith('db/') || path.startsWith('tools/sync-copies/')) {
          continue;
        }
        const text = await readFile(file, 'utf8');
        const literal = /\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/.test(text);
        assert.ok(!(text.includes('common()') && literal), `${path} touches the copies through the common database`);
      }
    });

    it('never reads companies or places from a group database outside the tools', async () => {
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path.startsWith('tools/') || path.startsWith('db/')) {
          continue;
        }
        const text = await readFile(file, 'utf8');
        assert.ok(!/groupDatabaseFor\([^;]*\)\s*\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/.test(text), `${path} reads companies or places from a group database`);
        assert.ok(!/\.group\([^;]*\)\s*\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/.test(text), `${path} reads companies or places from a group database`);
      }
    });

    it('exposes from group-mirror.ts only the two per-group openers and the fixed count of the page groups', async () => {
      const text = await readFile(join(SRC, MIRROR), 'utf8');
      const exported = [...text.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]);
      assert.deepEqual(exported, ['groupMirror', 'trustedGroupMirror', 'countMirrorByGroups']);
      // The count builds its own pipeline from the fixed builder: no caller-supplied stage, and no other multi-group read.
      assert.equal([...text.matchAll(/countByGroupPipeline\(/g)].length, 1);
      assert.equal([...text.matchAll(/\.aggregate\(/g)].length, 2);
    });

    it('lets only the write service write companies and places, in a transaction, from a verified group access', async () => {
      const writers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path === WRITER) {
          const text = await readFile(file, 'utf8');
          writers.push(path);
          assert.ok(text.includes('groupDatabaseFor(principal, access, databases)'), 'the writer opens the group database from the verified access');
          assert.ok(text.includes('databases.transaction('), 'the writer runs in a transaction');
          assert.ok(!/\.group\(/.test(text) && !text.includes('analytics'), 'the writer neither opens a group database by itself nor uses the analytics connection');
        }
      }
      assert.deepEqual(writers, [WRITER]);
    });

    it('keeps the copies away from the analytics connection', async () => {
      const text = await readFile(join(SRC, MIRROR), 'utf8');
      assert.ok(!/analytics/i.test(text));
      assert.ok(text.includes('databases.common()'));
    });
  });

  it('recognizes the allowed entry points', () => {
    assert.equal(mayCreateDatabases(join(SRC, 'server.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'main.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'other.ts')), false);
    assert.equal(mayCreateDatabases(join(SRC, 'app.ts')), false);
  });
});
