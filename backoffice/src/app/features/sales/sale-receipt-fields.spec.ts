import { TestBed } from '@angular/core/testing';
import { findControl } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReceiptForm } from './sale-forms';
import { SaleReceiptFields } from './sale-receipt-fields';

const VALUE: ReceiptForm = { date: '2026-11-20T10:30', report: '1', number: '2', amount: '3.00' };
const LABELS = {
  date: 'SALES.ACTION.RECEIPT_DATE',
  report: 'SALES.ACTION.RECEIPT_REPORT',
  number: 'SALES.ACTION.RECEIPT_NUMBER',
  amount: 'SALES.ACTION.AMOUNT_LABEL {"label":"SALES.ACTION.RECEIPT_AMOUNT","symbol":"€"}',
} as const;

async function render(inputs: Record<string, unknown> = {}) {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(SaleReceiptFields);
  fixture.componentRef.setInput('legend', 'Scontrino');
  fixture.componentRef.setInput('value', VALUE);
  fixture.componentRef.setInput('issues', {});
  fixture.componentRef.setInput('prefix', 'refund');
  fixture.componentRef.setInput('symbol', '€');
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  const emitted: ReceiptForm[] = [];
  fixture.componentInstance.valueChange.subscribe((value) => emitted.push(value));
  await fixture.whenStable();
  return { fixture, emitted, root: fixture.nativeElement as HTMLElement };
}

afterEach(() => vi.restoreAllMocks());

describe('SaleReceiptFields', () => {
  it('shows the legend, the hint and the four fields with the value', async () => {
    const { fixture, root } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('Scontrino');
    expect(root.textContent).toContain('SALES.ACTION.RECEIPT_HINT');
    expect(findControl(fixture, LABELS.date).value).toBe(VALUE.date);
    expect(findControl(fixture, LABELS.report).value).toBe('1');
    expect(findControl(fixture, LABELS.number).value).toBe('2');
    expect(findControl(fixture, LABELS.amount).value).toBe('3.00');
    expect(root.querySelector('fieldset')?.disabled).toBe(false);
  });

  it.each(Object.entries(LABELS))('emits the whole value with the %s typed', async (field, label) => {
    const { fixture, emitted } = await render();
    const control = findControl(fixture, label);
    control.value = field === 'date' ? '2026-12-01T08:00' : '9';
    control.dispatchEvent(new Event('input'));
    expect(emitted).toEqual([{ ...VALUE, [field]: control.value }]);
  });

  it('shows the message of the issue of a field under its prefix, and none for the others', async () => {
    const { fixture, root } = await render({
      issues: { 'refund.report': 'type', 'refund.date': 'format', 'refund.number': 'maximum', 'refund.amount': 'type', 'other.report': 'type' },
    });
    const texts = [...root.querySelectorAll('.error')].map((e) => e.textContent?.trim());
    expect(texts).toEqual(['FORM.ISSUE.FORMAT', 'FORM.ISSUE.TYPE', 'FORM.ISSUE.MAXIMUM', 'FORM.ISSUE.TYPE']);
    expect(findControl(fixture, LABELS.report).getAttribute('aria-invalid')).toBe('true');
  });

  it('shows no message without issues', async () => {
    const { root } = await render({ issues: { 'other.report': 'type' } });
    expect([...root.querySelectorAll('.error')].map((e) => e.textContent?.trim())).toEqual(['', '', '', '']);
  });

  it('disables the fields', async () => {
    const { root } = await render({ disabled: true });
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });

  it('shows a hint under each field', async () => {
    const { root } = await render();
    expect([...root.querySelectorAll('.hint')].map((e) => e.textContent?.trim())).toEqual([
      'SALES.ACTION.RECEIPT_DATE_HINT',
      'SALES.ACTION.RECEIPT_REPORT_HINT',
      'SALES.ACTION.RECEIPT_NUMBER_HINT',
      'SALES.ACTION.RECEIPT_AMOUNT_HINT',
    ]);
  });

  it('puts the symbol of the currency in the label of the amount', async () => {
    const { fixture } = await render({ symbol: '$' });
    expect(findControl(fixture, 'SALES.ACTION.AMOUNT_LABEL {"label":"SALES.ACTION.RECEIPT_AMOUNT","symbol":"$"}').value).toBe('3.00');
  });
});
