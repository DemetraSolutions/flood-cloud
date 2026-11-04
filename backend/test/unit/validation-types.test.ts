import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectId } from 'mongodb';
import { array, boolean, email, enumOf, integer, isoDate, nullable, object, objectId, optional, phone, string, validate } from '../../src/shared/validation/schema.ts';
import type { Infer } from '../../src/shared/validation/schema.ts';

/** Compile-time equality: `Equal<A, B>` is `true` only when the types are identical. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<_T extends true>(): void {}

const schema = object({
  name: string({ max: 10 }),
  age: optional(integer()),
  role: enumOf(['A', 'B']),
  note: nullable(string({ max: 10 })),
  maybe: optional(nullable(boolean())),
  ids: array(objectId(), { max: 3 }),
  when: isoDate(),
  contact: object({ email: email(), phone: optional(phone()) }),
});

describe('types derived from the schemas', () => {
  it('infer the validated shape, with optional keys and literal enums', () => {
    type Expected = {
      name: string;
      age?: number;
      role: 'A' | 'B';
      note: string | null;
      maybe?: boolean | null;
      ids: ObjectId[];
      when: Date;
      contact: { email: string; phone?: string };
    };
    expectType<Equal<Infer<typeof schema>, Expected>>();
    // @ts-expect-error a required key is not optional
    expectType<Equal<Infer<typeof schema>, Omit<Expected, 'name'> & { name?: string }>>();
    const value = validate(schema, { name: 'a', role: 'A', note: null, ids: [], when: '2026-01-01', contact: { email: 'a@b.it' } }, 'v');
    const role: 'A' | 'B' = value.role;
    assert.equal(role, 'A');
    assert.equal(value.age, undefined);
    assert.equal(value.contact.email, 'a@b.it');
  });
});
