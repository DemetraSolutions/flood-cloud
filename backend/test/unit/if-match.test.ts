import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { AppError } from '../../src/shared/http/errors.ts';
import { entityTag, requireIfMatch } from '../../src/shared/http/if-match.ts';

const VERSION = 'A'.repeat(43);
const run = (header: string | undefined): { locals: { ifMatch?: string }; next: number; error: unknown } => {
  const res = { locals: {} } as unknown as Response;
  let next = 0;
  let error: unknown = null;
  try {
    void (requireIfMatch as (req: Request, res: Response, next: () => void) => void)({ get: (name: string) => (name === 'if-match' ? header : undefined) } as unknown as Request, res, () => void (next += 1));
  } catch (caught) {
    error = caught;
  }
  return { locals: res.locals, next, error };
};

describe('If-Match', () => {
  it('writes the strong tag of a version', () => {
    assert.equal(entityTag(VERSION), `"${VERSION}"`);
  });
  it('takes the version of one strong tag', () => {
    const result = run(` "${VERSION}" `);
    assert.equal(result.locals.ifMatch, VERSION);
    assert.equal(result.next, 1);
    assert.equal(result.error, null);
  });
  it('answers 422 required when the header is missing', () => {
    const { error, next } = run(undefined);
    assert.ok(error instanceof AppError && error.status === 422);
    assert.deepEqual(error.details, [{ field: 'If-Match', issue: 'required' }]);
    assert.equal(next, 0);
  });
  it('answers 422 format for anything that is not one of our strong tags', () => {
    for (const header of ['', '*', VERSION, `W/"${VERSION}"`, `"${VERSION}", "${VERSION}"`, '"short"', `"${VERSION}x"`, `"${'!'.repeat(43)}"`]) {
      const { error, next } = run(header);
      assert.ok(error instanceof AppError && error.status === 422, header);
      assert.deepEqual(error.details, [{ field: 'If-Match', issue: 'format' }], header);
      assert.equal(next, 0);
    }
  });
});
