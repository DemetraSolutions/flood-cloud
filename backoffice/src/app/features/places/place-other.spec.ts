import { fakePlace, renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failPut,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';

const CANCELLATION = 'PLACES.F.CASH_SETTINGS.RECEIPTS_CANCELLATION';

afterEach(cleanUp);

describe('PlaceOther', () => {
  it('shows only the receipts cancellation, with the empty choice for none', async () => {
    const view = await renderPlace({ path: 'settings/other' });
    const select = view.control(CANCELLATION) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
      'PLACES.NONE_OF.RECEIPTS_CANCELLATION',
      'PLACES.OPTION.RECEIPTS_CANCELLATION.SYNC',
      'PLACES.OPTION.RECEIPTS_CANCELLATION.NOT_SYNC',
    ]);
    expect(view.root.querySelectorAll('fieldset')).toHaveLength(1);
    expect(view.text()).not.toContain('PLACES.F.CASH_SETTINGS.FAST_LOGIN');
  });

  it('shows the stored choice', async () => {
    const block = withValue(storedBlock('cashSettings'), 'receiptsCancellation', 'notSync');
    const view = await renderPlace({
      path: 'settings/other',
      place: fakePlace({ cashSettings: block }),
    });
    expect((view.control(CANCELLATION) as HTMLSelectElement).value).toBe('notSync');
  });

  it('saves the choice in the cash settings', async () => {
    const view = await renderPlace({ path: 'settings/other' });
    await view.type(CANCELLATION, 'sync');
    await savePut(
      view,
      'settings/cash',
      withValue(storedBlock('cashSettings'), 'receiptsCancellation', 'sync'),
    );
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('puts the 422 on the control', async () => {
    const view = await renderPlace({ path: 'settings/other' });
    await view.type(CANCELLATION, 'sync');
    await failPut(view, 'settings/cash', [
      { field: 'cashSettings.receiptsCancellation', issue: 'incorrect' },
    ]);
    expect(view.error(CANCELLATION)).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'settings/other' });
    await submitTab(view);
    expect(view.root.querySelector('form')).not.toBeNull();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'settings/other', permissions: READ_ONLY });
    expect((view.control(CANCELLATION) as HTMLSelectElement).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
  });
});
