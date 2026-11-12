import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { PriceList } from './catalog.types';
import { PriceListsPage } from './price-lists-page';

const STANDARD: PriceList = { id: 'p1', name: 'Retail', enabled: true, isDefault: true };
const OTHER: PriceList = { id: 'p2', name: 'Outlet', enabled: false, isDefault: false };
const render = (canUpdate = true) => renderCatalogPage(PriceListsPage, 'price-lists', canUpdate);

afterEach(cleanUpPage);

describe('PriceListsPage', () => {
  it('shows name, whether enabled and which one is the standard list', async () => {
    const { load, headers, rows } = await render();
    await load([STANDARD, OTHER]);
    expect(headers()).toEqual([
      'CATALOG.PRICE_LISTS.COLUMN.NAME',
      'CATALOG.PRICE_LISTS.COLUMN.ENABLED',
      'CATALOG.PRICE_LISTS.COLUMN.DEFAULT',
    ]);
    expect(rows()).toEqual([
      ['Retail', 'CATALOG.YES', 'CATALOG.PRICE_LISTS.DEFAULT'],
      ['Outlet', 'CATALOG.NO', ''],
    ]);
  });

  it('only reads for whoever cannot change the group', async () => {
    const { load, button } = await render(false);
    await load([STANDARD]);
    expect(button('CATALOG.PRICE_LISTS.NEW')).toBeUndefined();
  });

  it('does not offer to delete the standard list', async () => {
    const { load, byLabel } = await render();
    await load([STANDARD, OTHER]);
    expect(byLabel('CATALOG.EDIT_LABEL', 'Retail')).not.toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'Retail')).toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'Outlet')).not.toBeNull();
  });

  it('creates a list', async () => {
    const { load, click, button, type, submit, url, view, toasts } = await render();
    await load([STANDARD]);
    await click(button('CATALOG.PRICE_LISTS.NEW'));
    await type('CATALOG.PRICE_LISTS.FIELD.NAME', 'Wholesale');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Wholesale', enabled: true });
    request.flush({ data: OTHER }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual([['success', 'CATALOG.CREATED']]);
    await load([STANDARD, OTHER]);
  });

  it('modifies a list and gives up on another change', async () => {
    const { load, click, byLabel, type, submit, url, view, dialogs } = await render();
    await load([STANDARD, OTHER]);
    await click(byLabel('CATALOG.EDIT_LABEL', 'Outlet'));
    await click(dialogs()[0].querySelector('form .actions button'));
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    await click(byLabel('CATALOG.EDIT_LABEL', 'Outlet'));
    await type('CATALOG.PRICE_LISTS.FIELD.NAME', 'Outlet 2');
    await submit();
    const request = backend().expectOne(`${url}/p2`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ name: 'Outlet 2' });
    request.flush({ data: OTHER });
    await view();
    await load([STANDARD, OTHER]);
  });

  it('deletes a list', async () => {
    const { load, click, byLabel, dialogs, url, view } = await render();
    await load([STANDARD, OTHER]);
    await click(byLabel('CATALOG.DELETE_LABEL', 'Outlet'));
    await click(dialogs()[1].querySelectorAll('footer button')[1]);
    const request = backend().expectOne(`${url}/p2`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    await load([STANDARD]);
  });
});
