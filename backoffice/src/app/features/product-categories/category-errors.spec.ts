import { ApiError } from '../../core/api/api-error';
import { ReferenceApi } from '../../core/reference/reference-api';
import { REFERENCE_KINDS, isReferenced, referenceGroups } from './category-errors';

const conflict = (details: { field: string; issue: string }[] = []) =>
  new ApiError({ status: 409, code: 'CONFLICT', message: 'x', details });

const ref = (field: string) => ({ field, issue: 'referenced' });

function fake(overrides: Partial<Record<'lookupNames' | 'placeNames', ReturnType<typeof vi.fn>>> = {}) {
  const api = {
    lookupNames: overrides.lookupNames ?? vi.fn().mockResolvedValue({}),
    placeNames: overrides.placeNames ?? vi.fn().mockResolvedValue({}),
  };
  return { api, reference: api as unknown as ReferenceApi };
}

afterEach(() => vi.restoreAllMocks());

describe('isReferenced', () => {
  it('is true for a 409 that lists references', () => {
    expect(isReferenced(conflict([ref('products.1')]))).toBe(true);
  });

  it('is false without that detail, for other codes and for other errors', () => {
    expect(isReferenced(conflict())).toBe(false);
    expect(isReferenced(conflict([{ field: 'x', issue: 'other' }]))).toBe(false);
    expect(
      isReferenced(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x', details: [ref('p')] })),
    ).toBe(false);
    expect(isReferenced(new Error('x'))).toBe(false);
  });
});

describe('referenceGroups', () => {
  it('has the kinds the texts need', () => {
    expect(REFERENCE_KINDS).toHaveLength(7);
  });

  it('groups by kind in the order of the kinds, resolving the names by source', async () => {
    const lookupNames = vi.fn().mockImplementation(async (_g: string, source: string) =>
      source === 'products' ? { p1: 'Acqua' } : { c1: 'Bevande' },
    );
    const placeNames = vi.fn().mockResolvedValue({ s1: 'Negozio' });
    const { api, reference } = fake({ lookupNames, placeNames });
    const groups = await referenceGroups(
      reference,
      'g',
      conflict([
        ref('places.s1'),
        ref('products.p1'),
        ref('products.p2'),
        ref('subcategories.c1'),
        ref('promotions.pr1'),
        { field: 'ignored', issue: 'other' },
      ]),
    );
    expect(groups).toEqual([
      { kind: 'subcategories', items: ['Bevande'], hidden: false },
      { kind: 'products', items: ['Acqua', 'p2'], hidden: false },
      { kind: 'promotions', items: ['pr1'], hidden: false },
      { kind: 'places', items: ['Negozio'], hidden: false },
    ]);
    expect(api.lookupNames).toHaveBeenCalledWith('g', 'products', ['p1', 'p2']);
    expect(api.lookupNames).toHaveBeenCalledWith('g', 'product-categories', ['c1']);
    expect(api.placeNames).toHaveBeenCalledWith('g', ['s1']);
  });

  it('does not resolve promotions', async () => {
    const { api, reference } = fake();
    const groups = await referenceGroups(reference, 'g', conflict([ref('promotions.x')]));
    expect(groups).toEqual([{ kind: 'promotions', items: ['x'], hidden: false }]);
    expect(api.lookupNames).not.toHaveBeenCalled();
    expect(api.placeNames).not.toHaveBeenCalled();
  });

  it('marks as hidden an anonymous detail, without reading anything', async () => {
    const { api, reference } = fake();
    const groups = await referenceGroups(reference, 'g', conflict([ref('products')]));
    expect(groups).toEqual([{ kind: 'products', items: [], hidden: true }]);
    expect(api.lookupNames).not.toHaveBeenCalled();
  });

  it('keeps the named ones and marks hidden the group with some anonymous detail', async () => {
    const { reference } = fake({ lookupNames: vi.fn().mockResolvedValue({ a: 'A' }) });
    const groups = await referenceGroups(reference, 'g', conflict([ref('products.a'), ref('products')]));
    expect(groups).toEqual([{ kind: 'products', items: ['A'], hidden: true }]);
  });

  it('keeps a dotted id whole and ignores an unknown kind', async () => {
    const { api, reference } = fake();
    const groups = await referenceGroups(
      reference,
      'g',
      conflict([ref('products.a.b'), ref('unknown.1')]),
    );
    expect(groups).toEqual([{ kind: 'products', items: ['a.b'], hidden: false }]);
    expect(api.lookupNames).toHaveBeenCalledWith('g', 'products', ['a.b']);
  });

  it('shows the ids and logs when a read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { reference } = fake({ lookupNames: vi.fn().mockRejectedValue(new Error('down')) });
    const groups = await referenceGroups(reference, 'g', conflict([ref('products.a'), ref('products.b')]));
    expect(groups).toEqual([{ kind: 'products', items: ['a', 'b'], hidden: false }]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('returns nothing for a 409 without references', async () => {
    const { reference } = fake();
    expect(await referenceGroups(reference, 'g', conflict())).toEqual([]);
  });
});
