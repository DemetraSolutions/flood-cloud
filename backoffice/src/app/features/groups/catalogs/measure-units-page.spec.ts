import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { MeasureUnitsPage } from './measure-units-page';

const KG = { id: 'u1', value: 'kg' };
const render = (canUpdate = true) =>
  renderCatalogPage(MeasureUnitsPage, 'measure-units', canUpdate);

afterEach(cleanUpPage);

describe('MeasureUnitsPage', () => {
  it('shows the units', async () => {
    const { load, headers, rows } = await render();
    await load([KG]);
    expect(headers()).toEqual(['CATALOG.MEASURE_UNITS.COLUMN.VALUE']);
    expect(rows()).toEqual([['kg']]);
  });

  it('only reads for whoever cannot change the group', async () => {
    const { load, button } = await render(false);
    await load([KG]);
    expect(button('CATALOG.MEASURE_UNITS.NEW')).toBeUndefined();
  });

  it('creates a unit', async () => {
    const { load, click, button, type, submit, url, view } = await render();
    await load([]);
    await click(button('CATALOG.MEASURE_UNITS.NEW'));
    await type('CATALOG.MEASURE_UNITS.FIELD.VALUE', 'pz');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ value: 'pz' });
    request.flush({ data: KG }, { status: 201, statusText: 'Created' });
    await view();
    await load([KG]);
  });

  it('modifies a unit, gives up, and deletes it', async () => {
    const { load, click, byLabel, type, submit, dialogs, url, view } = await render();
    await load([KG]);
    await click(byLabel('CATALOG.EDIT_LABEL', 'kg'));
    await click(dialogs()[0].querySelector('form .actions button'));
    await click(byLabel('CATALOG.EDIT_LABEL', 'kg'));
    await type('CATALOG.MEASURE_UNITS.FIELD.VALUE', 'g');
    await submit();
    const patch = backend().expectOne(`${url}/u1`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ value: 'g' });
    patch.flush({ data: KG });
    await view();
    await load([KG]);
    await click(byLabel('CATALOG.DELETE_LABEL', 'kg'));
    await click(dialogs()[1].querySelectorAll('footer button')[1]);
    backend().expectOne(`${url}/u1`).flush(null, { status: 204, statusText: 'No Content' });
    await view();
    await load([]);
  });
});
