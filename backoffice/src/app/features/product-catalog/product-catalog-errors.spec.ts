import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { deleteFailureMessage, isReferenced, productNames } from './product-catalog-errors';

const conflict = (details: { field: string; issue: string }[] = []) =>
  new ApiError({ status: 409, code: 'CONFLICT', message: 'x', details });

const i18n = { t: (key: string) => key } as unknown as I18nService;

afterEach(() => vi.restoreAllMocks());

describe('isReferenced', () => {
  it('is true for a 409 that lists products', () => {
    expect(isReferenced(conflict([{ field: 'products.1', issue: 'referenced' }]))).toBe(true);
  });

  it('is false for a 409 without that detail, for other codes and for other errors', () => {
    expect(isReferenced(conflict())).toBe(false);
    expect(isReferenced(conflict([{ field: 'x', issue: 'other' }]))).toBe(false);
    expect(
      isReferenced(
        new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x', details: [{ field: 'p', issue: 'referenced' }] }),
      ),
    ).toBe(false);
    expect(isReferenced(new Error('x'))).toBe(false);
  });
});

describe('productNames', () => {
  const error = conflict([
    { field: 'products.a', issue: 'referenced' },
    { field: 'ignored', issue: 'other' },
    { field: 'products.b', issue: 'referenced' },
  ]);

  it('resolves the names, keeping the id of a product that cannot be read', async () => {
    const lookupNames = vi.fn().mockResolvedValue({ a: 'Acqua' });
    const names = await productNames({ lookupNames } as unknown as ReferenceApi, 'g', error);
    expect(lookupNames).toHaveBeenCalledWith('g', 'products', ['a', 'b']);
    expect(names).toEqual(['Acqua', 'b']);
  });

  it('shows the ids and logs when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lookupNames = vi.fn().mockRejectedValue(new Error('down'));
    expect(await productNames({ lookupNames } as unknown as ReferenceApi, 'g', error)).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalled();
  });
});

describe('deleteFailureMessage', () => {
  it('has its own text for a 403', () => {
    expect(deleteFailureMessage(i18n, new ApiError({ status: 403, code: 'FORBIDDEN', message: 'x' }))).toBe(
      'PRODUCT_CATALOG.ERROR.DELETE_FORBIDDEN',
    );
  });

  it('asks to reload after a 409 that is not a list of products', () => {
    expect(deleteFailureMessage(i18n, conflict())).toBe('PRODUCT_CATALOG.ERROR.CONCURRENT');
  });

  it('uses the central mapping for everything else', () => {
    expect(deleteFailureMessage(i18n, new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x' }))).toBe(
      'ERRORS.API.NOT_FOUND',
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(deleteFailureMessage(i18n, new Error('boom'))).toBe('ERRORS.GENERIC.MESSAGE');
  });
});
