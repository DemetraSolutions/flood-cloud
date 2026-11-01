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
    assert.deepEqual(callers.sort(), ['server.ts', 'tools/profile-legacy/main.ts']);
  });

  it('recognizes the allowed entry points', () => {
    assert.equal(mayCreateDatabases(join(SRC, 'server.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'main.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'other.ts')), false);
    assert.equal(mayCreateDatabases(join(SRC, 'app.ts')), false);
  });
});
