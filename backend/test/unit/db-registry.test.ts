import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { COLLECTIONS, registeredCollectionNames, validateRegistry } from '../../src/db/collections.ts';
import type { CollectionRegistry } from '../../src/db/collections.ts';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

async function sourceFiles(dir: string = SRC): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []),
    ),
  );
  return nested.flat();
}

describe('collection registry', () => {
  it('registers the shared legacy collections as read-only', () => {
    assert.deepEqual(Object.keys(COLLECTIONS.common).sort(), ['countries', 'groups', 'users']);
    assert.deepEqual(Object.keys(COLLECTIONS.group).sort(), ['companies', 'places']);
    for (const spec of [...Object.values(COLLECTIONS.common), ...Object.values(COLLECTIONS.group)]) {
      assert.equal(spec.ownership, 'legacy-read');
    }
    assert.doesNotThrow(() => validateRegistry());
    assert.deepEqual([...registeredCollectionNames()].sort(), ['companies', 'countries', 'groups', 'places', 'users']);
  });

  it('accepts valid new, legacy-read and legacy-write entries', () => {
    const registry: CollectionRegistry = {
      common: {
        sessions: {
          ownership: 'new',
          indexes: [
            { name: 'token_unique', key: { tokenHash: 1 }, unique: true },
            { name: 'ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
          ],
        },
        users: { ownership: 'legacy-write', ownedFields: ['lastLoginAt'], indexes: [{ name: 'userName_1', key: { userName: 1 } }] },
      },
      group: { places: { ownership: 'legacy-read' } },
    };
    assert.doesNotThrow(() => validateRegistry(registry));
  });

  it('rejects violations of the coexistence rules, listing all of them', () => {
    const bad: CollectionRegistry = {
      common: {
        a: { ownership: 'legacy-write' },
        b: { ownership: 'legacy-write', ownedFields: [] },
        c: { ownership: 'new', ownedFields: ['x'] },
        d: { ownership: 'legacy-read', ownedFields: ['x'] },
        e: { ownership: 'legacy-read', indexes: [{ name: 'u', key: { x: 1 }, unique: true }] },
        f: { ownership: 'legacy-write', ownedFields: ['x'], indexes: [{ name: 't', key: { x: 1 }, expireAfterSeconds: 10 }] },
        g: { ownership: 'new', indexes: [{ name: ' ', key: { x: 1 } }] },
      },
      group: {},
    };
    assert.throws(() => validateRegistry(bad), (error: Error) => {
      for (const where of ['common.a', 'common.b', 'common.c', 'common.d', 'common.e', 'common.f', 'common.g']) {
        assert.ok(error.message.includes(where), where);
      }
      return true;
    });
  });

  it('every collection used in src is registered, by literal name', async () => {
    const known = registeredCollectionNames();
    // indexes.ts walks the registry itself, so its name is not a literal by construction.
    const dynamicAllowed = new Set([join(SRC, 'db', 'indexes.ts')]);
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      const all = [...text.matchAll(/\.collection\(/g)].length;
      const literal = [...text.matchAll(/\.collection\(\s*(['"`])([^'"`$]*)\1\s*[,)]/g)];
      for (const match of literal) {
        assert.ok(known.has(match[2] as string), `${file}: collection "${match[2]}" is not in the registry`);
      }
      if (!dynamicAllowed.has(file)) {
        assert.equal(literal.length, all, `${file}: collection names must be string literals`);
      }
    }
  });

  it('no module outside src/db/databases.ts selects a database directly', async () => {
    const allowed = join(SRC, 'db', 'databases.ts');
    let seen = false;
    for (const file of await sourceFiles()) {
      const uses = /\.db\(/.test(await readFile(file, 'utf8'));
      if (file === allowed) {
        seen = uses;
      } else {
        assert.equal(uses, false, `${file} must obtain databases only from createDatabases`);
      }
    }
    assert.equal(seen, true, 'databases.ts is expected to be the single place');
  });
});
