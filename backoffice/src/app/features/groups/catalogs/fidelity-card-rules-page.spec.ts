import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { FidelityCardRule } from './catalog.types';
import { FidelityCardRulesPage } from './fidelity-card-rules-page';

const SET: FidelityCardRule = { currency: 'EUR', pointValue: 0.5, discountPercentage: 10 };
const UNSET: FidelityCardRule = { currency: 'USD', pointValue: null, discountPercentage: null };
const render = (canUpdate = true) =>
  renderCatalogPage(FidelityCardRulesPage, 'fidelity-card-rules', canUpdate);

afterEach(cleanUpPage);

describe('FidelityCardRulesPage', () => {
  it('shows currency, point value and discount', async () => {
    const { load, headers, rows } = await render();
    await load([SET, UNSET]);
    expect(headers()).toEqual([
      'CATALOG.FIDELITY_CARD_RULES.COLUMN.CURRENCY',
      'CATALOG.FIDELITY_CARD_RULES.COLUMN.POINT_VALUE',
      'CATALOG.FIDELITY_CARD_RULES.COLUMN.DISCOUNT',
    ]);
    expect(rows()).toEqual([
      ['EUR', '0.5', '10%'],
      ['USD', '', ''],
    ]);
  });

  it('can neither create nor delete, only change', async () => {
    const { load, button, byLabel } = await render();
    await load([SET]);
    expect(button('CATALOG.FIDELITY_CARD_RULES.NEW')).toBeUndefined();
    expect(byLabel('CATALOG.EDIT_LABEL', 'EUR')).not.toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'EUR')).toBeNull();
  });

  it('only reads for whoever cannot change the group', async () => {
    const { load, byLabel } = await render(false);
    await load([SET]);
    expect(byLabel('CATALOG.EDIT_LABEL', 'EUR')).toBeNull();
  });

  it('replaces the rule of a currency with PUT, or gives up', async () => {
    const { load, click, byLabel, type, submit, dialogs, url, view } = await render();
    await load([SET]);
    await click(byLabel('CATALOG.EDIT_LABEL', 'EUR'));
    await click(dialogs()[0].querySelector('form .actions button'));
    await click(byLabel('CATALOG.EDIT_LABEL', 'EUR'));
    await type('CATALOG.FIDELITY_CARD_RULES.FIELD.POINT_VALUE', '1');
    await submit();
    const request = backend().expectOne(`${url}/EUR`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ pointValue: 1, discountPercentage: 10 });
    request.flush({ data: SET });
    await view();
    await load([SET]);
  });
});
