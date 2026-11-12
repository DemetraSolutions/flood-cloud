import { API, backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { aPointsCollection } from '../../../../testing/fidelity';
import { PointsCollectionsPage } from './points-collections-page';

const OPEN = aPointsCollection({ id: 'c1', name: 'Open', pointConversion: 10 });
const TIMED = aPointsCollection({
  id: 'c2',
  name: 'Timed',
  enabled: false,
  pointConversion: null,
  dateFrom: '2026-12-01T10:00:00.000Z',
});
const render = (permissions = ['fidelity:read', 'fidelity:update']) =>
  renderCatalogPage(PointsCollectionsPage, 'fidelity/points-collections', true, {
    inputs: { groupId: 'g1' },
    user: { role: 'SA', permissions },
  });

afterEach(cleanUpPage);

describe('PointsCollectionsPage', () => {
  it('shows name, whether active, amount per point and validity', async () => {
    const { load, headers, rows } = await render();
    await load([OPEN, TIMED]);
    expect(headers()).toEqual([
      'CATALOG.POINTS_COLLECTIONS.COLUMN.NAME',
      'CATALOG.POINTS_COLLECTIONS.COLUMN.ENABLED',
      'CATALOG.POINTS_COLLECTIONS.COLUMN.CONVERSION',
      'CATALOG.POINTS_COLLECTIONS.COLUMN.VALIDITY',
    ]);
    const [open, timed] = rows();
    expect(open).toEqual(['Open', 'CATALOG.YES', '10', 'CATALOG.ALWAYS']);
    expect(timed.slice(0, 3)).toEqual(['Timed', 'CATALOG.NO', '']);
    expect(timed[3]).toMatch(/^CATALOG\.VALIDITY \{"from":".*2026.*","to":"…"\}$/);
  });

  it('only reads for whoever cannot update fidelity', async () => {
    const { load, button } = await render(['fidelity:read']);
    await load([OPEN]);
    expect(button('CATALOG.POINTS_COLLECTIONS.NEW')).toBeUndefined();
  });

  it('creates a collection', async () => {
    const { load, click, button, type, submit, url, view, toasts } = await render();
    await load([OPEN]);
    await click(button('CATALOG.POINTS_COLLECTIONS.NEW'));
    backend().expectOne(`${API}/v1/groups/g1/fidelity/prize-catalogues`).flush({ data: [] });
    await view();
    await type('CATALOG.POINTS_COLLECTIONS.FIELD.NAME', 'Autumn');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Autumn', enabled: true });
    request.flush({ data: OPEN }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual([['success', 'CATALOG.CREATED']]);
    await load([OPEN]);
  });

  it('shows the references that block a deletion', async () => {
    const { load, click, byLabel, dialogs, url, view, toasts } = await render();
    await load([OPEN]);
    await click(byLabel('CATALOG.DELETE_LABEL', 'Open'));
    await click(dialogs()[1].querySelectorAll('footer button')[1]);
    backend()
      .expectOne(`${url}/c1`)
      .flush(
        {
          error: {
            code: 'CONFLICT',
            message: 'x',
            details: [{ field: 'cardTypes.a', issue: 'referenced' }],
          },
        },
        { status: 409, statusText: 'Conflict' },
      );
    await view();
    expect(toasts()[0][1]).toContain('CATALOG.ERROR.REFERENCED');
    expect(toasts()[0][1]).toContain('CATALOG.REFERENCED.CARDTYPES');
    await load([OPEN]);
  });

  it('closes the editor when the user gives up', async () => {
    const { load, click, button, view, dialogs } = await render();
    await load([]);
    await click(button('CATALOG.POINTS_COLLECTIONS.NEW'));
    backend().expectOne(`${API}/v1/groups/g1/fidelity/prize-catalogues`).flush({ data: [] });
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    await click(dialogs()[0].querySelector('form .actions button'));
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    await view();
  });
});
