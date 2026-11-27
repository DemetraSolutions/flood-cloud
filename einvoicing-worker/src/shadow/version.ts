/**
 * The code version of the shadow analysis: what a report was produced with.
 *
 * A report is idempotent per `{ queueId, codeVersion }`, so a new deploy (a new `version` or a new `BUILD_SHA`, the image
 * tag) analyses every record again with the new code.
 *
 * @module
 */
import { readFileSync } from 'node:fs';

/**
 * Builds the code version.
 *
 * @param packageJson The text of `package.json`.
 * @param buildSha The build identifier (`BUILD_SHA`), or `undefined`.
 * @returns `<version>` or `<version>+<buildSha>`.
 * @throws {Error} When `package.json` is not JSON or has no string `version`.
 * @example
 * codeVersionOf('{"version":"0.1.0"}', 'abc123'); // '0.1.0+abc123'
 */
export function codeVersionOf(packageJson: string, buildSha: string | undefined): string {
  const parsed: unknown = JSON.parse(packageJson);
  const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new Error('package.json has no version');
  }
  return buildSha === undefined ? version : `${version}+${buildSha}`;
}

/**
 * The code version of the running worker: the `package.json` shipped next to `src/` (the image has it) and `BUILD_SHA`.
 *
 * @param buildSha The build identifier (`BUILD_SHA`), or `undefined`.
 * @returns The code version.
 * @throws {Error} When `package.json` cannot be read or has no version.
 */
export function currentCodeVersion(buildSha: string | undefined): string {
  return codeVersionOf(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'), buildSha);
}
