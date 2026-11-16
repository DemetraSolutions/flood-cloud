import {
  cleanUp,
  isChecked,
  failPut,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';
import { fakePlace, GROUP, renderPlace } from '../../../testing/places';

const label = (key: string) => `PLACES.F.CASH_SETTINGS.${key}`;
const NAME = 'PLACES.CASH.SHIFT_NAME';

afterEach(cleanUp);

describe('PlaceCash', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'settings/general' });
    const { control, text } = view;
    expect(isChecked(view, label('FAST_LOGIN'))).toBe(false);
    expect(control(`${NAME} 1`).value).toBe('Pranzo');
    expect(control(`${NAME} 2`).value).toBe('Cena');
    expect(text()).toContain('PLACES.G.CASH_SETTINGS.GENERAL');
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'settings/general' });
    await view.toggle(label('FAST_LOGIN'), true);
    await view.type(`${NAME} 2`, 'Notte');
    await view.type(label('TOTAL_ROUNDING'), '0.05');
    await savePut(view, 'settings/cash', {
      ...withValue(
        withValue(storedBlock('cashSettings'), 'fastLogin', true),
        'totalRounding',
        0.05,
      ),
      workshiftNames: ['Pranzo', 'Notte'],
    });
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('adds and removes shift names, dropping the empty ones from the body', async () => {
    const view = await renderPlace({ path: 'settings/general' });
    await view.click('PLACES.CASH.ADD_SHIFT_NAME');
    expect(view.control(`${NAME} 3`).value).toBe('');
    await view.type(`${NAME} 3`, ' Brunch ');
    await view.click('PLACES.CASH.ADD_SHIFT_NAME');
    const remove = view.root.querySelectorAll<HTMLButtonElement>(
      'button[aria-label*="PLACES.REMOVE_ROW"]',
    );
    expect(remove).toHaveLength(4);
    remove[0].click();
    await view.view();
    await savePut(view, 'settings/cash', {
      ...storedBlock('cashSettings'),
      workshiftNames: ['Cena', 'Brunch'],
    });
  });

  it('shows the keys of the rooms module to a platform administrator whatever the features', async () => {
    const { text, root } = await renderPlace({ path: 'settings/general', features: [] });
    expect(root.querySelectorAll('fc-rows-editor')).toHaveLength(1);
    expect(text()).toContain(label('LOGS'));
  });

  it('shows the keys of the rooms module to the other roles only with the feature', async () => {
    const profile = { role: 'SA' as const, groupId: GROUP };
    const without = await renderPlace({ path: 'settings/general', features: [], profile });
    expect(without.text()).not.toContain(label('LOGS'));
    expect(without.text()).not.toContain(label('LOCAL_WAREHOUSE'));
  });

  it('shows the keys of the rooms module to the other roles with the feature', async () => {
    const profile = { role: 'SA' as const, groupId: GROUP };
    const view = await renderPlace({ path: 'settings/general', features: ['rooms'], profile });
    expect(view.text()).toContain(label('LOGS'));
    expect(view.text()).not.toContain(label('LOCAL_WAREHOUSE'));
  });

  it('disables the add button at the limit of 20 names', async () => {
    const block = storedBlock('cashSettings');
    const place = fakePlace({
      cashSettings: { ...block, workshiftNames: Array.from({ length: 20 }, (_, i) => `T${i}`) },
    });
    const { button } = await renderPlace({ path: 'settings/general', place });
    expect((button('PLACES.CASH.ADD_SHIFT_NAME') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'settings/general' });
    await submitTab(view);
    expect(view.root.querySelector('form')).not.toBeNull();
  });

  it('is read-only without the permission to update', async () => {
    const { control, button, buttons, root } = await renderPlace({
      path: 'settings/general',
      permissions: READ_ONLY,
    });
    expect(control(label('FAST_LOGIN')).disabled).toBe(true);
    expect(button('COMMON.SAVE')).toBeUndefined();
    expect(button('PLACES.CASH.ADD_SHIFT_NAME')).toBeUndefined();
    expect(buttons().filter((b) => b.textContent?.trim() === 'PLACES.REMOVE')).toHaveLength(0);
    expect(root.querySelectorAll('fc-rows-editor')).toHaveLength(1);
  });

  it('puts a 422 on the right control', async () => {
    const view = await renderPlace({ path: 'settings/general' });
    await view.toggle(label('FAST_LOGIN'), true);
    await failPut(view, 'settings/cash', [
      { field: 'cashSettings.customDiscount', issue: 'incorrect' },
    ]);
    expect(view.error(label('CUSTOM_DISCOUNT'))).toContain('FORM.ISSUE.INCORRECT');
  });
});
