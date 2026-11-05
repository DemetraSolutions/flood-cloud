import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { DEFAULT_LIMIT, MAX_CURSOR_LENGTH, MAX_CURSOR_VALUE_BYTES, MAX_LIMIT, SORT_KEY, escapeRegExp, listParamsOf, listPipeline, listQueryShape, listSearch, pageOf } from '../../src/shared/http/list.ts';
import type { ListConfig, ListParams } from '../../src/shared/http/list.ts';
import { integerString, object, validate } from '../../src/shared/validation/schema.ts';

const config: ListConfig = {
  sorts: { name: { field: 'name', kind: 'string' }, born: { field: 'born', kind: 'date' }, nested: { field: 'a.b', kind: 'string' } },
  defaultSort: 'name',
  searchFields: ['name', 'email'],
};
const query = object(listQueryShape(config));
const parse = (raw: Record<string, unknown>) => validate(query, raw, '(query)');
const ID = new ObjectId();

/** The cursor a page of this sort ends with, taken from a real page. */
function cursorAfter(sort: string, document: Record<string, unknown>): string {
  const params: ListParams = { limit: 1, sort, q: null, cursor: null };
  // The database puts the sort key on every document; here it is the value of the field, as the pipeline computes it.
  const raw = sort.replace('-', '') === 'nested' ? (document['a'] as { b?: unknown } | undefined)?.b : document[sort.replace('-', '')];
  return pageOf([{ ...document, [SORT_KEY]: raw === undefined || typeof raw === 'object' && !(raw instanceof Date) ? null : raw }, { _id: new ObjectId() }], params).page.next!;
}

const failure = (raw: Record<string, unknown>) => {
  try {
    listParamsOf(parse(raw), config);
  } catch (error) {
    return (error as { details: unknown }).details;
  }
  return assert.fail('expected a validation error');
};

describe('integerString', () => {
  it('converts digits and rejects everything else as a type problem', () => {
    const schema = object({ n: integerString({ min: 1, max: 10 }) });
    assert.deepEqual(validate(schema, { n: '7' }, 'q'), { n: 7 });
    for (const bad of ['', 'x', '1.5', '-1', ' 1', '1e2', '1234567890123456', 5, ['1', '2'], null]) {
      assert.deepEqual((() => { try { validate(schema, { n: bad }, 'q'); } catch (e) { return (e as { details: unknown }).details; } return undefined; })(), [{ field: 'n', issue: 'type' }], String(bad));
    }
    for (const [bad, issue] of [['0', 'minimum'], ['11', 'maximum']] as const) {
      assert.deepEqual((() => { try { validate(schema, { n: bad }, 'q'); } catch (e) { return (e as { details: unknown }).details; } return undefined; })(), [{ field: 'n', issue }]);
    }
  });
});

