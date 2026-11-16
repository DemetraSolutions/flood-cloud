import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import { PLANS, createPlaceBody, patchPlaceBody, placeParams, placesQuery, putLicenseBody, putOpeningHoursBody } from '../../src/modules/places/places.schemas.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import type { Schema } from '../../src/shared/validation/schema.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const parse = (schema: Schema<unknown>, value: unknown): unknown => validate(schema, value, '(body)');
const details = (schema: Schema<unknown>, value: unknown): unknown => {
  try {
    validate(schema, value, '(body)');
  } catch (error) {
    if (error instanceof AppError) {
      return error.details;
    }
    throw error;
  }
  return null;
};
const issues = (schema: Schema<unknown>, value: unknown, ...expected: Array<[string, string]>): void => assert.deepEqual(details(schema, value), expected.map(([field, issue]) => ({ field, issue })));

const ADDRESS = { street: 'Via Roma 1', postcode: '20100', city: 'Milano', country: 'IT' };
const COMPANY = fixtureId('company', 1).toHexString();
const MINIMUM = { name: 'Bar', companyId: COMPANY, address: ADDRESS };
const CLOSED = { active: false, values: [] };
const week = (overrides: Record<string, unknown> = {}) => ({ '0': CLOSED, '1': CLOSED, '2': CLOSED, '3': CLOSED, '4': CLOSED, '5': CLOSED, '6': CLOSED, ...overrides });
const HOURS = { timezone: 'Europe/Rome', week: week(), special: {}, deliveryTime: { week: week(), special: {} } };

describe('place body: creation and modification', () => {
  it('accepts the name, the company and the address alone on a creation, trimmed', () => {
    assert.deepEqual(parse(createPlaceBody, { name: '  Bar  ', companyId: COMPANY, address: { ...ADDRESS, province: 'MI' } }), { name: 'Bar', companyId: COMPANY, address: { ...ADDRESS, province: 'MI' } });
  });

  it('requires the name, the company and the address of a creation, but not the province', () => {
    issues(createPlaceBody, {}, ['name', 'required'], ['companyId', 'required'], ['address', 'required']);
    issues(createPlaceBody, { ...MINIMUM, address: {} }, ['address.street', 'required'], ['address.postcode', 'required'], ['address.city', 'required'], ['address.country', 'required']);
    issues(createPlaceBody, { ...MINIMUM, name: '   ' }, ['name', 'minLength']);
    issues(createPlaceBody, { ...MINIMUM, companyId: 'ABC' }, ['companyId', 'minLength']);
    issues(createPlaceBody, { ...MINIMUM, companyId: 'z'.repeat(24) }, ['companyId', 'pattern']);
    issues(createPlaceBody, { ...MINIMUM, companyId: new ObjectId().toHexString().toUpperCase() }, ['companyId', 'pattern']);
  });

  it('accepts any subset on a modification, and the empty object (the service refuses it)', () => {
    assert.deepEqual(parse(patchPlaceBody, {}), {});
    assert.deepEqual(parse(patchPlaceBody, { address: { city: 'Roma' }, license: { status: 'disabled' }, openingHours: { timezone: 'UTC' } }), { address: { city: 'Roma' }, license: { status: 'disabled' }, openingHours: { timezone: 'UTC' } });
  });

  it('refuses unknown keys, operators, the group, the id and the read-only fields, at every level', () => {
    for (const body of [{ groupId: COMPANY }, { id: COMPANY }, { trashed: true }, { createdAt: '2026-01-01' }, { integrations: {} }, { devices: [] }, { server: { ip: '1.2.3.4' } }, { $set: { name: 'x' } }, { 'address.city': 'x' }]) {
      assert.ok(Array.isArray(details(patchPlaceBody, body)), JSON.stringify(body));
    }
    issues(patchPlaceBody, { license: { suspendedToday: true } }, ['license.suspendedToday', 'unknown']);
    issues(patchPlaceBody, { openingHours: { deliveryTime: { step: 1 } } }, ['openingHours.deliveryTime.step', 'unknown']);
  });

  it('takes the text fields as the companies do: empty is none, the e-mail is checked and lower case', () => {
    assert.deepEqual(parse(patchPlaceBody, { contactName: '', email: ' Bar@Example.TEST ', phone: '', priceListId: '', ecommercePriceListId: null }), {
      contactName: null,
      email: 'bar@example.test',
      phone: null,
      priceListId: null,
      ecommercePriceListId: null,
    });
    issues(patchPlaceBody, { email: 'nope', phone: 'x'.repeat(31), contactName: 'x'.repeat(101), priceListId: 'a b' }, ['contactName', 'maxLength'], ['email', 'format'], ['phone', 'maxLength'], ['priceListId', 'pattern']);
  });

  it('takes the invoice series as a text, null, an empty text (none) or false (what the legacy stored)', () => {
    assert.deepEqual(parse(patchPlaceBody, { invoiceSeries: ' FE ' }), { invoiceSeries: 'FE' });
    assert.deepEqual(parse(patchPlaceBody, { invoiceSeries: '' }), { invoiceSeries: null });
    assert.deepEqual(parse(patchPlaceBody, { invoiceSeries: null }), { invoiceSeries: null });
    assert.deepEqual(parse(patchPlaceBody, { invoiceSeries: false }), { invoiceSeries: false });
    issues(patchPlaceBody, { invoiceSeries: true }, ['invoiceSeries', 'type']);
    issues(patchPlaceBody, { invoiceSeries: 'x'.repeat(51) }, ['invoiceSeries', 'maxLength']);
  });

  it('completes the price lists with their defaults, refuses a repeated id and too many', () => {
    assert.deepEqual(parse(patchPlaceBody, { priceLists: [{ id: 'a' }, { id: 'b', allYouCanEat: true, ayceCode1: ' 1 ', ayceCode2: '' }] }), {
      priceLists: [
        { id: 'a', allYouCanEat: false, ayceCode1: null, ayceCode2: null },
        { id: 'b', allYouCanEat: true, ayceCode1: '1', ayceCode2: null },
      ],
    });
    issues(patchPlaceBody, { priceLists: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }, ['priceLists.2.id', 'incorrect']);
    issues(patchPlaceBody, { priceLists: Array.from({ length: 51 }, (_unused, index) => ({ id: `l${String(index)}` })) }, ['priceLists', 'tooMany']);
    issues(patchPlaceBody, { priceLists: [{}] }, ['priceLists.0.id', 'required']);
    issues(patchPlaceBody, { priceLists: [{ id: 'a b' }] }, ['priceLists.0.id', 'pattern']);
  });
});

