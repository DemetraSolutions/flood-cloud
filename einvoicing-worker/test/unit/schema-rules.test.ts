import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkValue, isDate, isDateTime, ORDINARY_RULES, ORDINARY_TYPES, SIMPLIFIED_RULES, SIMPLIFIED_TYPES } from '../../src/validation/schema-rules.ts';

const T = ORDINARY_TYPES;

describe('checkValue: facets of the simple types', () => {
  it('accepts valid values and reports the facet that fails first', () => {
    assert.equal(checkValue(T.CAPType, '20100'), null);
    assert.equal(checkValue(T.CAPType, '2010'), 'PATTERN');
    assert.equal(checkValue(T.TipoDocumentoType, 'TD01'), null);
    assert.equal(checkValue(T.TipoDocumentoType, 'TD1'), 'LENGTH');
    assert.equal(checkValue(T.TipoDocumentoType, 'TD99'), 'ENUMERATION');
    assert.equal(checkValue(T.CodiceType, ''), 'LENGTH');
    assert.equal(checkValue(T.CodiceType, 'x'.repeat(28)), null);
    assert.equal(checkValue(T.CodiceType, 'x'.repeat(29)), 'LENGTH');
    assert.equal(checkValue(T.CodEORIType, 'x'.repeat(12)), 'LENGTH');
    assert.equal(checkValue(T.CodEORIType, 'x'.repeat(13)), null);
  });

  it('counts code points, not UTF-16 units', () => {
    assert.equal(checkValue({ base: 'xs:string', maxLength: 1 }, '😀'), null);
    assert.equal(checkValue({ base: 'xs:string', maxLength: 1 }, '😀😀'), 'LENGTH');
    assert.equal(checkValue({ base: 'xs:string', length: 2 }, '😀a'), null);
    assert.equal(checkValue({ base: 'xs:string', minLength: 2 }, '😀'), 'LENGTH');
  });

  it('applies the whitespace facet of the base type', () => {
    // string: preserved; normalizedString: tab and line breaks become spaces; token and Titolo: also collapsed.
    assert.equal(checkValue({ base: 'xs:string', pattern: 'a b' }, 'a b'), null);
    assert.equal(checkValue({ base: 'xs:string', pattern: 'a b' }, 'a\tb'), 'PATTERN');
    assert.equal(checkValue({ base: 'xs:normalizedString', pattern: 'a b' }, 'a\tb'), null);
    assert.equal(checkValue({ base: 'xs:normalizedString', pattern: 'a b' }, 'a\r\nb'), 'PATTERN');
    assert.equal(checkValue({ base: 'xs:token', pattern: 'a b' }, ' a \t\n b '), null);
    assert.equal(checkValue(T.TitoloType, '  Dott.  '), null);
    assert.equal(checkValue(T.TitoloType, ' D '), 'PATTERN');
  });

  it('checks the lexical form of decimals, integers, dates and date-times', () => {
    assert.equal(checkValue({ base: 'xs:decimal' }, '-12.50'), null);
    assert.equal(checkValue({ base: 'xs:decimal' }, '1,5'), 'LEXICAL');
    assert.equal(checkValue({ base: 'xs:integer' }, '+12'), null);
    assert.equal(checkValue({ base: 'xs:integer' }, '1.5'), 'LEXICAL');
    assert.equal(checkValue({ base: 'xs:date' }, '2026-11-27'), null);
    assert.equal(checkValue({ base: 'xs:date' }, '27-11-2026'), 'LEXICAL');
    assert.equal(checkValue({ base: 'xs:dateTime' }, '2026-11-27T10:00:00Z'), null);
    assert.equal(checkValue({ base: 'xs:dateTime' }, '2026-11-27'), 'LEXICAL');
  });

  it('checks ranges: decimals, integers and dates, with lower and upper bounds', () => {
    assert.equal(checkValue(T.RateType, '100.00'), null);
    assert.equal(checkValue(T.RateType, '100.01'), 'RANGE');
    assert.equal(checkValue(T.RateType, '0.00'), null);
    assert.equal(checkValue(T.NumeroLineaType, '0'), 'RANGE');
    assert.equal(checkValue(T.NumeroLineaType, '1'), null);
    assert.equal(checkValue(T.NumeroLineaType, '9999'), null);
    assert.equal(checkValue(T.NumeroLineaType, '10000'), 'RANGE');
    assert.equal(checkValue(T.DataFatturaType, '1970-01-01'), null);
    assert.equal(checkValue(T.DataFatturaType, '1969-12-31'), 'RANGE');
    assert.equal(checkValue(T.DataFatturaType, '1970-01-01+01:00'), null);
    assert.equal(checkValue({ base: 'xs:date', maxInclusive: '2000-01-01' }, '2000-01-02'), 'RANGE');
    assert.equal(checkValue({ base: 'xs:date', maxInclusive: '2000-01-01' }, '2000-01-01'), null);
  });

  it('applies the schema patterns: decimals, identifiers, e-mail, IBAN, BIC', () => {
    assert.equal(checkValue(T.Amount2DecimalType, '12345678901.23'), null);
    assert.equal(checkValue(T.Amount2DecimalType, '123456789012.23'), 'PATTERN');
    assert.equal(checkValue(T.Amount2DecimalType, '-1.00'), null);
    assert.equal(checkValue(T.Amount2DecimalType, '1.0'), 'PATTERN');
    assert.equal(checkValue(T.Amount8DecimalType, '1.12345678'), null);
    assert.equal(checkValue(T.Amount8DecimalType, '1.123456789'), 'PATTERN');
    assert.equal(checkValue(T.QuantitaType, '-1.00'), 'PATTERN');
    assert.equal(checkValue(T.PesoType, '1234.50'), null);
    assert.equal(checkValue(T.PesoType, '12345.50'), 'PATTERN');
    assert.equal(checkValue(T.CodiceDestinatarioType, 'ABC123'), null);
    assert.equal(checkValue(T.CodiceDestinatarioType, 'abc123'), 'PATTERN');
    assert.equal(checkValue(SIMPLIFIED_TYPES.CodiceDestinatarioType, 'ABC123'), 'PATTERN');
    assert.equal(checkValue(SIMPLIFIED_TYPES.CodiceDestinatarioType, 'ABC1234'), null);
    assert.equal(checkValue(T.String10Type, 'abc'), null);
    assert.equal(checkValue(T.String10Type, 'abcè'), 'PATTERN');
    assert.equal(checkValue(T.String60LatinType, 'Caffè Ñandú'), null);
    assert.equal(checkValue(T.String60LatinType, 'Ā'), 'PATTERN');
    assert.equal(checkValue(T.String60LatinType, ''), 'PATTERN');
    assert.equal(checkValue(T.IBANType, 'IT60X0542811101000000123456'), null);
    assert.equal(checkValue(T.IBANType, 'IT60X0542811101000000123-56'), 'PATTERN');
    assert.equal(checkValue(T.BICType, 'BEPIIT22XXX'), null);
    assert.equal(checkValue(T.BICType, 'BEPIIT12'), 'PATTERN');
    for (const address of ['a@b.it', 'a.b@c.d.it', 'x@[1.2.3.4]', '"[]!#-a"@x.it', "o'brien@x.it", '!#$%&*+/=?^_`{|}~-@x.it']) {
      assert.equal(checkValue(T.EmailType, address), null, address);
    }
    // The quoted local part of the schema only matches the odd sequence `[]!#-` and one more character.
    for (const address of ['"q"@x.it', '', 'a', 'a@', '@b.it', 'a b@c.it', 'a..b@c.it', '.a@c.it', 'a@b c.it', 'a@b..it']) {
      assert.notEqual(checkValue(T.EmailType, address), null, address);
    }
    assert.equal(checkValue(T.EmailType, `${'a'.repeat(252)}@b.it`), 'LENGTH');
    assert.equal(checkValue(T.EmailContattiType, 'ab@cd.it'), null);
    assert.equal(checkValue(T.EmailContattiType, 'abcd.it'), 'PATTERN');
  });

  it('exposes the rules with the built-in types for both families of schemas', () => {
    assert.deepEqual(ORDINARY_RULES['xs:date'], { base: 'xs:date' });
    assert.deepEqual(SIMPLIFIED_RULES['xs:dateTime'], { base: 'xs:dateTime' });
    assert.equal(ORDINARY_RULES.NaturaType, ORDINARY_TYPES.NaturaType);
    assert.equal(SIMPLIFIED_RULES.NaturaType, SIMPLIFIED_TYPES.NaturaType);
    assert.equal(checkValue(ORDINARY_TYPES.NaturaType, 'N6.1'), null);
    assert.equal(checkValue(SIMPLIFIED_TYPES.NaturaType, 'N6.1'), 'ENUMERATION');
  });
});

