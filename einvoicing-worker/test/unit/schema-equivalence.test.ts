/**
 * Equivalence of the schema validator with `xmllint` on the official schemas.
 *
 * For every EI3 fixture and for every mutation of the catalogue (`test/helpers/mutations.ts`, one per schema rule)
 * the model is validated by `validateSchema`, serialized and validated by `xmllint`: the validator reports errors
 * exactly when the schema rejects the document. Two documented exceptions: a mutation the writer hides (`model-only`,
 * the model is wrong but the XML is fine) and a text the writer refuses to write (`unserializable`).
 * `xmllint` missing makes the tests fail, never skip.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serialize } from '../../src/invoice/serialize.ts';
import { validateSchema } from '../../src/validation/schema-validate.ts';
import { change, mapped, rich, richSimplified } from '../helpers/models.ts';
import { ORDINARY_MUTATIONS, SIMPLIFIED_MUTATIONS } from '../helpers/mutations.ts';
import { fixtures } from '../fixtures/records.ts';
import { SCHEMAS, validateAgainstSchema } from '../helpers/xsd.ts';

/** Whether an issue path is the expected one or lies below it. */
function under(path: string, expected: string): boolean {
  return path === expected || path.startsWith(`${expected}.`) || path.startsWith(`${expected}[`);
}

const FORMAT = { ordinary: 'FPR12', simplified: 'FSM10' } as const;

describe('schema validator and xmllint agree', { concurrency: 8 }, () => {
  for (const name of Object.keys(fixtures)) {
    it(`fixture "${name}": no schema error, and the schema accepts the XML`, async () => {
      const { model } = mapped(name);
      assert.deepEqual(validateSchema(model), []);
      assert.equal((await validateAgainstSchema(serialize(model), SCHEMAS[model.versione === 'FSM10' ? 'FSM10' : 'FPR12'])).valid, true);
    });
  }

  it('the base models of the mutations are valid for both', async () => {
    for (const model of [rich(), richSimplified()]) {
      assert.deepEqual(validateSchema(model), []);
      const result = await validateAgainstSchema(serialize(model), SCHEMAS[model.versione === 'FSM10' ? 'FSM10' : 'FPR12']);
      assert.equal(result.valid, true, result.output);
    }
  });

  for (const mutation of [...ORDINARY_MUTATIONS, ...SIMPLIFIED_MUTATIONS]) {
    it(`${mutation.format}: ${mutation.name}`, async () => {
      const model = change(mutation.format === 'ordinary' ? rich() : richSimplified(), mutation.set);
      const issues = validateSchema(model);
      const expected = mutation.path;
      if (expected === undefined) {
        assert.deepEqual(issues, [], 'the schema allows this value');
      } else {
        assert.ok(issues.length > 0, 'the validator must report it');
        assert.ok(issues.some((found) => under(found.path, expected)), `no issue at ${expected}: ${JSON.stringify(issues)}`);
        assert.ok(issues.every((found) => found.code === 'XSD' && found.severity === 'error'));
      }
      if (mutation.xml === 'unserializable') {
        assert.throws(() => serialize(model));
        return;
      }
      const result = await validateAgainstSchema(serialize(model), SCHEMAS[FORMAT[mutation.format]]);
      assert.equal(result.valid, mutation.xml !== 'invalid', `xmllint: ${result.output.split('\n').slice(0, 3).join(' | ')}`);
    });
  }

  it('the catalogue is large and covers every kind of expectation', () => {
    const all = [...ORDINARY_MUTATIONS, ...SIMPLIFIED_MUTATIONS];
    assert.ok(all.length >= 250, `${all.length} mutations`);
    for (const kind of ['invalid', 'valid', 'model-only', 'unserializable'] as const) {
      assert.ok(all.some((mutation) => mutation.xml === kind), kind);
    }
    assert.equal(new Set(all.map((mutation) => `${mutation.format}/${mutation.name}`)).size, all.length, 'names are unique');
  });
});
