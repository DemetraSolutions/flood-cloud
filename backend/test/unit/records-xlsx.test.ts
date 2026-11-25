import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/http/errors.ts';
import { cardCodesOf, recognizeBirthDate } from '../../src/modules/contacts-xlsx/contacts-xlsx.import.ts';
import { RecordErrorCollector } from '../../src/modules/records-xlsx/records-xlsx.errors.ts';
import { RecordRowReader, columnOfField, identityOf, normalizeRecordHeader, parseRecordHeader, refuse } from '../../src/modules/records-xlsx/records-xlsx.sheet.ts';
import type { ParsedRecordSheet, RecordSheet } from '../../src/modules/records-xlsx/records-xlsx.sheet.ts';

const SHEET: RecordSheet = { name: 'S', columns: [{ key: 'id', header: 'ID' }, { key: 'name', header: 'NOME' }, { key: 'delete', header: 'CANCELLAZIONE (X)' }, { key: 'first', header: 'CF' }, { key: 'company', header: 'AZIENDA' }, { key: 'second', header: 'CF' }], splitAfter: 'company' };
const TABLE = [['name', 'name'], ['phones', 'phone']] as const;

/** A row reader over a sheet whose header is `header` and whose only row is `cells`. */
function reader(cells: Array<string | number | boolean | null>, header: string[] = ['ID', 'NOME', 'CANCELLAZIONE (X)']) {
  const errors = new RecordErrorCollector('S');
  const parsed: ParsedRecordSheet = { sheet: SHEET, header: parseRecordHeader(SHEET, header), rows: [{ number: 2, cells }] };
  return { errors, rv: new RecordRowReader(parsed, parsed.rows[0]!, errors) };
}

describe('the header of a one-sheet workbook', () => {
  it('compares headers without the spaces around the separators', () => {
    assert.equal(normalizeRecordHeader(' tipo (id / nome ) '), 'TIPO (ID/NOME)');
    assert.equal(normalizeRecordHeader('Punti (id/nome : valore | id/nome : valore)'), 'PUNTI (ID/NOME:VALORE|ID/NOME:VALORE)');
  });

  it('gives a header that two columns share to the first, or to the second when it is after the split column', () => {
    assert.deepEqual([...parseRecordHeader(SHEET, ['CF', 'AZIENDA', 'CF']).fixed], [['first', 0], ['company', 1], ['second', 2]]);
    assert.deepEqual([...parseRecordHeader(SHEET, ['AZIENDA', 'CF']).fixed], [['company', 0], ['second', 1]]);
    assert.deepEqual(parseRecordHeader(SHEET, ['CF', 'CF']).problems, [{ code: 'duplicateColumn', column: 'CF' }]);
    assert.deepEqual(parseRecordHeader(SHEET, ['CF', 'AZIENDA', 'CF', 'CF']).problems, [{ code: 'duplicateColumn', column: 'CF' }]);
    assert.deepEqual(parseRecordHeader(SHEET, [null, true, 'X', 5]).problems.map((problem) => problem.code), ['unknownColumn', 'unknownColumn']);
  });
});

