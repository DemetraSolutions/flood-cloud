import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FindOutcome, InvoiceRef } from '../../src/providers/types.ts';
import { createArubaRig, live, TEST_PASSWORD } from '../helpers/aruba.ts';
import type { ArubaRig } from '../helpers/aruba.ts';
import type { Reply } from '../helpers/fake-aruba.ts';
import { T0 } from '../helpers/world.ts';

const SEARCH = 'GET /api/v2/invoices-out';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ref = (values: Partial<InvoiceRef> = {}): InvoiceRef => ({ queueId: '0123456789abcdef01234567', sellerVat: 'IT01234567890', number: '42', date: '2026-11-27', progressive: '7', documentType: 'TD01', since: T0 - 5 * MINUTE, ...values });
const entry = (filename: string, number: string, invoiceDate: string, extra: Record<string, unknown> = {}) => ({ filename, invoices: [{ number, invoiceDate, ...extra }] });
/** A page of results; by default the last one. */
const page = (content: unknown[], extra: Record<string, unknown> = {}): Reply => ({ json: { content, last: true, ...extra } });
const full = (): unknown[] => Array.from({ length: 100 }, (_, index) => entry(`f${index}.xml`, `n${index}`, '2026-11-27'));
const retried = (afterMs: number, code: string, slice = 0, pageNumber = 1): FindOutcome => ({ kind: 'retry', afterMs, code, resume: { slice, page: pageNumber } });

