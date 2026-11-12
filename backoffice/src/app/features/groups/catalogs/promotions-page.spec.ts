import { backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { aPromotion } from '../../../../testing/fidelity';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { Role } from '../../../core/session/session.types';
import { PromotionsPage } from './promotions-page';

const EVERYWHERE = aPromotion({ id: 'x1', name: 'Everywhere', code: 'ALL' });
const LOCAL = aPromotion({
  id: 'x2',
  name: 'Local',
  enabled: false,
  conditions: { placeIds: ['p1'], endDate: '2026-12-31T10:00:00.000Z' },
});
const FAR = aPromotion({ id: 'x3', name: 'Far', conditions: { placeIds: ['p9'] } });

function render(role: Role = 'SA', permissions = ['products:read', 'products:update']) {
  const page = { data: [{ id: 'p1', name: 'Centro' }], page: { limit: 25, next: null } };
  vi.spyOn(ReferenceApi.prototype, 'places').mockResolvedValue(page);
  vi.spyOn(ReferenceApi.prototype, 'lookup').mockResolvedValue(page);
  vi.spyOn(ReferenceApi.prototype, 'placeNames').mockResolvedValue({});
  vi.spyOn(ReferenceApi.prototype, 'lookupNames').mockResolvedValue({});
  vi.spyOn(ReferenceApi.prototype, 'placeIds').mockResolvedValue(new Set(['p1', 'p2']));
  return renderCatalogPage(PromotionsPage, 'promotions', true, {
    inputs: { groupId: 'g1' },
    user: { role, permissions },
  });
}

afterEach(cleanUpPage);

describe('PromotionsPage', () => {
  it('shows name, code, whether active, validity and stores', async () => {
    const { load, headers, rows } = await render();
    await load([EVERYWHERE, LOCAL]);
    expect(headers()).toEqual([
      'CATALOG.PROMOTIONS.COLUMN.NAME',
      'CATALOG.PROMOTIONS.COLUMN.CODE',
      'CATALOG.PROMOTIONS.COLUMN.ENABLED',
      'CATALOG.PROMOTIONS.COLUMN.VALIDITY',
      'CATALOG.PROMOTIONS.COLUMN.PLACES',
    ]);
    const [everywhere, local] = rows();
    expect(everywhere).toEqual([
      'Everywhere',
      'ALL',
      'CATALOG.YES',
      'CATALOG.ALWAYS',
      'CATALOG.ALL_PLACES',
    ]);
    expect(local.slice(0, 3)).toEqual(['Local', '', 'CATALOG.NO']);
    expect(local[3]).toMatch(/^CATALOG\.VALIDITY \{"from":"…","to":".*2026.*"\}$/);
    expect(local[4]).toBe('CATALOG.PLACES_COUNT {"count":1}');
  });

  it('only reads without products:update', async () => {
    const { load, button } = await render('SA', ['products:read']);
    await load([EVERYWHERE]);
    expect(button('CATALOG.PROMOTIONS.NEW')).toBeUndefined();
  });

  it('creates a promotion in a wide dialog', async () => {
    const { load, click, button, type, submit, url, view, toasts, dialogs } = await render();
    await load([EVERYWHERE]);
    await click(button('CATALOG.PROMOTIONS.NEW'));
    expect(dialogs()[0].classList.contains('wide')).toBe(true);
    await type('CATALOG.PROMOTIONS.FIELD.NAME', 'Sale');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toMatchObject({ name: 'Sale', enabled: true });
    request.flush({ data: EVERYWHERE }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual([['success', 'CATALOG.CREATED']]);
    await load([EVERYWHERE]);
  });

  it('modifies a promotion', async () => {
    const { load, click, byLabel, type, submit, url, view } = await render();
    await load([EVERYWHERE]);
    await click(byLabel('CATALOG.EDIT_LABEL', 'Everywhere'));
    await type('CATALOG.PROMOTIONS.FIELD.CODE', 'NEW');
    await submit();
    const request = backend().expectOne(`${url}/x1`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ code: 'NEW' });
    request.flush({ data: EVERYWHERE });
    await view();
    await load([EVERYWHERE]);
  });

  it.each<Role>(['CA', 'PA'])(
    '%s sees read-only the promotions for the whole group or for stores outside the perimeter',
    async (role) => {
      const { load, byLabel, rows, root, view } = await render(role);
      await load([EVERYWHERE, LOCAL, FAR]);
      await view();
      expect(byLabel('CATALOG.EDIT_LABEL', 'Everywhere')).toBeNull();
      expect(byLabel('CATALOG.EDIT_LABEL', 'Local')).not.toBeNull();
      expect(byLabel('CATALOG.EDIT_LABEL', 'Far')).toBeNull();
      expect(rows().map((row) => row[4])).toEqual([
        'CATALOG.ALL_PLACES · CATALOG.READ_ONLY',
        'CATALOG.PLACES_COUNT {"count":1}',
        'CATALOG.PLACES_COUNT {"count":1} · CATALOG.READ_ONLY',
      ]);
      expect(root.querySelector('[role=note]')?.textContent?.trim()).toBe(
        'CATALOG.PROMOTIONS.LOCKED_NOTE',
      );
    },
  );

  it('closes the editor when the user gives up', async () => {
    const { load, click, button, view, dialogs } = await render();
    await load([]);
    await click(button('CATALOG.PROMOTIONS.NEW'));
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    await click(dialogs()[0].querySelector('form .actions button'));
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    await view();
  });

  it('lets a company or store administrator view, read-only, what they cannot change', async () => {
    const { load, click, byLabel, dialogs, root } = await render('CA');
    await load([EVERYWHERE]);
    await click(byLabel('CATALOG.VIEW_LABEL', 'Everywhere'));
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    expect(dialogs()[0].querySelector('h2')?.textContent).toBe('CATALOG.VIEW_TITLE');
    expect(dialogs()[0].querySelector('button[type=submit]')).toBeNull();
    expect(root.querySelector('dialog [role=note]')).not.toBeNull();
  });
});