describe('listQueryShape and listParamsOf', () => {
  it('applies the defaults', () => {
    assert.deepEqual(listParamsOf(parse({}), config), { limit: DEFAULT_LIMIT, sort: 'name', q: null, cursor: null });
    assert.equal(DEFAULT_LIMIT, 50);
    assert.equal(MAX_LIMIT, 200);
  });

  it('converts and bounds limit, restricts sort to the allowlist and trims q', () => {
    assert.deepEqual(listParamsOf(parse({ limit: '200', sort: '-born', q: '  ada  ' }), config), { limit: 200, sort: '-born', q: 'ada', cursor: null });
    const problems = (raw: Record<string, unknown>) => { try { parse(raw); } catch (e) { return (e as { details: unknown }).details; } return undefined; };
    assert.deepEqual(problems({ limit: '0' }), [{ field: 'limit', issue: 'minimum' }]);
    assert.deepEqual(problems({ limit: '201' }), [{ field: 'limit', issue: 'maximum' }]);
    assert.deepEqual(problems({ limit: ['1', '2'] }), [{ field: 'limit', issue: 'type' }]);
    assert.deepEqual(problems({ sort: 'password' }), [{ field: 'sort', issue: 'enum' }]);
    assert.deepEqual(problems({ sort: '--name' }), [{ field: 'sort', issue: 'enum' }]);
    assert.deepEqual(problems({ sort: ['name', '-name'] }), [{ field: 'sort', issue: 'type' }]);
    assert.deepEqual(problems({ q: '   ' }), [{ field: 'q', issue: 'minLength' }]);
    assert.deepEqual(problems({ q: 'x'.repeat(65) }), [{ field: 'q', issue: 'maxLength' }]);
    assert.deepEqual(problems({ cursor: '' }), [{ field: 'cursor', issue: 'minLength' }]);
    assert.deepEqual(problems({ cursor: 'x'.repeat(2201) }), [{ field: 'cursor', issue: 'maxLength' }]);
    assert.deepEqual(problems({ other: '1' }), [{ field: 'other', issue: 'unknown' }]);
  });

  it('decodes a cursor it issued, for the sort it was issued for', () => {
    const asc = cursorAfter('name', { _id: ID, name: 'ada' });
    assert.deepEqual(listParamsOf(parse({ cursor: asc }), config).cursor, { value: 'ada', id: ID });
    const nullValue = cursorAfter('name', { _id: ID });
    assert.deepEqual(listParamsOf(parse({ cursor: nullValue }), config).cursor, { value: null, id: ID });
    const date = cursorAfter('-born', { _id: ID, born: new Date(1000) });
    assert.deepEqual(listParamsOf(parse({ cursor: date, sort: '-born' }), config).cursor, { value: 1000, id: ID });
    const nested = cursorAfter('nested', { _id: ID, a: { b: 'deep' } });
    assert.deepEqual(listParamsOf(parse({ cursor: nested, sort: 'nested' }), config).cursor, { value: 'deep', id: ID });
    assert.equal(cursorAfter('nested', { _id: ID, a: 'flat' }) !== '', true);
    assert.deepEqual(listParamsOf(parse({ cursor: cursorAfter('nested', { _id: ID, a: 'flat' }), sort: 'nested' }), config).cursor, { value: null, id: ID });
  });

  it('refuses every cursor that is not exactly one it issued for this sort, with 422 cursor/format', () => {
    const encode = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
    const good = { ver: 1, s: 'name', v: 'ada', id: ID.toHexString() };
    const bad: Array<[string, string, string?]> = [
      ['alphabet', 'not*base64'],
      ['padding', `${encode(good)}=`],
      ['not json', encode('{nope')],
      ['not an object', encode('"text"')],
      ['an array', encode([1])],
      ['null', encode('null')],
      ['another version', encode({ ...good, ver: 2 })],
      ['missing key', encode({ ver: 1, s: 'name', v: 'ada' })],
      ['extra key', encode({ ...good, extra: 1 })],
      ['another sort', encode({ ...good, s: '-name' })],
      ['unknown sort', encode({ ...good, s: 'password' })],
      ['bad id', encode({ ...good, id: 'zz' })],
      ['uppercase id', encode({ ...good, id: ID.toHexString().toUpperCase() })],
      ['id not a string', encode({ ...good, id: 5 })],
      ['number for a string field', encode({ ...good, v: 5 })],
      ['object value', encode({ ...good, v: {} })],
      ['too long value', encode({ ...good, v: 'x'.repeat(257) })],
      ['ill-formed text', encode({ ...good, v: '\ud800' })],
      ['text for a date field', encode({ ...good, s: 'born', v: 'now' }), 'born'],
      ['fraction for a date field', encode({ ...good, s: 'born', v: 1.5 }), 'born'],
      ['unsafe integer for a date field', encode({ ...good, s: 'born', v: 2 ** 60 }), 'born'],
      ['date out of range', encode({ ...good, s: 'born', v: 8.64e15 + 1 }), 'born'],
    ];
    for (const [label, cursor, sort] of bad) {
      assert.deepEqual(failure({ cursor, ...(sort === undefined ? {} : { sort }) }), [{ field: 'cursor', issue: 'format' }], label);
    }
    // Control: the good one passes.
    assert.deepEqual(listParamsOf(parse({ cursor: encode(good) }), config).cursor, { value: 'ada', id: ID });
  });
});

