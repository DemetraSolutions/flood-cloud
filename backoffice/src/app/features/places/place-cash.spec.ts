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
import { fakePlace, renderPlace } from '../../../testing/places';

const label = (key: string) => `PLACES.F.CASH_SETTINGS.${key}`;
const NAME = 'PLACES.CASH.SHIFT_NAME';

afterEach(cleanUp);

describe('PlaceCash', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'cash' });
    const { control, text } = view;
    expect(isChecked(view, label('FAST_LOGIN'))).toBe(false);
    expect(control(`${NAME} 1`).value).toBe('Pranzo');
    expect(control(`${NAME} 2`).value).toBe('Cena');
    expect(text()).toContain('PLACES.G.CASH_SETTINGS.LOGIN');
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'cash' });
    await view.toggle(label('FAST_LOGIN'), true);
    await view.type(`${NAME} 2`, 'Notte');
    await view.type(label('TOTAL_ROUNDING'), '0.05');
    await view.type(label('RECEIPTS_CANCELLATION'), 'sync');
    await savePut(view, 'settings/cash', {
      ...withValue(
        withValue(withValue(storedBlock('cashSettings'), 'fastLogin', true), 'totalRounding', 0.05),
        'receiptsCancellation',
        'sync',
      ),
      workshiftNames: ['Pranzo', 'Notte'],
    });
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('adds and removes shift names, dropping the empty ones from the body', async () => {
    const view = await renderPlace({ path: 'cash' });
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

  it('shows the shift names and the keys of the rooms module only with the feature', async () => {
    const { text, root } = await renderPlace({ path: 'cash', features: [] });
    expect(root.querySelector('fc-rows-editor')).toBeNull();
    expect(text()).not.toContain(label('LOGS'));
  });

  it('disables the add button at the limit of 20 names', async () => {
    const block = storedBlock('cashSettings');
    const place = fakePlace({
      cashSettings: { ...block, workshiftNames: Array.from({ length: 20 }, (_, i) => `T${i}`) },
    });
    const { button } = await renderPlace({ path: 'cash', place });
    expect((button('PLACES.CASH.ADD_SHIFT_NAME') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'cash' });
    await submitTab(view);
    expect(view.root.querySelector('form')).not.toBeNull();
  });

  it('is read-only without the permission to update', async () => {
    const { control, button, buttons, root } = await renderPlace({
      path: 'cash',
      permissions: READ_ONLY,
    });
    expect(control(label('FAST_LOGIN')).disabled).toBe(true);
    expect(button('COMMON.SAVE')).toBeUndefined();
    expect(button('PLACES.CASH.ADD_SHIFT_NAME')).toBeUndefined();
    expect(buttons().filter((b) => b.textContent?.trim() === 'PLACES.REMOVE')).toHaveLength(0);
    expect(root.querySelectorAll('fc-rows-editor')).toHaveLength(1);
  });

  it('puts a 422 on the right control', async () => {
    const view = await renderPlace({ path: 'cash' });
    await view.toggle(label('FAST_LOGIN'), true);
    await failPut(view, 'settings/cash', [
      { field: 'cashSettings.customDiscount', issue: 'incorrect' },
    ]);
    expect(view.error(label('CUSTOM_DISCOUNT'))).toContain('FORM.ISSUE.INCORRECT');
  });
});
