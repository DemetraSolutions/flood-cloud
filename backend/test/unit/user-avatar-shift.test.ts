import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_MAX_BYTES, avatarFingerprint, checkAvatar } from '../../src/modules/users/avatar.ts';
import { applyShiftTime, completeWeek, diffShiftTime, emptyShiftTime, readShiftTime, shiftTimeIssues, shiftTimeSetPaths, toLegacyShiftTime } from '../../src/modules/users/shift-time.ts';
import type { ShiftTime, ShiftWeek } from '../../src/modules/users/shift-time.ts';
import type { UserAnomaly } from '../../src/modules/users/user.types.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), Buffer.from([9])]);
const url = (type: string, bytes: Buffer): string => `data:image/${type};base64,${bytes.toString('base64')}`;

describe('checkAvatar', () => {
  it('accepts PNG, JPEG and WebP whose bytes are what the prefix says', () => {
    assert.deepEqual(checkAvatar(url('png', PNG)), { ok: true });
    assert.deepEqual(checkAvatar(url('jpeg', JPEG)), { ok: true });
    assert.deepEqual(checkAvatar(url('webp', WEBP)), { ok: true });
  });

  it('refuses SVG, other types, a missing prefix and a prefix that lies about the content', () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
    for (const value of [svg, 'data:image/gif;base64,R0lG', 'image/png;base64,AAAA', 'http://x/y.png', '', url('png', JPEG), url('jpeg', PNG), url('webp', PNG), url('png', Buffer.from('RIFF....WEBX')), url('png', Buffer.from([0x89, 0x50]))]) {
      assert.deepEqual(checkAvatar(value), { ok: false, issue: 'format' }, value.slice(0, 40));
    }
  });

  it('refuses base64 that is invalid or not canonical', () => {
    const good = PNG.toString('base64');
    for (const payload of ['', '!!!!', good.slice(0, -1), `${good}=`, `${good.slice(0, -2)}=`, 'iVBORw0KGgp=', 'iVBO Rw0K']) {
      assert.deepEqual(checkAvatar(`data:image/png;base64,${payload}`), { ok: false, issue: 'format' }, payload);
    }
  });

  it('refuses a picture over 200 KB of decoded data, at the byte', () => {
    const body = (size: number): Buffer => Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]);
    assert.deepEqual(checkAvatar(url('png', body(AVATAR_MAX_BYTES))), { ok: true });
    assert.deepEqual(checkAvatar(url('png', body(AVATAR_MAX_BYTES + 1))), { ok: false, issue: 'maximum' });
    assert.deepEqual(checkAvatar(url('png', body(AVATAR_MAX_BYTES + 10))), { ok: false, issue: 'maximum' });
  });

  it('gives a short stable fingerprint', () => {
    assert.match(avatarFingerprint('a'), /^[0-9a-f]{16}$/);
    assert.equal(avatarFingerprint('a'), avatarFingerprint('a'));
    assert.notEqual(avatarFingerprint('a'), avatarFingerprint('b'));
  });
});

const read = (raw: unknown): { shift: ShiftTime; anomalies: UserAnomaly[] } => {
  const anomalies: UserAnomaly[] = [];
  return { shift: readShiftTime(raw, anomalies), anomalies };
};
const day = { active: true, values: [{ start: '09:00', end: '13:00' }] };

