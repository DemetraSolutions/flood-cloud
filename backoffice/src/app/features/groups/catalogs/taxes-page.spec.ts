import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { Tax } from './catalog.types';
import { TaxesPage } from './taxes-page';

const FULL: Tax = {
  id: 't1',
  rate: 22,
  department: 1,
  description: 'Ordinaria',
  vatNature: 'N4',
};
const BARE: Tax = { id: 't2', rate: 4, department: null, description: null, vatNature: null };
const render = (canUpdate = true) => renderCatalogPage(TaxesPage, 'taxes', canUpdate);

afterEach(cleanUpPage);

describe('TaxesPage', () => {
  it('shows rate, department, VAT nature and description', async () => {
    const { load, headers, rows } = await render();
    await load([FULL, BARE]);
    expect(headers()).toEqual([
      'CATALOG.TAXES.COLUMN.RATE',
      'CATALOG.TAXES.COLUMN.DEPARTMENT',
      'CATALOG.TAXES.COLUMN.VAT_NATURE',
      'CATALOG.TAXES.COLUMN.DESCRIPTION',
    ]);
    expect(rows()).toEqual([
      ['22%', '1', 'N4', 'Ordinaria'],
      ['4%', '', '', ''],
    ]);
  });

  it('only reads for whoever cannot change the group', async () => {
    const { load, button } = await render(false);
    await load([FULL]);
    expect(button('CATALOG.TAXES.NEW')).toBeUndefined();
  });

  it('creates a rate', async () => {
    const { load, click, button, type, submit, url, view } = await render();
    await load([]);
    await click(button('CATALOG.TAXES.NEW'));
    await type('CATALOG.TAXES.FIELD.RATE', '10');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ rate: 10 });
    request.flush({ data: FULL }, { status: 201, statusText: 'Created' });
    await view();
    await load([FULL]);
  });

  it('modifies a rate and names it by its percentage when deleting', async () => {
    const { load, click, byLabel, type, submit, dialogs, url, view } = await render();
    await load([FULL]);
    await click(byLabel('CATALOG.EDIT_LABEL', '22%'));
    await click(dialogs()[0].querySelector('form .actions button'));
    await click(byLabel('CATALOG.EDIT_LABEL', '22%'));
    await type('CATALOG.TAXES.FIELD.RATE', '21');
    await submit();
    const patch = backend().expectOne(`${url}/t1`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ rate: 21 });
    patch.flush({ data: FULL });
    await view();
    await load([FULL]);
    await click(byLabel('CATALOG.DELETE_LABEL', '22%'));
    expect(dialogs()[1].querySelector('p')?.textContent).toBe(
      'CATALOG.TAXES.DELETE_CONFIRM {"name":"22%"}',
    );
    await click(dialogs()[1].querySelectorAll('footer button')[1]);
    const remove = backend().expectOne(`${url}/t1`);
    expect(remove.request.method).toBe('DELETE');
    remove.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    await load([]);
  });
});
