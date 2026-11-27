import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { child, error, issue, sortIssues, warning } from '../../src/validation/issue.ts';

describe('validation issues', () => {
  it('builds errors and warnings', () => {
    assert.deepEqual(error('00400', 'a.b', 'm'), { code: '00400', path: 'a.b', severity: 'error', message: 'm' });
    assert.deepEqual(warning('TEXT', 'a', 'm'), { code: 'TEXT', path: 'a', severity: 'warning', message: 'm' });
    assert.deepEqual(issue('X', 'p', 'warning', 'm'), warning('X', 'p', 'm'));
  });

  it('joins paths', () => {
    assert.equal(child('', 'A'), 'A');
    assert.equal(child('A', 'B[0]'), 'A.B[0]');
  });

  it('sorts by path, then code, then message, without touching the input', () => {
    const input = [
      error('00421', 'B', 'x'),
      error('00400', 'B', 'y'),
      error('00400', 'B', 'a'),
      error('00400', 'A', 'z'),
      error('00400', 'B', 'a'),
    ];
    const copy = structuredClone(input);
    assert.deepEqual(sortIssues(input).map((found) => `${found.path}/${found.code}/${found.message}`), [
      'A/00400/z',
      'B/00400/a',
      'B/00400/a',
      'B/00400/y',
      'B/00421/x',
    ]);
    assert.deepEqual(input, copy);
  });
});