describe('listSearch, listPipeline and pageOf', () => {
  const params = (overrides: Partial<ListParams> = {}): ListParams => ({ limit: 2, sort: 'name', q: null, cursor: null, ...overrides });
  const projection = { name: 1 } as const;
  const stages = (overrides: Partial<ListParams> = {}) => listPipeline({ scope: true }, params(overrides), config, projection);

  it('has no search condition without a text, and searches the declared fields with it escaped', () => {
    assert.deepEqual(listSearch(params(), config), {});
    assert.equal(escapeRegExp('a.b*(c)[d]\\'), 'a\\.b\\*\\(c\\)\\[d\\]\\\\');
    assert.deepEqual(listSearch(params({ q: 'a.b' }), config), { $or: [{ name: { $regex: 'a\\.b', $options: 'i' } }, { email: { $regex: 'a\\.b', $options: 'i' } }] });
  });

  it('reads one more than the page, sorted by the computed key and the id in the same direction, after the match', () => {
    const asc = stages();
    assert.deepEqual(asc[0], { $match: { scope: true } });
    assert.deepEqual(asc.slice(2), [{ $sort: { [SORT_KEY]: 1, _id: 1 } }, { $limit: 3 }, { $project: { name: 1, [SORT_KEY]: 1 } }]);
    assert.deepEqual(stages({ sort: '-born', limit: 7 }).slice(2), [{ $sort: { [SORT_KEY]: -1, _id: -1 } }, { $limit: 8 }, { $project: { name: 1, [SORT_KEY]: 1 } }]);
  });

  it('computes the key as the stored value only when it has the type the sort expects', () => {
    assert.deepEqual((stages()[1] as { $addFields: Record<string, unknown> }).$addFields[SORT_KEY], {
      $cond: [{ $and: [{ $eq: [{ $type: '$name' }, 'string'] }, { $lte: [{ $strLenBytes: '$name' }, MAX_CURSOR_VALUE_BYTES] }] }, '$name', null],
    });
    assert.deepEqual((stages({ sort: 'born' })[1] as { $addFields: Record<string, unknown> }).$addFields[SORT_KEY], { $cond: [{ $eq: [{ $type: '$born' }, 'date'] }, '$born', null] });
    assert.deepEqual((stages({ sort: 'nested' })[1] as { $addFields: Record<string, unknown> }).$addFields[SORT_KEY], {
      $cond: [{ $and: [{ $eq: [{ $type: '$a.b' }, 'string'] }, { $lte: [{ $strLenBytes: '$a.b' }, MAX_CURSOR_VALUE_BYTES] }] }, '$a.b', null],
    });
  });

  it('continues after the cursor in every direction, with and without a value, on the computed key', () => {
    const later = (value: unknown, operator: string) => [{ [SORT_KEY]: { [operator]: value } }, { [SORT_KEY]: value, _id: { [operator]: ID } }];
    const cursorStage = (overrides: Partial<ListParams>) => stages(overrides)[2];
    assert.deepEqual(cursorStage({ cursor: { value: 'ada', id: ID } }), { $match: { $or: later('ada', '$gt') } });
    assert.deepEqual(cursorStage({ sort: '-name', cursor: { value: 'ada', id: ID } }), { $match: { $or: [...later('ada', '$lt'), { [SORT_KEY]: null }] } });
    assert.deepEqual(cursorStage({ sort: 'born', cursor: { value: 1000, id: ID } }), { $match: { $or: later(new Date(1000), '$gt') } });
    // No value: the missing ones come first ascending and last descending.
    assert.deepEqual(cursorStage({ cursor: { value: null, id: ID } }), { $match: { $or: [{ [SORT_KEY]: null, _id: { $gt: ID } }, { [SORT_KEY]: { $ne: null } }] } });
    assert.deepEqual(cursorStage({ sort: '-name', cursor: { value: null, id: ID } }), { $match: { [SORT_KEY]: null, _id: { $lt: ID } } });
    assert.equal(stages().length, 5, 'no cursor stage without a cursor');
    assert.equal(stages({ cursor: { value: null, id: ID } }).length, 6);
  });

  it('cuts the page, and issues a cursor only when something follows', () => {
    const docs = [1, 2, 3].map((n) => ({ _id: new ObjectId(), [SORT_KEY]: `n${String(n)}` }));
    const first = pageOf(docs, params());
    assert.deepEqual(first.items, docs.slice(0, 2));
    assert.equal(first.page.limit, 2);
    assert.deepEqual(listParamsOf(parse({ cursor: first.page.next! }), config).cursor, { value: 'n2', id: docs[1]!['_id'] });
    const last = pageOf(docs.slice(0, 2), params());
    assert.deepEqual(last.page, { limit: 2, next: null });
    assert.deepEqual(pageOf([], params()).page, { limit: 2, next: null });
    // A date key travels as milliseconds, a missing one as null.
    const dated = pageOf([{ _id: ID, [SORT_KEY]: new Date(5) }, { _id: new ObjectId() }], params({ limit: 1, sort: 'born' }));
    assert.deepEqual(listParamsOf(parse({ cursor: dated.page.next!, sort: 'born' }), config).cursor, { value: 5, id: ID });
    const missing = pageOf([{ _id: ID }, { _id: new ObjectId() }], params({ limit: 1 }));
    assert.deepEqual(listParamsOf(parse({ cursor: missing.page.next! }), config).cursor, { value: null, id: ID });
  });

  it('sizes the cursor limit for the worst value: 256 escaped control characters round-trip and fit', () => {
    const worst = '\u0001'.repeat(MAX_CURSOR_VALUE_BYTES);
    const next = pageOf([{ _id: ID, [SORT_KEY]: worst }, { _id: new ObjectId() }], params({ limit: 1 })).page.next!;
    assert.ok(next.length <= MAX_CURSOR_LENGTH, String(next.length));
    assert.deepEqual(listParamsOf(parse({ cursor: next }), config).cursor, { value: worst, id: ID });
    const multiByte = '\u20ac'.repeat(Math.floor(MAX_CURSOR_VALUE_BYTES / 3));
    assert.deepEqual(listParamsOf(parse({ cursor: pageOf([{ _id: ID, [SORT_KEY]: multiByte }, { _id: new ObjectId() }], params({ limit: 1 })).page.next! }), config).cursor, { value: multiByte, id: ID });
    // One byte over is not a cursor this server issues.
    const over = Buffer.from(JSON.stringify({ ver: 1, s: 'name', v: 'a'.repeat(MAX_CURSOR_VALUE_BYTES + 1), id: ID.toHexString() })).toString('base64url');
    assert.deepEqual(failure({ cursor: over }), [{ field: 'cursor', issue: 'format' }]);
  });
});
