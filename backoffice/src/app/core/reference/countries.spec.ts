import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { Countries } from './countries';

const BODY = {
  data: [
    { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }] },
    { code: 'FR', name: 'Francia', areas: [] },
  ],
  page: { limit: 2, next: null },
};

function setup() {
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  return TestBed.inject(Countries);
}

afterEach(() => backend().verify());

describe('Countries', () => {
  it('reads nothing until a page needs the countries', async () => {
    const countries = setup();
    TestBed.tick();
    await settle();
    expect(countries.list()).toEqual([]);
    expect(countries.areas('IT')).toEqual([]);
  });

  it('reads the countries once and serves their areas', async () => {
    const countries = setup();
    countries.need();
    countries.need();
    TestBed.tick();
    backend().expectOne(`${API}/v1/countries`).flush(BODY);
    await settle();
    expect(countries.list().map((c) => c.code)).toEqual(['IT', 'FR']);
    expect(countries.areas('IT')).toEqual([{ code: 'MI', name: 'Milano' }]);
    expect(countries.areas('FR')).toEqual([]);
    expect(countries.areas('XX')).toEqual([]);
    expect(countries.failed()).toBe(false);
  });

  it('tells when the read failed', async () => {
    const countries = setup();
    countries.need();
    TestBed.tick();
    backend().expectOne(`${API}/v1/countries`).flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect(countries.failed()).toBe(true);
    expect(countries.list()).toEqual([]);
  });
});
