import { ReferenceApi } from '../../core/reference/reference-api';
import { loadSaleNames } from './sale-names';

function reference(over: Partial<Record<'companyNames' | 'placeNames', ReturnType<typeof vi.fn>>> = {}) {
  return {
    companyNames: vi.fn(async () => ({ a: 'Acme' })),
    placeNames: vi.fn(async () => ({ p: 'Bar Roma' })),
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('loadSaleNames', () => {
  it('reads the names of the companies and stores the sales refer to', async () => {
    const api = reference();
    const sales = [
      { companyId: 'a', placeId: 'p' },
      { companyId: 'a', placeId: null },
    ];
    expect(await loadSaleNames(api as unknown as ReferenceApi, 'g', sales)).toEqual({
      companies: { a: 'Acme' },
      places: { p: 'Bar Roma' },
    });
    expect(api.companyNames).toHaveBeenCalledWith('g', ['a', 'a']);
    expect(api.placeNames).toHaveBeenCalledWith('g', ['p']);
  });

  it('reads nothing for sales without a company or a store', async () => {
    const api = reference();
    expect(await loadSaleNames(api as unknown as ReferenceApi, 'g', [{ companyId: null, placeId: '' }])).toEqual({
      companies: {},
      places: {},
    });
    expect(api.companyNames).not.toHaveBeenCalled();
    expect(api.placeNames).not.toHaveBeenCalled();
  });

  it('logs a failed read and shows no names', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = reference({ placeNames: vi.fn(async () => Promise.reject(new Error('403'))) });
    expect(await loadSaleNames(api as unknown as ReferenceApi, 'g', [{ companyId: 'a', placeId: 'p' }])).toEqual({
      companies: {},
      places: {},
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});
