import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { fieldAt, normalizeField, userFailureMessage } from './users-errors';

describe('userFailureMessage', () => {
  it('explains a 403 as a target that cannot be managed, and maps the rest centrally', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const i18n = TestBed.inject(I18nService);
    vi.spyOn(i18n, 't').mockImplementation((key) => `[${key}]`);
    const forbidden = new ApiError({ status: 403, code: 'FORBIDDEN', message: 'm' });
    const conflict = new ApiError({ status: 409, code: 'CONFLICT', message: 'm' });
    expect(userFailureMessage(i18n, forbidden)).toBe('[USERS.FORBIDDEN_TARGET]');
    expect(userFailureMessage(i18n, conflict)).toBe('[ERRORS.API.CONFLICT]');
  });
});

describe('normalizeField', () => {
  it.each([
    ['companyIds.0', 'companyIds'],
    ['placeIds.12', 'placeIds'],
    ['serviceIds.3', 'serviceIds'],
    ['pos.options.priceLists.0.isDefault', 'pos.options.priceLists'],
    ['pos.options.priceLists.2', 'pos.options.priceLists'],
    ['pos.options.priceLists', 'pos.options.priceLists'],
    ['companyIds', 'companyIds'],
    ['username', 'username'],
    ['shiftTime.weeks.0.days.1.slots.2.end', 'shiftTime.weeks.0.days.1.slots.2.end'],
    ['other.companyIds.0', 'other.companyIds.0'],
  ])('%s -> %s', (field, expected) => {
    expect(normalizeField(field)).toBe(expected);
  });
});

describe('fieldAt', () => {
  function testForm() {
    return TestBed.runInInjectionContext(() =>
      form(
        signal({
          name: 'x',
          pos: { grants: { discount: true } },
          shiftTime: { weeks: [{ days: { '1': { slots: [{ start: '09:00', end: '10:00' }] } } }] },
        }),
      ),
    );
  }

  it('finds nested fields by the dotted path of the backend', () => {
    const root = testForm();
    expect(fieldAt(root, 'name')).toBe(root.name);
    expect(fieldAt(root, 'pos.grants.discount')).toBe(root.pos.grants.discount);
  });

  it('walks array indexes and numeric keys', () => {
    const root = testForm();
    const end = fieldAt(root, 'shiftTime.weeks.0.days.1.slots.0.end');
    expect(end).toBeDefined();
    expect((end as unknown as () => { value(): string })().value()).toBe('10:00');
  });

  it('is undefined for paths the form does not have', () => {
    const root = testForm();
    expect(fieldAt(root, 'missing')).toBeUndefined();
    expect(fieldAt(root, 'pos.missing.discount')).toBeUndefined();
    expect(fieldAt(root, 'shiftTime.weeks.5')).toBeUndefined();
    expect(fieldAt(root, 'pos.grants.discount.deeper')).toBeUndefined();
  });

  it('is undefined when the root is not a form', () => {
    expect(fieldAt({} as never, 'name')).toBeUndefined();
  });

  it('does not follow properties that are not fields', () => {
    const root = testForm();
    expect(fieldAt(root, '__proto__')).toBeUndefined();
    expect(fieldAt(root, 'pos.__proto__')).toBeUndefined();
    expect(fieldAt(root, 'name.name')).toBeUndefined();
    expect(fieldAt(root, 'constructor')).toBeUndefined();
  });
});
