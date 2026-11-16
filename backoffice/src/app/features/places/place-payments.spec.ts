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

const f = (key: string) => `PLACES.F.PAYMENTS.${key}`;
const col = (key: string, row: number) => `PLACES.PAYMENTS.${key} ${row}`;
const STORED = {
  id: 'abc1234',
  name: 'Contanti',
  cash: true,
  electronic: false,
  cheque: false,
  tickets: false,
  electronicInvoiceMode: 'MP01',
};
const NEW_TYPE = {
  name: 'Buoni',
  cash: false,
  electronic: false,
  cheque: false,
  tickets: true,
  electronicInvoiceMode: null,
};

afterEach(cleanUp);

describe('PlacePayments', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'payments' });
    expect(view.control(f('DEFAULT_TYPE')).value).toBe('cash');
    expect(view.control(f('DEFAULT_TYPE')).querySelectorAll('option')).toHaveLength(2);
    expect(view.control(col('NAME', 1)).value).toBe('Contanti');
    expect(isChecked(view, col('CASH', 1))).toBe(true);
    expect(isChecked(view, col('ELECTRONIC', 1))).toBe(false);
    expect(view.control(col('INVOICE_MODE', 1)).value).toBe('MP01');
    expect(view.control(col('INVOICE_MODE', 1)).querySelectorAll('option')).toHaveLength(24);
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'payments' });
    await view.type(f('DEFAULT_TYPE'), 'electronic');
    await view.toggle(f('CHEQUE'), true);
    await view.type(col('NAME', 1), 'Cassa');
    await view.toggle(col('ELECTRONIC', 1), true);
    await view.type(col('INVOICE_MODE', 1), 'MP05');
    const block = withValue(
      withValue(storedBlock('payments'), 'defaultType', 'electronic'),
      'cheque',
      true,
    );
    await savePut(view, 'settings/payments', {
      ...block,
      paymentTypes: [{ ...STORED, name: 'Cassa', electronic: true, electronicInvoiceMode: 'MP05' }],
    });
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('sends a new type without an id and an existing one with its id', async () => {
    const view = await renderPlace({ path: 'payments' });
    await view.click('PLACES.PAYMENTS.ADD');
    expect(view.control(col('NAME', 2)).value).toBe('');
    expect(view.control(col('INVOICE_MODE', 2)).value).toBe('');
    await view.type(col('NAME', 2), 'Buoni');
    await view.toggle(col('TICKETS', 2), true);
    const body = (await savePut(view, 'settings/payments', {
      ...storedBlock('payments'),
      paymentTypes: [STORED, NEW_TYPE],
    })) as { paymentTypes: object[] };
    expect(body.paymentTypes[0]).toHaveProperty('id', 'abc1234');
    expect(body.paymentTypes[1]).not.toHaveProperty('id');
  });

  it('removes a type', async () => {
    const view = await renderPlace({ path: 'payments' });
    (
      view.root.querySelector('button[aria-label*="PLACES.REMOVE_ROW"]') as HTMLButtonElement
    ).click();
    await view.view();
    expect(view.root.querySelectorAll('fc-rows-editor .row')).toHaveLength(0);
    await savePut(view, 'settings/payments', { ...storedBlock('payments'), paymentTypes: [] });
  });

  it('does not save a type without a name', async () => {
    const view = await renderPlace({ path: 'payments' });
    await view.click('PLACES.PAYMENTS.ADD');
    await view.click('COMMON.SAVE');
    expect(view.error(col('NAME', 2))).toBe('FORM.ISSUE.REQUIRED');
  });

  it('puts the 422 of a row on its control', async () => {
    const view = await renderPlace({ path: 'payments' });
    await view.type(col('NAME', 1), 'Altro');
    await failPut(view, 'settings/payments', [
      { field: 'payments.paymentTypes.0.name', issue: 'incorrect' },
      { field: 'payments.defaultType', issue: 'incorrect' },
    ]);
    expect(view.error(col('NAME', 1))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(f('DEFAULT_TYPE'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('shows the 422 of the whole list above the rows', async () => {
    const view = await renderPlace({ path: 'payments' });
    await view.type(col('NAME', 1), 'Altro');
    await failPut(view, 'settings/payments', [
      { field: 'payments.paymentTypes', issue: 'incorrect' },
    ]);
    expect(view.root.querySelector('fc-rows-editor [role=alert]')?.textContent).toContain(
      'FORM.ISSUE.INCORRECT',
    );
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'payments' });
    await submitTab(view);
    await view.blurAll();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'payments', permissions: READ_ONLY });
    expect(view.control(col('NAME', 1)).disabled).toBe(true);
    expect(view.control(f('DEFAULT_TYPE')).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    expect(view.button('PLACES.PAYMENTS.ADD')).toBeUndefined();
    expect(view.button('PLACES.REMOVE')).toBeUndefined();
  });
});
