import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionRegistry } from '../../src/db/collections.ts';
import type { Databases } from '../../src/db/databases.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';

const registry: CollectionRegistry = {
  common: { things: { ownership: 'new', validator: { bsonType: 'object' } } },
  group: {},
};

function fake(options: { exists: boolean; createError?: unknown; commandError?: unknown }) {
  const calls: string[] = [];
  const db = {
    listCollections: () => ({ toArray: async () => (options.exists ? [{ name: 'things' }] : []) }),
    createCollection: async () => {
      calls.push('create');
      if (options.createError !== undefined) {
        throw options.createError;
      }
    },
    command: async (command: Record<string, unknown>) => {
      calls.push(`collMod:${String(command['collMod'])}:${String(command['validationAction'])}`);
    },
    collection: () => ({ createIndexes: async () => undefined }),
  };
  return { databases: { common: () => db } as unknown as Databases, calls };
}

describe('validators in ensureIndexes', () => {
  it('creates a missing collection with the validator', async () => {
    const { databases, calls } = fake({ exists: false });
    await ensureIndexes(databases, registry);
    assert.deepEqual(calls, ['create']);
  });

  it('updates the validator of an existing collection', async () => {
    const { databases, calls } = fake({ exists: true });
    await ensureIndexes(databases, registry);
    assert.deepEqual(calls, ['collMod:things:error']);
  });

  it('falls back to the update when another instance creates the collection first, and rethrows other errors', async () => {
    const race = fake({ exists: false, createError: Object.assign(new Error('exists'), { code: 48 }) });
    await ensureIndexes(race.databases, registry);
    assert.deepEqual(race.calls, ['create', 'collMod:things:error']);
    const broken = fake({ exists: false, createError: Object.assign(new Error('denied'), { code: 13 }) });
    await assert.rejects(ensureIndexes(broken.databases, registry), /denied/);
    assert.deepEqual(broken.calls, ['create']);
  });

  it('refuses validators on group collections and on legacy collections', async () => {
    const group: CollectionRegistry = { common: {}, group: { things: { ownership: 'new', validator: { bsonType: 'object' } } } };
    await assert.rejects(ensureIndexes(fake({ exists: true }).databases, group), /group\.things: validators on group databases are not supported yet/);
    const legacy: CollectionRegistry = { common: { users: { ownership: 'legacy-read', validator: { bsonType: 'object' } } }, group: {} };
    await assert.rejects(ensureIndexes(fake({ exists: true }).databases, legacy), /a validator is allowed only on new collections/);
  });
});
