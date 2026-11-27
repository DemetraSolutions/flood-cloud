import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { codeVersionOf, currentCodeVersion } from '../../src/shadow/version.ts';

describe('the shadow code version', () => {
  it('is the package version, with the build identifier when there is one', () => {
    assert.equal(codeVersionOf('{"version":"0.1.0"}', undefined), '0.1.0');
    assert.equal(codeVersionOf('{"version":"0.1.0"}', 'abc123'), '0.1.0+abc123');
  });

  it('refuses a package.json without a version', () => {
    for (const text of ['{}', '{"version":3}', '{"version":""}', 'null', '[]']) {
      assert.throws(() => codeVersionOf(text, undefined), /no version/, text);
    }
    assert.throws(() => codeVersionOf('not json', undefined), SyntaxError);
  });

  it('reads the package.json next to src', () => {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(currentCodeVersion(undefined), version);
    assert.equal(currentCodeVersion('sha'), `${version}+sha`);
  });
});
