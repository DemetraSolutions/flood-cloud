import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { aPrizeCatalogue } from '../../../../testing/fidelity';
import { PrizeCataloguesPage } from './prize-catalogues-page';

const GIFTS = aPrizeCatalogue({ id: 'c1', name: 'Gifts' });
const EMPTY = aPrizeCatalogue({ id: 'c2', name: 'Empty', enabled: false, prizes: [] });
const render = (permissions = ['fidelity:read', 'fidelity:update']) =>
  renderCatalogPage(PrizeCataloguesPage, 'fidelity/prize-catalogues', true, {
    inputs: { groupId: 'g1' },
    user: { role: 'SA', permissions },
  });

afterEach(cleanUpPage);

describe('PrizeCataloguesPage', () => {
  it('shows name, whether active and how many prizes', async () => {
    const { load, headers, rows } = await render();
    await load([GIFTS, EMPTY]);
    expect(headers()).toEqual([
      'CATALOG.PRIZE_CATALOGUES.COLUMN.NAME',
      'CATALOG.PRIZE_CATALOGUES.COLUMN.ENABLED',
      'CATALOG.PRIZE_CATALOGUES.COLUMN.PRIZES',
    ]);
    expect(rows()).toEqual([
      ['Gifts', 'CATALOG.YES', '1'],
      ['Empty', 'CATALOG.NO', '0'],
    ]);
  });

  it('only reads for whoever cannot update fidelity', async () => {
    const { load, button } = await render(['fidelity:read']);
    await load([GIFTS]);
    expect(button('CATALOG.PRIZE_CATALOGUES.NEW')).toBeUndefined();
  });

  it('creates a catalogue in a wide dialog', async () => {
    const { load, click, button, type, submit, url, view, toasts, dialogs } = await render();
    await load([GIFTS]);
    await click(button('CATALOG.PRIZE_CATALOGUES.NEW'));
    expect(dialogs()[0].classList.contains('wide')).toBe(true);
    await type('CATALOG.PRIZE_CATALOGUES.FIELD.NAME', 'Toys');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Toys', enabled: true, prizes: [] });
    request.flush({ data: GIFTS }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual([['success', 'CATALOG.CREATED']]);
    await load([GIFTS]);
  });

  it('modifies a catalogue', async () => {
    const { load, click, byLabel, type, submit, url, view } = await render();
    await load([GIFTS]);
    await click(byLabel('CATALOG.EDIT_LABEL', 'Gifts'));
    await type('CATALOG.PRIZE_CATALOGUES.FIELD.NAME', 'Presents');
    await submit();
    const request = backend().expectOne(`${url}/c1`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ name: 'Presents' });
    request.flush({ data: GIFTS });
    await view();
    await load([GIFTS]);
  });

  it('closes the editor when the user gives up', async () => {
    const { load, click, button, view, dialogs } = await render();
    await load([]);
    await click(button('CATALOG.PRIZE_CATALOGUES.NEW'));
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    await click(dialogs()[0].querySelector('form .actions button'));
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    await view();
  });
});
