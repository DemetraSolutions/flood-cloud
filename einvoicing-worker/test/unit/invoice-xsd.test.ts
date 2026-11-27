import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { mapQueueRecord } from '../../src/invoice/from-queue.ts';
import { serialize } from '../../src/invoice/serialize.ts';
import { baseRecord, fixtures, withValues } from '../fixtures/records.ts';
import { SCHEMAS, validateAgainstSchema } from '../helpers/xsd.ts';

const run = promisify(execFile);
const TRANSMITTER = { IdPaese: 'IT', IdCodice: '01879020517' };

function build(name: string): { xml: string; format: keyof typeof SCHEMAS } {
  const make = fixtures[name];
  assert.ok(make !== undefined, name);
  const result = mapQueueRecord(make(), { transmitter: TRANSMITTER });
  assert.ok(result.ok, `${name} does not map: ${JSON.stringify(result.ok ? [] : result.issues)}`);
  return { xml: serialize(result.model), format: result.model.versione };
}

describe('XSD validation with xmllint (the official schemas, the xmldsig import replaced by a local stub)', () => {
  it('xmllint is installed (the XSD tests fail, never skip, without it)', async () => {
    const { stderr, stdout } = await run('xmllint', ['--version']);
    assert.match(`${stdout}${stderr}`, /libxml/i);
  });

  for (const name of Object.keys(fixtures)) {
    it(`the XML of "${name}" validates against its schema`, async () => {
      const { xml, format } = build(name);
      const result = await validateAgainstSchema(xml, SCHEMAS[format]);
      assert.equal(result.valid, true, result.output);
    });
  }

  it('covers the three official schemas', () => {
    const formats = new Set(Object.keys(fixtures).map((name) => build(name).format));
    assert.deepEqual([...formats].sort(), ['FPA12', 'FPR12', 'FSM10']);
  });

  it('an ordinary invoice also validates against the schema of the public administration (same file)', async () => {
    const { xml } = build('private-recipient-code');
    assert.equal((await validateAgainstSchema(xml, SCHEMAS.FPA12)).valid, true);
  });

  it('a credit note citing its original through the linkedInvoice option validates against the schema', async () => {
    const record = withValues(baseRecord(), { type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: 'abc' });
    const result = mapQueueRecord(record, { transmitter: TRANSMITTER, linkedInvoice: { number: '12', prefixSuffix: '', date: new Date('2026-11-20T10:00:00.000Z') } });
    assert.ok(result.ok);
    const xml = serialize(result.model);
    assert.match(xml, /<DatiFattureCollegate>\s*<IdDocumento>12<\/IdDocumento>\s*<Data>2026-11-20<\/Data>/);
    assert.equal((await validateAgainstSchema(xml, SCHEMAS.FPR12)).valid, true);
  });

  it('the harness is not vacuous: documents that break the schema are rejected', async () => {
    const { xml } = build('private-recipient-code');
    const broken: Array<[string, string]> = [
      ['an element out of order', xml.replace('<Divisa>EUR</Divisa>\n        <Data>2026-11-27</Data>', '<Data>2026-11-27</Data>\n        <Divisa>EUR</Divisa>')],
      ['a postcode of the wrong length', xml.replace('<CAP>20100</CAP>', '<CAP>2010</CAP>')],
      ['an amount with three decimals', xml.replace('<ImponibileImporto>1.64</ImponibileImporto>', '<ImponibileImporto>1.643</ImponibileImporto>')],
      ['a character outside Basic Latin in a code', xml.replace('<Numero>42</Numero>', '<Numero>4è</Numero>')],
      ['a wrong namespace', xml.replace('fatture/v1.2', 'fatture/v9.9')],
      ['a qualified child element', xml.replace('<FatturaElettronicaHeader>', '<p:FatturaElettronicaHeader>').replace('</FatturaElettronicaHeader>', '</p:FatturaElettronicaHeader>')],
    ];
    for (const [label, document] of broken) {
      assert.notEqual(document, xml, `${label}: the mutation did not apply`);
      assert.equal((await validateAgainstSchema(document, SCHEMAS.FPR12)).valid, false, label);
    }
  });

  it('the schema copy under test never reaches the network', async () => {
    const text = await readFile(new URL('../fixtures/xsd/Schema_VFPR12_v1.2.4.xsd.xml', import.meta.url), 'utf8');
    assert.match(text, /schemaLocation="http:\/\/www\.w3\.org/);
    const { xml } = build('private-recipient-code');
    assert.equal((await validateAgainstSchema(xml, SCHEMAS.FPR12)).valid, true);
  });
});

describe('golden documents', () => {
  for (const [name, file] of [
    ['private-recipient-code', 'private-recipient-code.xml'],
    ['simplified-td08-rectified', 'simplified-td08-rectified.xml'],
  ] as const) {
    it(`"${name}" serializes to the bytes of ${file}`, async () => {
      const expected = await readFile(new URL(`../fixtures/expected/${file}`, import.meta.url), 'utf8');
      assert.equal(build(name).xml, expected);
    });
  }
});