describe('Aruba: findSent', () => {
  let rig: ArubaRig;
  const find = (values: Partial<InvoiceRef> = {}, signal: AbortSignal = live()): Promise<FindOutcome> => rig.adapter.findSent(rig.account, ref(values), signal);
  /** A rig whose waits take no (virtual) time, to read many pages within the budget. */
  const patientRig = (): Promise<ArubaRig> => createArubaRig({ deps: { sleep: async () => undefined } });

  beforeEach(async () => {
    rig = await createArubaRig({ deps: { timeouts: { upload: 300, request: 300 } } });
  });
  afterEach(async () => {
    await rig.close();
  });

  it('searches the seller\'s sent invoices from an hour before the first attempt to now, with every value encoded', async () => {
    rig.fake.route(SEARCH, page([]));
    assert.deepEqual(await find(), { kind: 'notFound' });
    const [hit] = rig.fake.hits(SEARCH);
    assert.deepEqual(Object.fromEntries(hit?.query ?? []), {
      senderCountry: 'IT',
      senderVatcode: '01234567890',
      creationStartDate: new Date(T0 - 5 * MINUTE - HOUR).toISOString(),
      creationEndDate: new Date(T0).toISOString(),
      page: '1',
      size: '100',
    });
    assert.match(hit?.rawQuery ?? '', /creationStartDate=2026-11-27T10%3A55%3A00\.000Z&creationEndDate=2026-11-27T12%3A00%3A00\.000Z/, 'the colons are encoded');
    assert.equal(hit?.headers['authorization'], 'Bearer access-token-1');
  });

  it('matches number, invoice date (a date or a date with time and offset, in Rome) and, when given, the document type', async () => {
    const content = [
      entry('other-number.xml', '43', '2026-11-27'),
      entry('other-day.xml', '42', '2026-11-26'),
      entry('credit-note.xml', '42', '2026-11-27', { docType: 'TD04' }),
      entry('other-type.xml', '42', '2026-11-27', { invoiceType: 'td02' }),
      entry('bad-date.xml', '42', 'yesterday'),
      { filename: 'no-invoices.xml' },
      'text',
      { filename: 'bad-list.xml', invoices: 'x' },
      { filename: 'not-an-invoice.xml', invoices: ['x', null] },
      entry('IT01234567890_found.xml', ' 42 ', '2026-11-26T23:30:00.000Z', { docType: 'td01', invoiceType: 'FPR12' }),
    ];
    rig.fake.route(SEARCH, page(content));
    assert.deepEqual(await find(), { kind: 'found', providerId: 'IT01234567890_found.xml' });
    rig.fake.route(SEARCH, page([entry('plain-date.xml', '42', '2026-11-27')]));
    assert.deepEqual(await find(), { kind: 'found', providerId: 'plain-date.xml' }, 'no document type given: not used');
    rig.fake.route(SEARCH, page([{ filename: 'number-as-text.xml', invoices: [{ number: 42, invoiceDate: '2026-11-27' }] }]));
    assert.deepEqual(await find(), { kind: 'found', providerId: 'number-as-text.xml' });
  });

  it('is not fooled by a number that only starts like ours', async () => {
    rig.fake.route(SEARCH, page([entry('x.xml', '421', '2026-11-27'), entry('y.xml', '4', '2026-11-27')]));
    assert.deepEqual(await find(), { kind: 'notFound' });
  });

  it('does not use a file name it cannot trust: a person must look, retry in an hour', async () => {
    for (const filename of ['has space.xml', 'a/b.xml', 7, undefined]) {
      rig.fake.route(SEARCH, page([{ filename, invoices: [{ number: '42', invoiceDate: '2026-11-27' }] }]));
      assert.deepEqual(await find(), retried(HOUR, 'INVALID_PROVIDER_ID'));
    }
    assert.equal(rig.log.messages('error').length, 4);
  });

  describe('where a slice ends (only a complete search may say notFound)', () => {
    it('stops on last === true, or when number + 1 reaches totalPages', async () => {
      rig.fake.route(SEARCH, page(full(), { last: true }));
      assert.deepEqual(await find(), { kind: 'notFound' });
      assert.equal(rig.fake.hits(SEARCH).length, 1);
      rig.fake.requests.length = 0;
      rig.fake.route(SEARCH, page(full(), { last: false, number: 2, totalPages: 3 }));
      assert.deepEqual(await find(), { kind: 'notFound' });
      assert.equal(rig.fake.hits(SEARCH).length, 1, 'the totals say it is the last page, whatever last says');
    });

    it('reads the next pages while the totals say there are more, and finds the file on the third', async () => {
      rig.fake.route(SEARCH, (request) => {
        const number = Number(request.query.get('page'));
        return page(number === 3 ? [entry('third.xml', '42', '2026-11-27')] : full(), { last: false, number, totalPages: 5 });
      });
      assert.deepEqual(await find(), { kind: 'found', providerId: 'third.xml' });
      assert.deepEqual(rig.fake.hits(SEARCH).map((hit) => hit.query.get('page')), ['1', '2', '3']);
      assert.deepEqual(rig.clock.waits, [6000], 'the engine paid for the first request; the second took a free turn, the third waited for it');
    });

    it('without totals, last: false means more, a full page means more and a short page after the first means last', async () => {
      const patient = await patientRig();
      try {
        patient.fake.route(SEARCH, (request) => (request.query.get('page') === '3' ? { json: { content: [] } } : request.query.get('page') === '2' ? { json: { content: full() } } : { json: { content: [], last: false } }));
        assert.deepEqual(await patient.adapter.findSent(patient.account, ref(), live()), { kind: 'notFound' });
        assert.deepEqual(patient.fake.hits(SEARCH).map((hit) => hit.query.get('page')), ['1', '2', '3']);
      } finally {
        await patient.close();
      }
    });

    it('is unknown, never notFound, when nothing says whether a short first page is the last (Aruba may have capped the size)', async () => {
      rig.fake.route(SEARCH, { json: { content: [entry('x.xml', '1', '2026-11-27')] } });
      assert.deepEqual(await find(), { kind: 'unknown' });
      rig.fake.route(SEARCH, { json: { content: [] } });
      assert.deepEqual(await find(), { kind: 'unknown' });
    });

    it('is unknown when a slice still has more pages after the tenth', async () => {
      const patient = await patientRig();
      try {
        patient.fake.route(SEARCH, (request) => page(full(), { last: false, number: Number(request.query.get('page')), totalPages: 99 }));
        assert.deepEqual(await patient.adapter.findSent(patient.account, ref(), live()), { kind: 'unknown' });
        assert.equal(patient.fake.hits(SEARCH).length, 10);
        assert.deepEqual(patient.log.messages('warn'), ['a slice of the search has more pages than the worker reads: a person must check the file']);
      } finally {
        await patient.close();
      }
    });

    it('detects an API that counts pages from zero (page 1 answers number 1, first false) and reads the slice again from page 0', async () => {
      rig.fake.route(SEARCH, (request) => {
        const number = Number(request.query.get('page'));
        return page(number === 0 ? [entry('zero.xml', '42', '2026-11-27')] : [entry('x.xml', '1', '2026-11-27')], { last: number >= 1, number, first: number === 0, totalPages: 2 });
      });
      assert.deepEqual(await find(), { kind: 'found', providerId: 'zero.xml' });
      assert.deepEqual(rig.fake.hits(SEARCH).map((hit) => hit.query.get('page')), ['1', '0']);
      rig.fake.requests.length = 0;
      rig.fake.route(SEARCH, (request) => {
        const number = Number(request.query.get('page'));
        return page([], { last: number >= 1, number, first: number === 0, totalPages: 2 });
      });
      rig.clock.advance(MINUTE);
      assert.deepEqual(await find(), { kind: 'notFound' });
      assert.deepEqual(rig.fake.hits(SEARCH).map((hit) => hit.query.get('page')), ['1', '0', '1'], 'page 0, then the rest from 1 (page 1 is read again)');
    });

    it('does not mistake a one-based API for a zero-based one', async () => {
      rig.fake.route(SEARCH, page([], { number: 1, first: true, totalPages: 1 }));
      assert.deepEqual(await find(), { kind: 'notFound' });
      assert.equal(rig.fake.hits(SEARCH).length, 1);
    });
  });

  describe('time slices', () => {
    it('cuts a long window in slices of less than two days, oldest first, and stops at the first hit', async () => {
      rig.fake.route(SEARCH, (request) => (request.query.get('creationStartDate')?.startsWith('2026-11-25') ? page([entry('old.xml', '42', '2026-11-27')]) : page([])));
      assert.deepEqual(await find({ since: T0 - 5 * DAY }), { kind: 'notFound' }, 'not in the first slices');
      const starts = rig.fake.hits(SEARCH).map((hit) => hit.query.get('creationStartDate'));
      const ends = rig.fake.hits(SEARCH).map((hit) => hit.query.get('creationEndDate'));
      assert.equal(starts.length, 3);
      for (let index = 0; index < starts.length; index += 1) {
        const span = Date.parse(ends[index] as string) - Date.parse(starts[index] as string);
        assert.ok(span > 0 && span < 2 * DAY, `slice ${index}`);
      }
      assert.equal(ends[2], new Date(T0).toISOString(), 'the last slice ends now');
      assert.equal(starts[1], ends[0], 'slices follow one another');
      rig.fake.requests.length = 0;
      const windowStart = T0 - 4 * DAY - HOUR;
      rig.fake.route(SEARCH, (request) => (Math.floor((Date.parse(request.query.get('creationStartDate') as string) - windowStart) / (47 * HOUR)) === 1 ? page([entry('second-slice.xml', '42', '2026-11-27')]) : page([])));
      rig.clock.advance(10_000);
      assert.deepEqual(await find({ since: T0 - 4 * DAY }), { kind: 'found', providerId: 'second-slice.xml' });
      assert.equal(rig.fake.hits(SEARCH).length, 2, 'the search stopped at the hit');
    });

    it('does not claim to have searched a window of more than seven slices: unknown, logged, nothing asked', async () => {
      assert.deepEqual(await find({ since: T0 - 14 * DAY - HOUR }), { kind: 'unknown' });
      assert.equal(rig.fake.requests.length, 0);
      assert.deepEqual(rig.log.messages('warn'), ['the file is too old to be searched at Aruba: a person must check it']);
      const patient = await patientRig();
      try {
        patient.fake.route(SEARCH, page([]));
        assert.deepEqual(await patient.adapter.findSent(patient.account, ref({ since: T0 - 13 * DAY }), live()), { kind: 'notFound' }, 'seven slices are searched');
        assert.equal(patient.fake.hits(SEARCH).length, 7);
      } finally {
        await patient.close();
      }
    });

    it('gives a window that is empty or in the future one request, not an inverted one', async () => {
      rig.fake.route(SEARCH, page([]));
      assert.deepEqual(await find({ since: T0 + 3 * HOUR }), { kind: 'notFound' });
      const [hit] = rig.fake.hits(SEARCH);
      assert.ok(Date.parse(hit?.query.get('creationEndDate') as string) >= Date.parse(hit?.query.get('creationStartDate') as string));
    });
  });

  describe('budget and resume', () => {
    it('never blocks longer than the caps: no wait over ten seconds, and at most 25 seconds of work in all', async () => {
      rig.fake.route(SEARCH, (request) => page(full(), { last: false, number: Number(request.query.get('page')), totalPages: 99 }));
      const outcome = await find({ since: T0 - 5 * DAY });
      assert.equal(outcome.kind === 'retry' ? outcome.code : outcome.kind, 'FIND_BUDGET');
      assert.ok(rig.clock.waits.length > 0 && rig.clock.waits.every((wait) => wait <= 10_000));
      assert.ok(rig.clock.now() - T0 <= 25_000, 'the whole call stays inside the budget');
      rig.clock.advance(MINUTE);
      await rig.limiters.coolDown('ip:aruba:status', rig.clock.now() + 9_000);
      const waitsBefore = rig.clock.waits.length;
      await find();
      assert.ok(rig.clock.waits.slice(waitsBefore).every((wait) => wait <= 10_000));
    });

    it('checks the budget before every request, the first included, and carries the position to resume from', async () => {
      rig.fake.route(SEARCH, () => {
        rig.clock.advance(26_000);
        return page(full(), { last: false, number: 1, totalPages: 9 });
      });
      assert.deepEqual(await find(), retried(60_000, 'FIND_BUDGET', 0, 2));
      assert.equal(rig.fake.hits(SEARCH).length, 1);
    });

    it('goes on from the resume point instead of starting over', async () => {
      rig.fake.route(SEARCH, page([entry('late.xml', '42', '2026-11-27')]));
      assert.deepEqual(await find({ since: T0 - 4 * DAY, resume: { slice: 2, page: 4 } }), { kind: 'found', providerId: 'late.xml' });
      const [hit] = rig.fake.hits(SEARCH);
      assert.equal(hit?.query.get('page'), '4');
      assert.equal(rig.fake.hits(SEARCH).length, 1, 'the slices before the resume point are not searched again');
      const windowStart = T0 - 4 * DAY - HOUR;
      assert.equal(Date.parse(hit?.query.get('creationStartDate') as string), windowStart + 2 * 47 * HOUR);
    });

    it('does not shorten the searched window by resuming: later slices still follow', async () => {
      rig.fake.route(SEARCH, page([]));
      assert.deepEqual(await find({ since: T0 - 4 * DAY, resume: { slice: 1, page: 1 } }), { kind: 'notFound' });
      assert.equal(rig.fake.hits(SEARCH).length, 2);
    });
  });

  it('spaces the requests after the first by the per-IP status limiter and records them', async () => {
    rig.fake.route(SEARCH, (request) => page(full(), { last: false, number: Number(request.query.get('page')), totalPages: 99 }));
    await find();
    assert.ok(rig.clock.waits.length >= 1 && rig.clock.waits.every((wait) => wait === 6000));
    assert.ok(rig.limiters.gate('ip:aruba:status', { minIntervalMs: 6000, jitterMs: 0, maxPerHour: null, maxPerYear: null }, rig.clock.now()).at > rig.clock.now());
  });

  it('on 429 asks to retry, and holds the status limiter for that long', async () => {
    rig.fake.route(SEARCH, { status: 429 });
    assert.deepEqual(await find(), retried(65_000, 'HTTP_429'));
    assert.equal(rig.limiters.gate('ip:aruba:status', { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: null }, rig.clock.now()).at, T0 + 65_000);
  });

  it('on any other failure it asks to retry in a minute, with the position', async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 503 }, 'HTTP_503'],
      [{ status: 400 }, 'HTTP_400'],
      [{ text: '<html>' }, 'MALFORMED'],
      [{ json: ['x'] }, 'MALFORMED'],
      [{ destroy: true }, 'NETWORK_NETWORK'],
      [{ hang: true }, 'NETWORK_TIMEOUT'],
    ];
    for (const [reply, code] of cases) {
      rig.fake.route(SEARCH, reply);
      assert.deepEqual(await find(), retried(60_000, code), code);
    }
    rig.fake.route(SEARCH, { json: { content: 'x', last: true } });
    assert.deepEqual(await find(), { kind: 'notFound' }, 'a complete page without a list of results has no result');
  });

  it('hands back a token problem and a busy limiter, and gives up quietly when the signal fires', async () => {
    rig.fake.route(SEARCH, { status: 401 });
    assert.deepEqual(await find(), retried(MINUTE, 'HTTP_401'));
    rig.fake.route(SEARCH, (request) => page(full(), { last: false, number: Number(request.query.get('page')), totalPages: 99 }));
    rig.clock.advance(70_000);
    await rig.limiters.coolDown('ip:aruba:status', rig.clock.now() + 10 * MINUTE);
    const busy = await find();
    assert.equal(busy.kind === 'retry' ? busy.code : '', 'FIND_BUDGET');
    assert.equal(rig.fake.hits(SEARCH).length, 2, 'the first request of the second call went out, the second was refused');
    assert.deepEqual(await find({}, AbortSignal.abort()), retried(1_000, 'ABORTED'));
    rig.fake.route(SEARCH, { hang: true });
    const aborted = new AbortController();
    const pending = find({}, aborted.signal);
    setTimeout(() => aborted.abort(), 30);
    assert.deepEqual(await pending, retried(1_000, 'ABORTED'));
  });

  it('never writes the password, the token or the response in the log', async () => {
    rig.fake.route(SEARCH, [{ status: 500, text: 'corpo-segreto' }, page([{ filename: 'bad name', invoices: [{ number: '42', invoiceDate: '2026-11-27' }] }])]);
    await find();
    await find();
    assert.doesNotMatch(rig.log.lines.join('\n'), new RegExp(`${TEST_PASSWORD}|access-token|corpo-segreto`));
  });
});
