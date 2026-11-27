/**
 * XSD validation of generated invoices with the system `xmllint` (libxml2), for the tests only.
 *
 * The official schemas import the W3C XML Signature schema from a remote URL; the tests never download it. A
 * temporary copy of each schema is rewritten to import the local stub (`test/fixtures/xsd/xmldsig-stub.xsd`, a global
 * `Signature` element with any content), and `xmllint --noout --schema` runs on that copy. If `xmllint` is not
 * installed the validation throws: the tests fail instead of skipping (CI installs `libxml2-utils`).
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FIXTURES = new URL('../fixtures/xsd/', import.meta.url);
const REMOTE_IMPORT = /schemaLocation="http:\/\/www\.w3\.org\/TR\/2002\/REC-xmldsig-core-20020212\/xmldsig-core-schema\.xsd"/;

/** The official schema files, by format. */
export const SCHEMAS = {
  FPR12: 'Schema_VFPR12_v1.2.4.xsd.xml',
  FPA12: 'Schema_VFPA12_v1.2.4.xsd.xml',
  FSM10: 'Schema_VFSM10_v1.0.3.xsd.xml',
} as const;

/** Result of a validation. */
export interface XsdResult {
  readonly valid: boolean;
  /** Output of `xmllint` (empty when valid except for its "validates" line). */
  readonly output: string;
}

/**
 * Validates an XML document against an official schema.
 *
 * @param xml The document.
 * @param schema File name of the schema (a value of {@link SCHEMAS}).
 * @returns Whether it validates, and the `xmllint` output.
 * @throws Error When `xmllint` cannot be run (not installed).
 */
export async function validateAgainstSchema(xml: string, schema: string): Promise<XsdResult> {
  const directory = await mkdtemp(join(tmpdir(), 'einvoicing-xsd-'));
  try {
    const text = (await readFile(new URL(schema, FIXTURES), 'utf8')).replace(REMOTE_IMPORT, 'schemaLocation="xmldsig-stub.xsd"');
    if (text.includes('www.w3.org/TR/')) {
      throw new Error('The schema still imports a remote document');
    }
    await copyFile(new URL('xmldsig-stub.xsd', FIXTURES), join(directory, 'xmldsig-stub.xsd'));
    await writeFile(join(directory, 'schema.xsd'), text);
    await writeFile(join(directory, 'invoice.xml'), xml);
    try {
      const { stderr } = await run('xmllint', ['--noout', '--nonet', '--schema', join(directory, 'schema.xsd'), join(directory, 'invoice.xml')]);
      return { valid: true, output: stderr };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === 'ENOENT') {
        throw new Error('xmllint is not installed (install libxml2-utils): the XSD tests cannot run', { cause: error });
      }
      return { valid: false, output: failure.stderr ?? String(error) };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
