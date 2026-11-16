import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { WarehouseRule } from './catalog.types';
import { WarehouseRulesPage } from './warehouse-rules-page';

const BASE: WarehouseRule = {
  id: 'w1',
  type: 'load',
  name: 'Purchase',
  quantity: '+',
  value: '+',
  useLoadUnit: false,
  counterpart: 'suppliers',
  isDefault: false,
  cashLoad: false,
  cashUnload: false,
};
const STANDARD: WarehouseRule = {
  ...BASE,
  id: 'w2',
  type: 'unload',
  name: 'Sale',
  counterpart: 'customers',
  isDefault: true,
  cashUnload: true,
};
const RETURN: WarehouseRule = { ...BASE, id: 'w3', name: 'Return', cashLoad: true };
const ODD: WarehouseRule = { ...BASE, id: 'w4', name: 'Odd', type: null, counterpart: null };
const render = (canUpdate = true) =>
  renderCatalogPage(WarehouseRulesPage, 'warehouse-rules', canUpdate);

beforeEach(() => sessionStorage.clear());
afterEach(cleanUpPage);

describe('WarehouseRulesPage', () => {
  it('shows name, type, counterpart, cash-register use and origin', async () => {
    const { load, headers, rows } = await render();
    await load([BASE, STANDARD, RETURN, ODD]);
    expect(headers()).toEqual([
      'CATALOG.WAREHOUSE_RULES.COLUMN.NAME',
      'CATALOG.WAREHOUSE_RULES.COLUMN.TYPE',
      'CATALOG.WAREHOUSE_RULES.COLUMN.COUNTERPART',
      'CATALOG.WAREHOUSE_RULES.COLUMN.CASH',
      'CATALOG.WAREHOUSE_RULES.COLUMN.ORIGIN',
    ]);
    expect(rows()).toEqual([
      [
        'Purchase',
        'CATALOG.WAREHOUSE_RULES.TYPE.LOAD',
        'CATALOG.WAREHOUSE_RULES.COUNTERPART.SUPPLIERS',
        '',
        'CATALOG.WAREHOUSE_RULES.CUSTOM',
      ],
      [
        'Sale',
        'CATALOG.WAREHOUSE_RULES.TYPE.UNLOAD',
        'CATALOG.WAREHOUSE_RULES.COUNTERPART.CUSTOMERS',
        'CATALOG.WAREHOUSE_RULES.CASH_UNLOAD',
        'CATALOG.WAREHOUSE_RULES.STANDARD',
      ],
      [
        'Return',
        'CATALOG.WAREHOUSE_RULES.TYPE.LOAD',
        'CATALOG.WAREHOUSE_RULES.COUNTERPART.SUPPLIERS',
        'CATALOG.WAREHOUSE_RULES.CASH_LOAD',
        'CATALOG.WAREHOUSE_RULES.CUSTOM',
      ],
      ['Odd', '', '', '', 'CATALOG.WAREHOUSE_RULES.CUSTOM'],
    ]);
  });

  it('leaves the standard rules alone', async () => {
    const { load, byLabel } = await render();
    await load([BASE, STANDARD]);
    expect(byLabel('CATALOG.EDIT_LABEL', 'Sale')).toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'Sale')).toBeNull();
    expect(byLabel('CATALOG.EDIT_LABEL', 'Purchase')).not.toBeNull();
  });

  it('only reads for whoever cannot change the group', async () => {
    const { load, button } = await render(false);
    await load([BASE]);
    expect(button('CATALOG.WAREHOUSE_RULES.NEW')).toBeUndefined();
  });

  it('creates a rule', async () => {
    const { load, click, button, type, submit, url, view } = await render();
    await load([]);
    await click(button('CATALOG.WAREHOUSE_RULES.NEW'));
    await type('CATALOG.WAREHOUSE_RULES.FIELD.NAME', 'Gift');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      type: 'load',
      name: 'Gift',
      quantity: '+',
      value: '+',
      counterpart: 'suppliers',
    });
    request.flush({ data: BASE }, { status: 201, statusText: 'Created' });
    await view();
    await load([BASE]);
  });

  it('modifies a rule, gives up, and deletes it', async () => {
    const { load, click, byLabel, type, submit, dialogs, url, view } = await render();
    await load([BASE]);
    await click(byLabel('CATALOG.EDIT_LABEL', 'Purchase'));
    await click(dialogs()[0].querySelector('form .actions button'));
    await click(byLabel('CATALOG.EDIT_LABEL', 'Purchase'));
    await type('CATALOG.WAREHOUSE_RULES.FIELD.NAME', 'Purchase 2');
    await submit();
    const patch = backend().expectOne(`${url}/w1`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ name: 'Purchase 2' });
    patch.flush({ data: BASE });
    await view();
    await load([BASE]);
    await click(byLabel('CATALOG.DELETE_LABEL', 'Purchase'));
    await click(dialogs()[1].querySelectorAll('footer button')[1]);
    backend().expectOne(`${url}/w1`).flush(null, { status: 204, statusText: 'No Content' });
    await view();
    await load([]);
  });
});