describe('readShiftTime', () => {
  it('reads a missing or null value as no shifts, and an irregular one with a remark', () => {
    for (const raw of [undefined, null]) {
      assert.deepEqual(read(raw), { shift: emptyShiftTime(), anomalies: [] });
    }
    assert.deepEqual(read(0), { shift: emptyShiftTime(), anomalies: [{ kind: 'invalidType', field: 'shiftTime' }] });
    assert.deepEqual(read([]).shift, emptyShiftTime());
  });

  it('reads the current format, with dates, days, slots and special days sorted by date', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const { shift, anomalies } = read({
      status: true,
      weeksGeneric: [{ start, end: new Date('2026-02-01T00:00:00.000Z'), days: { 1: day, 2: { active: false, values: [] } } }, { start: null, end: null, days: {} }],
      daySpecial: { '2026-12-25': { free: true, values: [] }, '2026-01-06': { free: false, values: [{ start: '10:00', end: '12:00' }] } },
    });
    assert.deepEqual(anomalies, []);
    assert.equal(shift.enabled, true);
    assert.deepEqual(shift.weeks[0]!.from, start);
    assert.deepEqual(shift.weeks[0]!.days['1'], { active: true, slots: [{ start: '09:00', end: '13:00' }] });
    assert.deepEqual(shift.weeks[0]!.days['0'], { active: false, slots: [] });
    assert.deepEqual([shift.weeks[1]!.from, shift.weeks[1]!.to], [null, null]);
    assert.deepEqual(shift.specialDays.map((entry) => [entry.date, entry.dayOff]), [['2026-01-06', false], ['2026-12-25', true]]);
  });

  it('tolerates the misspelt status, the older weekGeneric format, dates as text and bad dates', () => {
    assert.equal(read({ ststus: true }).shift.enabled, true);
    assert.equal(read({ status: false, ststus: true }).shift.enabled, false);
    assert.equal(read({ status: 'x', ststus: 'y' }).shift.enabled, false);
    const old = read({ ststus: false, weekGeneric: { 1: day }, daySpecial: {} });
    assert.deepEqual(old.shift.weeks.map((week) => [week.from, week.to, week.days['1'].active]), [[null, null, true]]);
    const dated = read({ status: true, weeksGeneric: [{ start: '2026-03-01T00:00:00.000Z', end: 'nope', days: {} }] }).shift.weeks[0]!;
    assert.deepEqual([dated.from?.toISOString(), dated.to], ['2026-03-01T00:00:00.000Z', null]);
  });

  it('leaves out and reports what is not a block, a day, a slot or a special day, and the excess', () => {
    const bad = read({
      weeksGeneric: ['x', { days: { 1: { active: true, values: [{ start: '9:00', end: '10:00' }, 'x'] }, 2: 'y' } }],
      daySpecial: { 'not-a-date': { free: true }, '2026-05-05': 'x', '2026-05-06': { free: true }, '2026-05-07': { free: false, values: 'x' } },
    });
    assert.equal(bad.shift.weeks.length, 1);
    assert.deepEqual(bad.shift.weeks[0]!.days['1'], { active: true, slots: [] });
    assert.deepEqual(bad.shift.specialDays.map((entry) => [entry.date, entry.dayOff, entry.slots.length]), [['2026-05-06', true, 0], ['2026-05-07', false, 0]]);
    assert.ok(bad.anomalies.length >= 5);
    assert.deepEqual(read({ weeksGeneric: [{ days: 'x' }] }).shift.weeks[0]!.days['1'], { active: false, slots: [] });
    const weeks = Array.from({ length: 25 }, () => ({ days: {} }));
    const many = read({ weeksGeneric: weeks, daySpecial: {} });
    assert.equal(many.shift.weeks.length, 20);
    assert.deepEqual(many.anomalies, [{ kind: 'invalidType', field: 'shiftTime' }]);
    const slots = Array.from({ length: 12 }, (_, index) => ({ start: '08:00', end: `0${String(index % 9 + 9).padStart(2, '0')}:00`.slice(-5) }));
    assert.equal(read({ weeksGeneric: [{ days: { 1: { active: true, values: slots } } }] }).shift.weeks[0]!.days['1'].slots.length, 10);
    const days = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), { free: true, values: [] }]));
    assert.equal(read({ daySpecial: days }).shift.specialDays.length, 366);
  });
});