describe('place body: the license', () => {
  const LICENSE = { plan: 'basic', expirationDate: '2030-01-01T00:00:00.000Z', status: 'active', sentry: false };

  it('takes the whole block of a PUT, with every key required, and the date normalized', () => {
    assert.deepEqual(parse(putLicenseBody, { ...LICENSE, expirationDate: '2030-01-01' }), LICENSE);
    assert.deepEqual(parse(putLicenseBody, { ...LICENSE, plan: null, expirationDate: null }), { ...LICENSE, plan: null, expirationDate: null });
    issues(putLicenseBody, {}, ['plan', 'required'], ['expirationDate', 'required'], ['status', 'required'], ['sentry', 'required']);
  });

  it('takes any plan as text (the service judges it), refuses a state, a date and a switch that are not valid', () => {
    assert.deepEqual(parse(putLicenseBody, { ...LICENSE, plan: ' professional ' }), { ...LICENSE, plan: 'professional' });
    issues(putLicenseBody, { ...LICENSE, status: 'on', sentry: 'yes', expirationDate: 'soon', plan: 5 }, ['plan', 'type'], ['expirationDate', 'format'], ['status', 'enum'], ['sentry', 'type']);
    assert.equal(PLANS.length, 5);
  });
});

describe('place body: the opening hours', () => {
  it('takes the whole block of a PUT, with every key required', () => {
    assert.deepEqual(parse(putOpeningHoursBody, HOURS), HOURS);
    issues(putOpeningHoursBody, {}, ['timezone', 'required'], ['week', 'required'], ['special', 'required'], ['deliveryTime', 'required']);
    issues(putOpeningHoursBody, { ...HOURS, deliveryTime: {} }, ['deliveryTime.week', 'required'], ['deliveryTime.special', 'required']);
  });

  it('requires the seven days, complete, and refuses a slot that is not a start and an end', () => {
    const { '3': _three, ...six } = week();
    issues(putOpeningHoursBody, { ...HOURS, week: six }, ['week.3', 'required']);
    issues(putOpeningHoursBody, { ...HOURS, week: week({ '7': CLOSED }) }, ['week.(key)', 'unknown']);
    issues(putOpeningHoursBody, { ...HOURS, week: week({ '1': { active: 'yes', values: [] } }) }, ['week.1.active', 'type']);
    issues(putOpeningHoursBody, { ...HOURS, week: week({ '1': { active: true, values: [{ start: '09:00' }] } }) }, ['week.1.values.0.end', 'required']);
    issues(putOpeningHoursBody, { ...HOURS, week: week({ '1': { active: true, values: Array.from({ length: 9 }, () => ({ start: '09:00', end: '10:00' })) } }) }, ['week.1.values', 'tooMany']);
    issues(putOpeningHoursBody, { ...HOURS, week: week({ '1': { active: true, values: [{ start: '09:00:00', end: '10:00' }] } }) }, ['week.1.values.0.start', 'maxLength']);
    // The time is checked by the service, where it changes: the schema takes any short text.
    assert.ok(!Array.isArray(details(putOpeningHoursBody, { ...HOURS, week: week({ '1': { active: true, values: [{ start: 'late', end: 'x' }] } }) })));
  });

  it('takes the special days by date, at most 400, each with its flag and slots', () => {
    const special = { '2026-12-25': { closed: true, values: [] }, '2026-12-31': { closed: false, values: [{ start: '10:00', end: '14:00' }] } };
    assert.deepEqual(parse(putOpeningHoursBody, { ...HOURS, special }), { ...HOURS, special });
    issues(putOpeningHoursBody, { ...HOURS, special: { '25/12/2026': CLOSED } }, ['special.(key)', 'format']);
    issues(putOpeningHoursBody, { ...HOURS, special: { '2026-12-25': CLOSED } }, ['special.2026-12-25.active', 'unknown'], ['special.2026-12-25.closed', 'required']);
    issues(putOpeningHoursBody, { ...HOURS, special: { $where: {} } }, ['special.(key)', 'forbiddenKey']);
    const many = Object.fromEntries(Array.from({ length: 401 }, (_unused, index) => [new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), { closed: true, values: [] }]));
    issues(putOpeningHoursBody, { ...HOURS, special: many }, ['special', 'tooMany']);
  });

  it('takes the time zone as a name of the form the platform lists (the service checks that it is one)', () => {
    assert.ok(!Array.isArray(details(putOpeningHoursBody, { ...HOURS, timezone: 'America/Argentina/Buenos_Aires' })));
    assert.ok(!Array.isArray(details(putOpeningHoursBody, { ...HOURS, timezone: 'Etc/GMT+1' })));
    issues(putOpeningHoursBody, { ...HOURS, timezone: 'Europe/Rome; drop' }, ['timezone', 'pattern']);
    issues(putOpeningHoursBody, { ...HOURS, timezone: '' }, ['timezone', 'minLength']);
  });

  it('accepts the hours inside a modification, each part optional, the week whole', () => {
    assert.deepEqual(parse(patchPlaceBody, { openingHours: { deliveryTime: { special: {} } } }), { openingHours: { deliveryTime: { special: {} } } });
    issues(patchPlaceBody, { openingHours: { week: { '0': CLOSED } } }, ['openingHours.week.1', 'required'], ['openingHours.week.2', 'required'], ['openingHours.week.3', 'required'], ['openingHours.week.4', 'required'], ['openingHours.week.5', 'required'], ['openingHours.week.6', 'required']);
  });
});

describe('place query and parameters', () => {
  it('takes the filters, the sorts and the search of the list', () => {
    assert.deepEqual(parse(placesQuery, { status: 'active', plan: 'enterprice', country: 'IT', province: 'MI', trashed: 'true', sort: '-expirationDate', q: ' bar ' }), {
      status: 'active',
      plan: 'enterprice',
      country: 'IT',
      province: 'MI',
      trashed: 'true',
      sort: '-expirationDate',
      q: 'bar',
    });
    for (const sort of ['name', '-name', 'expirationDate', '-expirationDate']) {
      assert.deepEqual(parse(placesQuery, { sort }), { sort });
    }
    issues(placesQuery, { sort: 'city', status: 'on', plan: 'a b', country: 'it', companyId: 'x', ids: 'nope' }, ['sort', 'enum'], ['companyId', 'format'], ['ids', 'minLength'], ['status', 'enum'], ['plan', 'pattern'], ['country', 'pattern']);
  });

  it('takes the id of the place of the path', () => {
    const placeId = new ObjectId();
    assert.deepEqual(parse(placeParams, { groupId: 'g', placeId: placeId.toHexString() }), { placeId });
    issues(placeParams, { placeId: 'nope' }, ['placeId', 'format']);
  });
});
