import { ApiError } from '../../core/api/api-error';
import { countryRoute, inUseOf } from './countries.types';

const conflict = (details: { field: string; issue: string }[], status = 409) =>
  new ApiError({ status, code: 'CONFLICT', message: 'x', details });

describe('inUseOf', () => {
  it('counts the companies and the places listed in a refused deletion', () => {
    const error = conflict([
      { field: 'companies.a', issue: 'inUse' },
      { field: 'places.b', issue: 'inUse' },
      { field: 'places.c', issue: 'inUse' },
      { field: 'code', issue: 'taken' },
    ]);
    expect(inUseOf(error)).toEqual({ companies: 1, places: 2, limited: false });
  });

  it('tells that the real count may be higher when the list is full', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ field: `places.${i}`, issue: 'inUse' }));
    expect(inUseOf(conflict(many))?.limited).toBe(true);
    const companies = many.map((d) => ({ ...d, field: d.field.replace('places', 'companies') }));
    expect(inUseOf(conflict(companies))?.limited).toBe(true);
  });

  it.each([
    ['another status', conflict([{ field: 'places.a', issue: 'inUse' }], 422)],
    ['another issue', conflict([{ field: 'code', issue: 'taken' }])],
    ['no details', conflict([])],
    ['not an API error', new Error('x')],
    ['nothing', undefined],
  ])('is null for %s', (_name, error) => {
    expect(inUseOf(error)).toBeNull();
  });
});

describe('countryRoute', () => {
  it('addresses the list or a country', () => {
    expect(countryRoute()).toEqual(['/settings/countries']);
    expect(countryRoute('IT')).toEqual(['/settings/countries', 'IT']);
  });
});