describe('the reading of a row', () => {
  it('reads a column as a trimmed text, undefined when the sheet has no such column, and refuses a boolean or a very long cell', () => {
    const { rv, errors } = reader(['  a1 ', true, 'x'.repeat(4001)]);
    assert.deepEqual([rv.text('id'), rv.text('name'), rv.text('delete'), rv.text('first')], ['a1', '', '', undefined]);
    assert.deepEqual(errors.errors.map((error) => [error.row, error.column, error.code]), [[2, 'NOME', 'invalidValue'], [2, 'CANCELLAZIONE (X)', 'invalidValue']]);
    assert.equal(rv.failed, true);
    rv.fail(null, 'conflict');
    rv.fail('unknown', 'invalid', 'detail');
    assert.deepEqual(errors.errors.slice(2).map((error) => [error.column, error.message]), [[null, 'The change conflicts with the state of the data'], ['unknown', 'The value is refused (detail)']]);
  });

  it('finds the identity of a row: a new element, an id in any case, a deletion', () => {
    const seen = new Set<string>();
    const keys = { id: 'id', remove: 'delete' };
    assert.deepEqual(identityOf(reader(['', '', '']).rv, seen, keys), { id: null, remove: false });
    assert.deepEqual(identityOf(reader(['A'.repeat(24), '', 'x']).rv, seen, keys), { id: 'a'.repeat(24), remove: true });
    const duplicate = reader(['a'.repeat(24), '', '']);
    identityOf(duplicate.rv, seen, keys);
    assert.deepEqual(duplicate.errors.errors.map((error) => error.code), ['duplicateId']);
    const without = reader(['', '', 'X']);
    assert.deepEqual(identityOf(without.rv, seen, keys), { id: null, remove: false });
    assert.deepEqual(without.errors.errors.map((error) => error.code), ['deleteWithoutId']);
    const bad = reader(['zz', '', 'maybe']);
    assert.deepEqual(identityOf(bad.rv, seen, keys), { id: null, remove: false });
    assert.deepEqual(bad.errors.errors.map((error) => error.code), ['invalidValue', 'invalidId']);
    assert.deepEqual(identityOf(reader(['b'.repeat(24)], ['ID']).rv, seen, keys), { id: 'b'.repeat(24), remove: false }, 'a sheet with no deletion column');
  });
});

describe('what a service refuses', () => {
  it('finds the column of a field by its path or its parent', () => {
    assert.equal(columnOfField(TABLE, 'name'), 'name');
    assert.equal(columnOfField(TABLE, 'phones.0'), 'phone');
    assert.equal(columnOfField(TABLE, 'phones[1]'), 'phone');
    assert.equal(columnOfField(TABLE, 'phonesX'), null);
    assert.equal(columnOfField(TABLE, 'other'), null);
  });

  it('turns the refusals of the data into problems of the row, a refusal without details into one without a column, and rethrows anything else', () => {
    const { rv, errors } = reader(['', '', '']);
    refuse(new AppError('VALIDATION_ERROR', { details: [{ field: 'name', issue: 'required' }, { field: 'phones.0', issue: 'format' }, { field: 'a', issue: 'x' }, { field: 'b', issue: 'x' }, { field: 'c', issue: 'x' }, { field: 'd', issue: 'x' }] }), rv, TABLE);
    assert.equal(errors.errors.length, 5, 'at most five details of a refusal');
    assert.deepEqual(errors.errors.slice(0, 2).map((error) => [error.column, error.code, error.message]), [['NOME', 'invalid', 'The value is refused (name: required)'], ['phone', 'invalid', 'The value is refused (phones.0: format)']]);
    refuse(new AppError('CONFLICT'), rv, TABLE);
    refuse(new AppError('FORBIDDEN'), rv, TABLE);
    refuse(new AppError('NOT_FOUND'), rv, TABLE);
    refuse(new AppError('PRECONDITION_FAILED'), rv, TABLE);
    assert.deepEqual(errors.errors.slice(5).map((error) => [error.column, error.code]), [[null, 'conflict'], [null, 'forbidden'], [null, 'notFound'], [null, 'conflict']]);
    assert.throws(() => refuse(new AppError('SERVICE_UNAVAILABLE'), rv, TABLE), (error: AppError) => error.code === 'SERVICE_UNAVAILABLE');
    assert.throws(() => refuse(new Error('boom'), rv, TABLE), /boom/);
  });
});

describe('the cells of the contacts', () => {
  it('reads a date of birth as written, or as the serial number of a spreadsheet', () => {
    assert.deepEqual(['1980/01/31', '1980-01-31', '29221', '10000', '2958465', '2958466', '9999', '123', '12345678', '31/01/1980', 'x', ''].map(recognizeBirthDate), ['1980-01-31', '1980-01-31', '1980-01-01', '1927-05-18', '9999-12-31', null, null, null, null, null, null, null]);
  });

  it('reads the codes of the cards, with or without points, without repetitions', () => {
    assert.deepEqual(cardCodesOf('A | B:10 | C:7,5 | A | D:x | : | E:1:2 | | '), ['A', 'B', 'C', 'D:x', ':', 'E:1']);
    assert.deepEqual(cardCodesOf(''), []);
    assert.deepEqual(cardCodesOf('AB:12 | X:5', new Set(['AB:12'])), ['AB:12', 'X']);
  });
});
