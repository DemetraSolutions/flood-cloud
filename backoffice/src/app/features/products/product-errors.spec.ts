import { ApiError } from '../../core/api/api-error';
import { ReferenceApi } from '../../core/reference/reference-api';
import { PRODUCT_REFERENCE_KINDS, productReferenceGroups } from './product-errors';

const conflict = (details: { field: string; issue: string }[] = []) =>
  new ApiError({ status: 409, code: 'CONFLICT', message: 'x', details });

const ref = (field: string) => ({ field, issue: 'referenced' });

function fake(lookupNames = vi.fn().mockResolvedValue({})) {
  return { lookupNames, reference: { lookupNames } as unknown as ReferenceApi };
}

afterEach(() => vi.restoreAllMocks());

describe('productReferenceGroups', () => {
  it('has the eight kinds the server reports', () => {
    expect(PRODUCT_REFERENCE_KINDS).toHaveLength(8);
  });

  it('groups by kind in the order of the kinds, reading the names from the right source', async () => {
    const lookupNames = vi
      .fn()
      .mockImplementation(async (_g: string, source: string) => (source === 'products' ? { p1: 'Acqua' } : { c1: 'Bevande' }));
    const { reference } = fake(lookupNames);
    const groups = await productReferenceGroups(
      reference,
      'g',
      conflict([
        ref('favorites.f1'),
        ref('categoryModifiers.c1'),
        ref('productMenus.p1'),
        ref('productBundles.p2'),
        ref('serviceUsers.u1'),
        ref('promotions.pr1'),
        ref('unknown.1'),
        { field: 'ignored', issue: 'other' },
      ]),
    );
    expect(groups).toEqual([
      { kind: 'productBundles', items: ['p2'], hidden: false },
      { kind: 'productMenus', items: ['Acqua'], hidden: false },
      { kind: 'categoryModifiers', items: ['Bevande'], hidden: false },
      { kind: 'serviceUsers', items: ['u1'], hidden: false },
      { kind: 'favorites', items: ['f1'], hidden: false },
      { kind: 'promotions', items: ['pr1'], hidden: false },
    ]);
    expect(lookupNames).toHaveBeenCalledWith('g', 'products', ['p1']);
    expect(lookupNames).toHaveBeenCalledWith('g', 'products', ['p2']);
    expect(lookupNames).toHaveBeenCalledWith('g', 'product-categories', ['c1']);
    expect(lookupNames).toHaveBeenCalledTimes(3);
  });

  it('marks as hidden an anonymous detail, without reading anything', async () => {
    const { lookupNames, reference } = fake();
    const groups = await productReferenceGroups(reference, 'g', conflict([ref('productModifierChoices')]));
    expect(groups).toEqual([{ kind: 'productModifierChoices', items: [], hidden: true }]);
    expect(lookupNames).not.toHaveBeenCalled();
  });

  it('keeps the named ones of a group that also has an anonymous detail, and the dotted ids whole', async () => {
    const { lookupNames, reference } = fake(vi.fn().mockResolvedValue({ 'a.b': 'AB' }));
    const groups = await productReferenceGroups(reference, 'g', conflict([ref('productModifierLists.a.b'), ref('productModifierLists')]));
    expect(groups).toEqual([{ kind: 'productModifierLists', items: ['AB'], hidden: true }]);
    expect(lookupNames).toHaveBeenCalledWith('g', 'products', ['a.b']);
  });

  it('returns nothing for a 409 without references', async () => {
    const { reference } = fake();
    expect(await productReferenceGroups(reference, 'g', conflict())).toEqual([]);
  });

  it('shows the ids and logs only the code when a read fails with an API error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'secret', details: [] });
    const { reference } = fake(vi.fn().mockRejectedValue(failure));
    const groups = await productReferenceGroups(reference, 'g', conflict([ref('productBundles.a'), ref('productBundles.b')]));
    expect(groups).toEqual([{ kind: 'productBundles', items: ['a', 'b'], hidden: false }]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]).toEqual(['Cannot read the names of what refers to the product', 'INTERNAL_ERROR']);
  });

  it('logs "unexpected" for any other failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { reference } = fake(vi.fn().mockRejectedValue(new Error('down')));
    const groups = await productReferenceGroups(reference, 'g', conflict([ref('categoryModifiers.a')]));
    expect(groups).toEqual([{ kind: 'categoryModifiers', items: ['a'], hidden: false }]);
    expect(warn.mock.calls[0][1]).toBe('unexpected');
  });
});