describe('dates and date-times', () => {
  it('accepts real calendar dates with an optional time zone', () => {
    for (const value of ['2026-11-27', '2024-02-29', '2000-02-29', '0001-01-01', '2026-12-31Z', '2026-11-27+01:00', '2026-11-27-05:30', '2026-11-27+14:00', '2026-11-27-13:59']) {
      assert.equal(isDate(value), true, value);
    }
  });

  it('rejects impossible dates, years and time zones', () => {
    for (const value of ['2026-00-10', '2026-13-01', '2026-02-29', '2100-02-29', '1900-02-29', '2026-04-31', '2026-11-00', '0000-01-01', '2026-11-27+14:01', '2026-11-27+15:00', '2026-11-27+01:60', '26-11-27', '2026-1-27', '', '2026-11-27 ']) {
      assert.equal(isDate(value), false, value);
    }
  });

  it('accepts and rejects date-times', () => {
    for (const value of ['2026-11-27T10:00:00', '2026-11-27T23:59:59.999Z', '2026-11-27T00:00:00+01:00', '2024-02-29T12:00:00.5']) {
      assert.equal(isDateTime(value), true, value);
    }
    for (const value of ['2026-11-27T24:00:00', '2026-11-27T10:60:00', '2026-11-27T10:00', '2026-11-27 10:00:00', '2026-02-30T10:00:00', '2026-11-27T10:00:00.', '2026-11-27T1:00:00']) {
      assert.equal(isDateTime(value), false, value);
    }
  });
});
