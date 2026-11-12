import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { aFavoritesList } from '../../../../testing/fidelity';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { ProductFavoritesPage } from './product-favorites-page';

const BAR = aFavoritesList({ id: 'f1', name: 'Bar' });
const EMPTY = aFavoritesList({ id: 'f2', name: 'Empty', products: [] });
const render = (permissions = ['products:read', 'products:update']) => {
  vi.spyOn(ReferenceApi.prototype, 'lookup').mockResolvedValue({
    data: [{ id: 'prod1', name: 'Caffè' }],
    page: { limit: 25, next: null },
  });
  vi.spyOn(ReferenceApi.prototype, 'lookupNames').mockResolvedValue({});
  return renderCatalogPage(ProductFavoritesPage, 'product-favorites', true, {
    inputs: { groupId: 'g1' },
    user: { role: 'PA', permissions },
  });
};

afterEach(cleanUpPage);

describe('ProductFavoritesPage', () => {
  it('shows name and how many products', async () => {
    const { load, headers, rows } = await render();
    await load([BAR, EMPTY]);
    expect(headers()).toEqual([
      'CATALOG.PRODUCT_FAVORITES.COLUMN.NAME',
      'CATALOG.PRODUCT_FAVORITES.COLUMN.PRODUCTS',
    ]);
    expect(rows()).toEqual([
      ['Bar', '2'],
      ['Empty', '0'],
    ]);
  });

  it('writes with products:update, whatever the role', async () => {
    const { load, button, byLabel } = await render();
    await load([BAR]);
    expect(button('CATALOG.PRODUCT_FAVORITES.NEW')).toBeDefined();
    expect(byLabel('CATALOG.EDIT_LABEL', 'Bar')).not.toBeNull();
  });

  it('only reads without products:update', async () => {
    const { load, button } = await render(['products:read']);
    await load([BAR]);
    expect(button('CATALOG.PRODUCT_FAVORITES.NEW')).toBeUndefined();
  });

  it('creates a list', async () => {
    const { load, click, button, type, submit, url, view, toasts } = await render();
    await load([BAR]);
    await click(button('CATALOG.PRODUCT_FAVORITES.NEW'));
    await type('CATALOG.PRODUCT_FAVORITES.FIELD.NAME', 'Snacks');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Snacks', products: [] });
    request.flush({ data: BAR }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual([['success', 'CATALOG.CREATED']]);
    await load([BAR]);
  });

  it('closes the editor when the user gives up', async () => {
    const { load, click, button, view, dialogs } = await render();
    await load([]);
    await click(button('CATALOG.PRODUCT_FAVORITES.NEW'));
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    await click(dialogs()[0].querySelector('form .actions button'));
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    await view();
  });
});
