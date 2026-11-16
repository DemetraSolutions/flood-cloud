import { IdempotencyKey } from './idempotency';

describe('IdempotencyKey', () => {
  it('generates a UUID', () => {
    expect(new IdempotencyKey().forBody({ a: 1 })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('reuses the key for a retry of the same body', () => {
    const keys = new IdempotencyKey();
    expect(keys.forBody({ a: 1 })).toBe(keys.forBody({ a: 1 }));
  });

  it('uses another key for another body and after a reset', () => {
    const keys = new IdempotencyKey();
    const first = keys.forBody({ a: 1 });
    expect(keys.forBody({ a: 2 })).not.toBe(first);
    const second = keys.forBody({ a: 2 });
    keys.reset();
    expect(keys.forBody({ a: 2 })).not.toBe(second);
  });

  it('accepts a request without a body', () => {
    const keys = new IdempotencyKey();
    expect(keys.forBody(null)).toBe(keys.forBody(undefined));
  });
});
