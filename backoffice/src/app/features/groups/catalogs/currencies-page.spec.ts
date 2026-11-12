import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { CurrenciesPage } from './currencies-page';

const EUR = { code: 'EUR', symbol: '€' };
const render = (canUpdate = true) => renderCatalogPage(CurrenciesPage, 'currencies', canUpdate);

afterEach(cleanUpPage);

describe('CurrenciesPage', () => {
  it('shows code and symbol', async () => {
    const { load, headers, rows } = await render();
    await load([EUR]);
    expect(headers()).toEqual([
      'CATALOG.CURRENCIES.COLUMN.CODE',
      'CATALOG.CURRENCIES.COLUMN.SYMBOL',
    ]);
    expect(rows()).toEqual([['EUR', '€']]);
  });

  it('only reads for whoever cannot change the group', async () => {
    const { load, button } = await render(false);
    await load([EUR]);
    expect(button('CATALOG.CURRENCIES.NEW')).toBeUndefined();
  });

  it('creates a currency', async () => {
    const { load, click, button, type, submit, url, view } = await render();
    await load([]);
    await click(button('CATALOG.CURRENCIES.NEW'));
    await type('CATALOG.CURRENCIES.FIELD.CODE', 'USD');
    await type('CATALOG.CURRENCIES.FIELD.SYMBOL', '$');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ code: 'USD', symbol: '$' });
    request.flush({ data: EUR }, { status: 201, statusText: 'Created' });
    await view();
    await load([EUR]);
  });

  it('modifies a currency by its code, gives up, and deletes it', async () => {
    const { load, click, byLabel, type, submit, dialogs, url, view } = await render();
    await load([EUR]);
    await click(byLabel('CATALOG.EDIT_LABEL', 'EUR'));
    await click(dialogs()[0].querySelector('form .actions button'));
    await click(byLabel('CATALOG.EDIT_LABEL', 'EUR'));
    await type('CATALOG.CURRENCIES.FIELD.SYMBOL', 'E');
    await submit();
    const patch = backend().expectOne(`${url}/EUR`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ symbol: 'E' });
    patch.flush({ data: EUR });
    await view();
    await load([EUR]);
    await click(byLabel('CATALOG.DELETE_LABEL', 'EUR'));
    await click(dialogs()[1].querySelectorAll('footer button')[1]);
    const remove = backend().expectOne(`${url}/EUR`);
    expect(remove.request.method).toBe('DELETE');
    remove.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    await load([]);
  });
});
