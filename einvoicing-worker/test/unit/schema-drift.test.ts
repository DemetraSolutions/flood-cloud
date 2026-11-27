/**
 * Drift guard: the rule tables of `src/validation/schema-rules.ts` must be identical to the official schemas.
 *
 * The schema files are read as plain text (no XML parser): every `xs:simpleType` is extracted with its base type,
 * facets (length, minLength, maxLength, minInclusive, maxInclusive, whiteSpace), pattern and enumeration values, and
 * compared with the tables with a deep equality. The guard is itself tested: edited copies of the schema (one value
 * changed per case) must be reported as different.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { checkValue, ORDINARY_TYPES, SIMPLIFIED_TYPES } from '../../src/validation/schema-rules.ts';
import type { SimpleTypeRule } from '../../src/validation/schema-rules.ts';

const SCHEMAS = new URL('../fixtures/xsd/', import.meta.url);

function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

type Facets = Record<string, string | number | readonly string[]>;

/** Extracts every `xs:simpleType` of a schema text. */
export function parseSimpleTypes(schema: string): Record<string, Facets> {
  const clean = schema.replace(/<xs:annotation>[\s\S]*?<\/xs:annotation>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const types: Record<string, Facets> = {};
  for (const type of clean.matchAll(/<xs:simpleType name="(\w+)">([\s\S]*?)<\/xs:simpleType>/g)) {
    const body = type[2] as string;
    const entry: Facets = { base: (/<xs:restriction base="([^"]+)"/.exec(body) as RegExpExecArray)[1] as string };
    for (const facet of body.matchAll(/<xs:(length|minLength|maxLength|minInclusive|maxInclusive|whiteSpace|pattern) value="([^"]*)"/g)) {
      const name = facet[1] as string;
      const value = decode(facet[2] as string);
      entry[name] = ['length', 'minLength', 'maxLength'].includes(name) ? Number(value) : value;
    }
    const values = [...body.matchAll(/<xs:enumeration value="([^"]*)"/g)].map((match) => decode(match[1] as string));
    if (values.length > 0) {
      entry.enumeration = values;
    }
    types[type[1] as string] = entry;
  }
  return types;
}

async function schema(name: string): Promise<string> {
  return readFile(new URL(name, SCHEMAS), 'utf8');
}

describe('rule tables against the official schemas', () => {
  it('the ordinary table equals every simpleType of the FPR12 schema', async () => {
    assert.deepEqual(ORDINARY_TYPES, parseSimpleTypes(await schema('Schema_VFPR12_v1.2.4.xsd.xml')));
  });

  it('the ordinary table equals every simpleType of the FPA12 schema', async () => {
    assert.deepEqual(ORDINARY_TYPES, parseSimpleTypes(await schema('Schema_VFPA12_v1.2.4.xsd.xml')));
  });

  it('the simplified table equals every simpleType of the FSM10 schema', async () => {
    assert.deepEqual(SIMPLIFIED_TYPES, parseSimpleTypes(await schema('Schema_VFSM10_v1.0.3.xsd.xml')));
  });

  it('the extraction is not vacuous: it finds the types and their facets', async () => {
    const types = parseSimpleTypes(await schema('Schema_VFPR12_v1.2.4.xsd.xml'));
    assert.ok(Object.keys(types).length >= 60);
    assert.deepEqual(types.CAPType, { base: 'xs:string', pattern: '[0-9][0-9][0-9][0-9][0-9]' });
    assert.deepEqual(types.RateType, { base: 'xs:decimal', maxInclusive: '100.00', pattern: '[0-9]{1,3}\\.[0-9]{2}' });
    assert.equal((types.TipoDocumentoType as Facets).length, 4);
    assert.equal(((types.NaturaType as Facets).enumeration as string[]).length, 24);
    assert.match((types.EmailType as Facets).pattern as string, /^\(\[!#-'\*\+\/-9=\?A-Z\^-~-\]\+.*\|"\(/);
  });

  it('every pattern of the tables compiles and is applied (no table entry is only decoration)', () => {
    for (const rule of [...Object.values(ORDINARY_TYPES), ...Object.values(SIMPLIFIED_TYPES)] as SimpleTypeRule[]) {
      if (rule.pattern !== undefined) {
        assert.doesNotThrow(() => checkValue(rule, 'x'), rule.pattern);
      }
    }
  });

  describe('the guard detects a drifted schema (one change per case)', () => {
    const edits: ReadonlyArray<readonly [string, (text: string) => string]> = [
      ['an enumeration value changed', (text) => text.replace('<xs:enumeration value="TD29">', '<xs:enumeration value="TD30">')],
      ['an enumeration value added', (text) => text.replace('<xs:enumeration value="MP23">', '<xs:enumeration value="MP23"></xs:enumeration><xs:enumeration value="MP24">')],
      ['a pattern changed', (text) => text.replace('[0-9][0-9][0-9][0-9][0-9]', '[0-9][0-9][0-9][0-9]')],
      ['a length changed', (text) => text.replace('<xs:maxLength value="28"', '<xs:maxLength value="29"')],
      ['a bound changed', (text) => text.replace('value="1970-01-01"', 'value="1971-01-01"')],
      ['a type added', (text) => text.replace('</xs:schema>', '<xs:simpleType name="NewType"><xs:restriction base="xs:string"/></xs:simpleType></xs:schema>')],
      ['a type removed', (text) => text.replace(/<xs:simpleType name="Art73Type">[\s\S]*?<\/xs:simpleType>/, '')],
    ];
    for (const [label, edit] of edits) {
      it(label, async () => {
        const original = await schema('Schema_VFPR12_v1.2.4.xsd.xml');
        const edited = edit(original);
        assert.notEqual(edited, original, 'the edit did not apply');
        assert.notDeepEqual(ORDINARY_TYPES, parseSimpleTypes(edited));
      });
    }
  });
});