describe('shift patches', () => {
  const week: ShiftWeek = completeWeek({ from: null, to: null, days: { 1: { active: true, slots: [{ start: '09:00', end: '13:00' }] } } });

  it('completes the days of a block and applies a patch as whole lists', () => {
    assert.deepEqual(week.days['3'], { active: false, slots: [] });
    assert.deepEqual(completeWeek({ days: {} }).from, null);
    const base: ShiftTime = { enabled: false, weeks: [week], specialDays: [] };
    assert.deepEqual(applyShiftTime(base, undefined), base);
    assert.equal(applyShiftTime(base, { enabled: true }).enabled, true);
    assert.deepEqual(applyShiftTime(base, { weeks: [] }).weeks, []);
    const days = applyShiftTime(base, { specialDays: [{ date: '2026-12-25', dayOff: true, slots: [] }, { date: '2026-01-01', dayOff: true, slots: [] }] }).specialDays;
    assert.deepEqual(days.map((entry) => entry.date), ['2026-01-01', '2026-12-25']);
  });

  it('diffs only what changed', () => {
    const base: ShiftTime = { enabled: false, weeks: [week], specialDays: [] };
    assert.equal(diffShiftTime(base, applyShiftTime(base, { enabled: false, weeks: [week] })), undefined);
    const next = applyShiftTime(base, { enabled: true, weeks: [], specialDays: [{ date: '2026-12-25', dayOff: true, slots: [] }] });
    assert.deepEqual(Object.keys(diffShiftTime(base, next)!), ['enabled', 'weeks', 'specialDays']);
    assert.deepEqual(Object.keys(diffShiftTime(base, { ...base, enabled: true })!), ['enabled']);
  });

  it('writes the legacy names, path by path', () => {
    assert.deepEqual(shiftTimeSetPaths({}), {});
    const set = shiftTimeSetPaths({ enabled: true, weeks: [{ days: { 1: week.days['1'] } }], specialDays: [{ date: '2026-12-25', dayOff: true, slots: [{ start: '10:00', end: '11:00' }] }] });
    assert.equal(set['shiftTime.status'], true);
    const stored = (set['shiftTime.weeksGeneric'] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([stored['start'], stored['end'], Object.keys(stored['days'] as object)], [null, null, ['0', '1', '2', '3', '4', '5', '6']]);
    assert.deepEqual((stored['days'] as Record<string, unknown>)['1'], { active: true, values: [{ start: '09:00', end: '13:00' }] });
    assert.deepEqual(set['shiftTime.daySpecial'], { '2026-12-25': { free: true, values: [{ start: '10:00', end: '11:00' }] } });
    assert.deepEqual(toLegacyShiftTime(emptyShiftTime()), { status: false, weeksGeneric: [], daySpecial: {} });
  });
});

describe('shiftTimeIssues', () => {
  const at = (from: string | null, to: string | null, slots = [{ start: '09:00', end: '13:00' }]): ShiftWeek =>
    completeWeek({ from: from === null ? null : new Date(from), to: to === null ? null : new Date(to), days: { 1: { active: true, slots } } });
  const shift = (weeks: ShiftWeek[], specialDays: ShiftTime['specialDays'] = []): ShiftTime => ({ enabled: true, weeks, specialDays });

  it('accepts one default block, dated blocks that do not overlap and special days', () => {
    assert.deepEqual(shiftTimeIssues(shift([at(null, null), at('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z'), at('2026-02-01T00:00:00.000Z', '2026-02-28T00:00:00.000Z')], [{ date: '2026-12-25', dayOff: false, slots: [{ start: '10:00', end: '12:00' }] }])), []);
  });

  it('refuses a second default, a block with one date only, reversed dates, overlaps and a bad slot', () => {
    assert.deepEqual(shiftTimeIssues(shift([at(null, null), at(null, null)])), [{ field: 'shiftTime.weeks.1', issue: 'incorrect' }]);
    assert.deepEqual(shiftTimeIssues(shift([at('2026-01-01T00:00:00.000Z', null), at(null, '2026-01-01T00:00:00.000Z')])), [
      { field: 'shiftTime.weeks.0.to', issue: 'required' },
      { field: 'shiftTime.weeks.1.from', issue: 'required' },
    ]);
    assert.deepEqual(shiftTimeIssues(shift([at('2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')])), [{ field: 'shiftTime.weeks.0.to', issue: 'incorrect' }]);
    assert.deepEqual(shiftTimeIssues(shift([at('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z'), at('2026-01-31T00:00:00.000Z', '2026-02-10T00:00:00.000Z')])), [{ field: 'shiftTime.weeks.1', issue: 'incorrect' }]);
    assert.deepEqual(shiftTimeIssues(shift([at(null, null, [{ start: '13:00', end: '13:00' }])])), [{ field: 'shiftTime.weeks.0.days.1.slots.0.end', issue: 'incorrect' }]);
    assert.deepEqual(shiftTimeIssues(shift([], [{ date: '2026-12-25', dayOff: true, slots: [] }, { date: '2026-12-25', dayOff: true, slots: [{ start: '12:00', end: '11:00' }] }]), 'x'), [
      { field: 'x.specialDays.1.date', issue: 'incorrect' },
      { field: 'x.specialDays.1.slots.0.end', issue: 'incorrect' },
    ]);
  });
});
