import { API, backend } from '../../../../testing/api';
import { cleanUpPage, renderCatalogPage } from '../../../../testing/catalog-page';
import { aCardType } from '../../../../testing/fidelity';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { Role } from '../../../core/session/session.types';
import { CardTypesPage } from './card-types-page';

const GOLD = aCardType({ id: 'c1', name: 'Gold', discountPercentage: 5 });
const SILVER = aCardType({
  id: 'c2',
  name: 'Silver',
  enabled: false,
  discountPercentage: null,
  placeIds: ['p1', 'p2'],
});
const FAR = aCardType({ id: 'c3', name: 'Far', placeIds: ['p9'] });

async function render(role: Role = 'SA', permissions = ['fidelity:read', 'fidelity:update']) {
  vi.spyOn(ReferenceApi.prototype, 'places').mockResolvedValue({
    data: [{ id: 'p1', name: 'Centro' }],
    page: { limit: 25, next: null },
  });
  vi.spyOn(ReferenceApi.prototype, 'placeNames').mockResolvedValue({});
  vi.spyOn(ReferenceApi.prototype, 'placeIds').mockResolvedValue(new Set(['p1', 'p2']));
  return renderCatalogPage(CardTypesPage, 'fidelity/card-types', true, {
    inputs: { groupId: 'g1' },
    user: { role, permissions },
  });
}

afterEach(cleanUpPage);

describe('CardTypesPage', () => {
  it('shows name, whether active, discount and stores', async () => {
    const { load, headers, rows } = await render();
    await load([GOLD, SILVER]);
    expect(headers()).toEqual([
      'CATALOG.CARD_TYPES.COLUMN.NAME',
      'CATALOG.CARD_TYPES.COLUMN.ENABLED',
      'CATALOG.CARD_TYPES.COLUMN.DISCOUNT',
      'CATALOG.CARD_TYPES.COLUMN.PLACES',
    ]);
    expect(rows()).toEqual([
      ['Gold', 'CATALOG.YES', '5 %', 'CATALOG.ALL_PLACES'],
      ['Silver', 'CATALOG.NO', '', 'CATALOG.PLACES_COUNT {"count":2}'],
    ]);
  });

  it('only reads for whoever cannot update fidelity', async () => {
    const { load, button, byLabel } = await render('SA', ['fidelity:read']);
    await load([GOLD]);
    expect(button('CATALOG.CARD_TYPES.NEW')).toBeUndefined();
    expect(byLabel('CATALOG.EDIT_LABEL', 'Gold')).toBeNull();
  });

  it('lets the others change every card type, without a note', async () => {
    const { load, byLabel, root } = await render();
    await load([GOLD, FAR]);
    expect(byLabel('CATALOG.EDIT_LABEL', 'Gold')).not.toBeNull();
    expect(byLabel('CATALOG.EDIT_LABEL', 'Far')).not.toBeNull();
    expect(root.querySelector('[role=note]')).toBeNull();
  });

  it('creates a card type', async () => {
    const { load, click, button, type, submit, url, view, toasts } = await render();
    await load([GOLD]);
    await click(button('CATALOG.CARD_TYPES.NEW'));
    backend().expectOne(`${API}/v1/groups/g1/lookup/price-lists`).flush({ data: [] });
    backend().expectOne(`${API}/v1/groups/g1/fidelity/points-collections`).flush({ data: [] });
    await view();
    await type('CATALOG.CARD_TYPES.FIELD.NAME', 'Platinum');
    await submit();
    const request = backend().expectOne(url);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toMatchObject({ name: 'Platinum', placeIds: [] });
    request.flush({ data: GOLD }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual([['success', 'CATALOG.CREATED']]);
    await load([GOLD]);
  });

  it('deletes a card type', async () => {
    const { load, click, byLabel, dialogs, url, view } = await render();
    await load([GOLD]);
    await click(byLabel('CATALOG.DELETE_LABEL', 'Gold'));
    await click(dialogs()[1].querySelectorAll('footer button')[1]);
    const request = backend().expectOne(`${url}/c1`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    await load([]);
  });

  describe('for a company or store administrator', () => {
    it.each<Role>(['CA', 'PA'])(
      '%s sees read-only the card types for the whole group or for stores outside the perimeter',
      async (role) => {
        const { load, byLabel, rows, root, view } = await render(role);
        await load([GOLD, SILVER, FAR]);
        await view();
        expect(byLabel('CATALOG.EDIT_LABEL', 'Gold')).toBeNull();
        expect(byLabel('CATALOG.EDIT_LABEL', 'Silver')).not.toBeNull();
        expect(byLabel('CATALOG.EDIT_LABEL', 'Far')).toBeNull();
        expect(rows().map((row) => row[3])).toEqual([
          'CATALOG.ALL_PLACES · CATALOG.READ_ONLY',
          'CATALOG.PLACES_COUNT {"count":2}',
          'CATALOG.PLACES_COUNT {"count":1} · CATALOG.READ_ONLY',
        ]);
        expect(root.querySelector('[role=note]')?.textContent?.trim()).toBe(
          'CATALOG.CARD_TYPES.LOCKED_NOTE',
        );
      },
    );
  });

  it('closes the editor when the user gives up', async () => {
    const { load, click, button, view, dialogs } = await render();
    await load([]);
    await click(button('CATALOG.CARD_TYPES.NEW'));
    backend().expectOne(`${API}/v1/groups/g1/lookup/price-lists`).flush({ data: [] });
    backend().expectOne(`${API}/v1/groups/g1/fidelity/points-collections`).flush({ data: [] });
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    await click(dialogs()[0].querySelector('form .actions button'));
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    await view();
  });

  it('lets a company or store administrator view, read-only, what they cannot change', async () => {
    const { load, click, byLabel, dialogs, root, view } = await render('CA');
    await load([GOLD]);
    await click(byLabel('CATALOG.VIEW_LABEL', 'Gold'));
    backend().expectOne(`${API}/v1/groups/g1/lookup/price-lists`).flush({ data: [] });
    backend().expectOne(`${API}/v1/groups/g1/fidelity/points-collections`).flush({ data: [] });
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    expect(dialogs()[0].querySelector('h2')?.textContent).toBe('CATALOG.VIEW_TITLE');
    expect(dialogs()[0].querySelector('button[type=submit]')).toBeNull();
    expect(root.querySelector('dialog [role=note]')).not.toBeNull();
  });
});
