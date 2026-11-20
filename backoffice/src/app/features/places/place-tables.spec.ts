import { fakePlace, renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failPut,
  isChecked,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';

const f = (key: string) => `PLACES.F.TABLES.${key}`;
const col = (key: string, row: number) => `PLACES.TABLES.${key} ${row}`;

afterEach(cleanUp);

describe('PlaceTables', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'settings/rooms-settings' });
    expect(view.control(f('EXITS_NUMBER')).value).toBe('5');
    expect(isChecked(view, f('EXITS'))).toBe(false);
    expect(view.control(col('TIP_TYPE', 1)).value).toBe('p');
    expect(view.control(col('TIP_AMOUNT', 1)).value).toBe('10');
    expect(view.text()).toContain('PLACES.G.TABLES.TABLE_GROUPS');
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'settings/rooms-settings' });
    await view.toggle(f('EXITS'), true);
    await view.type(f('EXITS_NUMBER'), '7');
    await view.type(f('HALF_PORTION_VALUE'), '3');
    await view.toggle(f('TABLE_GROUPS.STATUS'), true);
    await view.type(col('TIP_TYPE', 1), 'v');
    await view.type(col('TIP_AMOUNT', 1), '2.5');
    let block = withValue(storedBlock('tables'), 'exits', true);
    block = withValue(block, 'exitsNumber', 7);
    block = withValue(block, 'halfPortionValue', 3);
    block = withValue(block, 'tableGroups.status', true);
    await savePut(view, 'settings/tables', { ...block, tipValues: [{ type: 'v', value: 2.5 }] });
  });

  it('falls back to the default of an emptied whole number', async () => {
    const view = await renderPlace({ path: 'settings/rooms-settings' });
    await view.type(f('EXITS_NUMBER'), '');
    await savePut(view, 'settings/tables', storedBlock('tables'));
  });

  it('adds and removes tips', async () => {
    const view = await renderPlace({ path: 'settings/rooms-settings' });
    await view.click('PLACES.TABLES.ADD_TIP');
    expect(view.control(col('TIP_TYPE', 2)).value).toBe('v');
    await view.type(col('TIP_AMOUNT', 2), '12');
    await savePut(view, 'settings/tables', {
      ...storedBlock('tables'),
      tipValues: [
        { type: 'p', value: 10 },
        { type: 'v', value: 12 },
      ],
    });
    (
      view.root.querySelector('button[aria-label*="PLACES.REMOVE_ROW"]') as HTMLButtonElement
    ).click();
    await view.view();
    expect(view.root.querySelectorAll('fc-rows-editor .row')).toHaveLength(0);
  });

  it('puts the 422 of a tip on its control', async () => {
    const view = await renderPlace({ path: 'settings/rooms-settings' });
    await view.type(col('TIP_AMOUNT', 1), '11');
    await failPut(view, 'settings/tables', [
      { field: 'tables.tipValues.0.value', issue: 'incorrect' },
    ]);
    expect(view.error(col('TIP_AMOUNT', 1))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'settings/rooms-settings' });
    await submitTab(view);
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'settings/rooms-settings', permissions: READ_ONLY });
    expect(view.control(col('TIP_AMOUNT', 1)).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    expect(view.button('PLACES.TABLES.ADD_TIP')).toBeUndefined();
    expect(view.button('PLACES.REMOVE')).toBeUndefined();
  });

  describe('rooms settings and reasons', () => {
    const DISCOUNT = 'PLACES.TABLES.DISCOUNT_REASONS';
    const DELETE = 'PLACES.TABLES.DELETE_REASONS';
    const reason = (legend: string, number: number) =>
      `PLACES.REASON_NUMBER ${JSON.stringify({ legend, number })}`;
    const open = () => renderPlace({ path: 'settings/rooms-settings' });
    const block = (changes: Record<string, unknown> = {}) => ({
      ...storedBlock('tables'),
      ...changes,
    });

    it('shows the idle time, the variants per row, the free text switch and the reasons', async () => {
      const view = await open();
      expect(view.text()).toContain('PLACES.G.TABLES.ROOMS');
      expect(view.text()).toContain('PLACES.G.TABLES.REASONS');
      const idle = view.control(f('TABLE_IDLE_MINUTES')) as HTMLSelectElement;
      expect([...idle.options].map((option) => option.value)).toEqual(['15', '20', '30']);
      expect(idle.value).toBe('15');
      expect(isChecked(view, f('VARIANTS_PER_ROW'))).toBe(false);
      expect(isChecked(view, f('REASONS_FREE_TEXT'))).toBe(false);
      expect(view.control(reason(DISCOUNT, 1)).value).toBe('Cortesia');
      expect(view.control(reason(DISCOUNT, 2)).value).toBe('Cliente abituale');
      expect(view.control(reason(DELETE, 1)).value).toBe('Errore');
    });

    it('sends the idle time as a number, the switches and the reasons', async () => {
      const view = await open();
      await view.type(f('TABLE_IDLE_MINUTES'), '20');
      await view.toggle(f('VARIANTS_PER_ROW'), true);
      await view.toggle(f('REASONS_FREE_TEXT'), true);
      await savePut(
        view,
        'settings/tables',
        block({ tableIdleMinutes: 20, variantsPerRow: true, reasonsFreeText: true }),
      );
    });

    it('adds a reason, trims it and removes another', async () => {
      const view = await open();
      await view.click('PLACES.TABLES.ADD_REASON');
      expect(view.root.querySelectorAll('fc-reasons-editor')).toHaveLength(2);
      await view.type(reason(DISCOUNT, 3), '  Amico  ');
      (view.root.querySelector(`button[aria-label*="${DELETE}"]`) as HTMLButtonElement).click();
      await view.view();
      await savePut(
        view,
        'settings/tables',
        block({ discountReasons: ['Cortesia', 'Cliente abituale', 'Amico'], deleteReasons: [] }),
      );
    });

    it('says why a reason with a semicolon, an empty one or a long one cannot be saved', async () => {
      const view = await open();
      await view.type(reason(DISCOUNT, 1), 'uno;due');
      view.control(reason(DISCOUNT, 1)).dispatchEvent(new Event('blur'));
      await view.view();
      expect(view.error(reason(DISCOUNT, 1))).toBe('FORM.ISSUE.SEMICOLON');
      await view.type(reason(DISCOUNT, 1), '');
      view.control(reason(DISCOUNT, 1)).dispatchEvent(new Event('blur'));
      await view.view();
      expect(view.error(reason(DISCOUNT, 1))).toBe('FORM.ISSUE.REQUIRED');
      await view.type(reason(DISCOUNT, 1), 'x'.repeat(101));
      view.control(reason(DISCOUNT, 1)).dispatchEvent(new Event('blur'));
      await view.view();
      expect(view.error(reason(DISCOUNT, 1))).toBe('FORM.ISSUE.MAX_LENGTH');
    });

    it('does not send a reason with a semicolon', async () => {
      const view = await open();
      await view.type(reason(DISCOUNT, 1), 'uno;due');
      await view.click('COMMON.SAVE');
      expect(view.error(reason(DISCOUNT, 1))).toBe('FORM.ISSUE.SEMICOLON');
    });

    it('puts the 422 of a duplicate on the reason of that index', async () => {
      const view = await open();
      await view.type(reason(DELETE, 1), 'Cortesia');
      await failPut(view, 'settings/tables', [
        { field: 'tables.deleteReasons.0', issue: 'incorrect' },
      ]);
      expect(view.error(reason(DELETE, 1))).toContain('FORM.ISSUE.INCORRECT');
    });

    it('stops adding at 50 reasons and tells when there are none', async () => {
      const many = Array.from({ length: 50 }, (_, index) => `Motivo ${index}`);
      const view = await renderPlace({
        path: 'settings/rooms-settings',
        place: fakePlace({
          tables: { ...storedBlock('tables'), discountReasons: many, deleteReasons: [] },
        }),
      });
      const adds = [...view.root.querySelectorAll('fc-reasons-editor')].map(
        (editor) => editor.querySelector('button[disabled]') !== null,
      );
      expect(adds).toEqual([true, false]);
      expect(
        view.root.querySelectorAll('fc-reasons-editor .problem, fc-reasons-editor .note'),
      ).toHaveLength(1);
      expect(view.text()).toContain('PLACES.NO_REASONS');
    });

    it('adds a deletion reason and removes a discount reason, each from its own list', async () => {
      const view = await open();
      const adds = [...view.root.querySelectorAll('fc-reasons-editor')].map(
        (editor) => editor.querySelectorAll('button')[editor.querySelectorAll('button').length - 1],
      );
      adds[1].click();
      await view.view();
      await view.type(reason(DELETE, 2), 'Doppio');
      (view.root.querySelector(`button[aria-label*="${DISCOUNT}"]`) as HTMLButtonElement).click();
      await view.view();
      await savePut(
        view,
        'settings/tables',
        block({ discountReasons: ['Cliente abituale'], deleteReasons: ['Errore', 'Doppio'] }),
      );
    });

    it('shows the 422 of a whole list above it', async () => {
      const view = await open();
      await view.type(reason(DISCOUNT, 1), 'Altro');
      await failPut(view, 'settings/tables', [
        { field: 'tables.discountReasons', issue: 'tooMany' },
      ]);
      expect(view.root.querySelector('fc-reasons-editor .problem')?.textContent).toContain(
        'FORM.ISSUE.TOO_MANY',
      );
    });

    it('is read-only without the permission to update', async () => {
      const view = await renderPlace({ path: 'settings/rooms-settings', permissions: READ_ONLY });
      expect(view.control(reason(DISCOUNT, 1)).disabled).toBe(true);
      expect(view.control(f('TABLE_IDLE_MINUTES')).disabled).toBe(true);
      expect(view.button('PLACES.TABLES.ADD_REASON')).toBeUndefined();
    });
  });
});
