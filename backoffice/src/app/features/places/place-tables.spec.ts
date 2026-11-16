import { renderPlace } from '../../../testing/places';
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
});
