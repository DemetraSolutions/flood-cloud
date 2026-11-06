import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionRegistry } from '../../src/db/collections.ts';
import type { Databases } from '../../src/db/databases.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';

const validator = { bsonType: 'object', required: ['a', 'b'], properties: { a: { bsonType: 'string' }, b: { enum: ['x', 'y'] } } };
const registry: CollectionRegistry = {
  common: { things: { ownership: 'new', validator } },
  group: {},
};

/** The same validator with its keys in another order, as the server may return it. */
const reordered = { properties: { b: { enum: ['x', 'y'] }, a: { bsonType: 'string' } }, required: ['a', 'b'], bsonType: 'object' };

function fake(options: { exists: boolean; options?: Record<string, unknown>; createError?: unknown; commandError?: unknown }) {
  const calls: string[] = [];
  const logs: Array<{ message: string; fields: unknown }> = [];
  const db = {
    listCollections: () => ({ toArray: async () => (options.exists ? [{ name: 'things', ...(options.options === undefined ? {} : { options: options.options }) }] : []) }),
    createCollection: async () => {
      calls.push('create');
      if (options.createError !== undefined) {
        throw options.createError;
      }
    },
    command: async (command: Record<string, unknown>) => {
      calls.push(`collMod:${String(command['collMod'])}:${String(command['validationAction'])}`);
      if (options.commandError !== undefined) {
        throw options.commandError;
      }
    },
    collection: () => ({ createIndexes: async () => undefined }),
  };
  const logger = { error: (message: string, fields?: unknown) => void logs.push({ message, fields }) };
  return { databases: { common: () => db } as unknown as Databases, calls, logs, logger };
}

const current = (overrides: Record<string, unknown> = {}) => ({ validator: { $jsonSchema: reordered }, validationLevel: 'strict', validationAction: 'error', ...overrides });

describe('validators in ensureIndexes', () => {
  it('creates a missing collection with the validator', async () => {
    const { databases, calls, logger } = fake({ exists: false });
    await ensureIndexes(databases, registry, logger);
    assert.deepEqual(calls, ['create']);
  });

  it('updates the validator of an existing collection that has none', async () => {
    const { databases, calls, logger, logs } = fake({ exists: true });
    await ensureIndexes(databases, registry, logger);
    assert.deepEqual(calls, ['collMod:things:error']);
    assert.deepEqual(logs, []);
  });

  it('does not run collMod when the current validator is the wanted one, whatever the order of the keys', async () => {
    const { databases, calls, logger, logs } = fake({ exists: true, options: current() });
    await ensureIndexes(databases, registry, logger);
    assert.deepEqual([calls, logs], [[], []]);
  });

  it('runs collMod when the schema, the level or the action differ', async () => {
    for (const options of [
      current({ validator: { $jsonSchema: { ...reordered, required: ['a'] } } }),
      current({ validationLevel: 'moderate' }),
      current({ validationAction: 'warn' }),
    ]) {
      const { databases, calls, logger } = fake({ exists: true, options });
      await ensureIndexes(databases, registry, logger);
      assert.deepEqual(calls, ['collMod:things:error']);
    }
  });

  it('logs an error and goes on when collMod is refused for lack of the privilege', async () => {
    const { databases, calls, logger, logs } = fake({ exists: true, options: current({ validationLevel: 'moderate' }), commandError: Object.assign(new Error('not allowed'), { code: 13 }) });
    await ensureIndexes(databases, registry, logger);
    assert.deepEqual(calls, ['collMod:things:error']);
    assert.deepEqual(logs, [{ message: 'validator out of date for things: the database user needs the collMod privilege; application-level validation still applies', fields: { collection: 'things' } }]);
  });

  it('rethrows any other collMod error', async () => {
    const { databases, logger, logs } = fake({ exists: true, commandError: Object.assign(new Error('boom'), { code: 8000 }) });
    await assert.rejects(ensureIndexes(databases, registry, logger), /boom/);
    assert.deepEqual(logs, []);
  });

  it('falls back to the update when another instance creates the collection first, and rethrows other errors', async () => {
    const race = fake({ exists: false, createError: Object.assign(new Error('exists'), { code: 48 }) });
    await ensureIndexes(race.databases, registry, race.logger);
    assert.deepEqual(race.calls, ['create', 'collMod:things:error']);
    const broken = fake({ exists: false, createError: Object.assign(new Error('denied'), { code: 13 }) });
    await assert.rejects(ensureIndexes(broken.databases, registry, broken.logger), /denied/);
    assert.deepEqual(broken.calls, ['create']);
  });

  it('refuses validators on group collections and on legacy collections', async () => {
    const group: CollectionRegistry = { common: {}, group: { things: { ownership: 'new', validator: { bsonType: 'object' } } } };
    const { databases, logger } = fake({ exists: true });
    await assert.rejects(ensureIndexes(databases, group, logger), /group\.things: validators on group databases are not supported yet/);
    const legacy: CollectionRegistry = { common: { users: { ownership: 'legacy-read', validator: { bsonType: 'object' } } }, group: {} };
    await assert.rejects(ensureIndexes(databases, legacy, logger), /a validator is allowed only on new collections/);
  });
});
