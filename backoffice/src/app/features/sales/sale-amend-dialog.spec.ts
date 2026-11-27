import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { findControl } from '../../../testing/forms';
import { forbidden, invalid, requestTo, SALE_FAILURES } from '../../../testing/sale-dialogs';
import { aSaleDetail, SALE_ID } from '../../../testing/sales';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactApi } from '../contacts/contact-api';
import { SaleAmendDialog } from './sale-amend-dialog';
import { SaleApi } from './sale-api';
import { SaleReceiptFields } from './sale-receipt-fields';
import { SaleDetail } from './sale.types';

const URL = `${API}/v1/groups/g1/sales/${SALE_ID}`;
/** The label of an amount field: its name and the symbol of the currency. */
const money = (key: string) => `SALES.ACTION.AMOUNT_LABEL {"label":"${key}","symbol":"€"}`;
const CASH = money('SALES.PAYMENT.CASH');
const ELECTRONIC = money('SALES.PAYMENT.ELECTRONIC');
const CREDIT = money('SALES.PAYMENT.FIDELITYCREDIT');
const CARD = 'SALES.ACTION.CARD_CODE';
const LOTTERY = 'SALES.ACTION.LOTTERY';
const RECEIPT_DATE = 'SALES.ACTION.RECEIPT_DATE';
const RECEIPT_REPORT = 'SALES.ACTION.RECEIPT_REPORT';
const RECEIPT_NUMBER = 'SALES.ACTION.RECEIPT_NUMBER';
const RECEIPT_AMOUNT = money('SALES.ACTION.RECEIPT_AMOUNT');
const SUBMIT = 'SALES.ACTION.AMEND_SUBMIT';
const FULL = ['sales:write', 'contacts:read', 'fidelity:read', 'fidelity:update'];

@Component({
  imports: [SaleAmendDialog],
  template: `<fc-sale-amend-dialog
    groupId="g1"
    currency="EUR"
    [sale]="sale()"
    [refreshing]="refreshing()"
    [(open)]="open"
    (done)="done = done + 1"
    (reread)="reread = reread + 1"
  />`,
})
class Host {
  readonly open = signal(false);
  readonly sale = signal<SaleDetail>(aSaleDetail());
  readonly refreshing = signal(false);
  done = 0;
  reread = 0;
}

async function render(permissions: string[] = FULL, searched: { value: string; label: string }[] = []) {
  emulateNativeDialog();
  const search = vi.fn(async (_group: string, _text: string) => searched);
  TestBed.configureTestingModule({
    providers: [...provideApiTesting(), { provide: ContactApi, useValue: { searchContacts: search } }],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', permissions });
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
  const host = fixture.componentInstance;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const open = async () => {
    host.open.set(true);
    await view();
  };
  await view();
  const dialog = () => root.querySelector('dialog')!;
  const control = (label: string) => findControl(fixture, label);
  const type = async (label: string, text: string) => {
    const input = control(label);
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) => b.textContent?.trim() === text)!;
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const errorOf = (label: string) => {
    const input = control(label);
    const id = input.getAttribute('aria-describedby')?.split(' ').find((i) => i.endsWith('-error'));
    return id === undefined ? '' : root.querySelector(`#${id}`)!.textContent!.trim();
  };
  const failure = () => root.querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const send = async (answer: (request: ReturnType<typeof requestTo>) => void = (r) => r.flush({ data: {} })) => {
    await submit();
    const request = requestTo(backend(), URL);
    answer(request);
    await view();
    return request;
  };
  return { fixture, host, root, view, open, dialog, control, type, button, submit, errorOf, failure, send, search };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SaleAmendDialog', () => {
  it('opens with the values of the sale and without the lottery code', async () => {
    const { open, dialog, control, root } = await render();
    expect(dialog().hasAttribute('open')).toBe(false);
    await open();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().querySelector('h2')?.textContent).toBe(
      'SALES.ACTION.AMEND_TITLE {"reference":"SALES.REFERENCE.NUMBER {\\"number\\":\\"12-345\\"}"}',
    );
    expect(root.textContent).toContain('SALES.ACTION.SUMMARY');
    expect(control(CASH).value).toBe('30.00');
    expect(control(ELECTRONIC).value).toBe('0.00');
    expect(control(CARD).value).toBe('CARD1');
    expect(control(RECEIPT_REPORT).value).toBe('12');
    expect(control(RECEIPT_NUMBER).value).toBe('345');
    expect(control(RECEIPT_AMOUNT).value).toBe('30.00');
    expect(control(RECEIPT_DATE).value).not.toBe('');
    expect(control(LOTTERY).value).toBe('');
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('disables the customer and the card of an invoiced sale, and says why, but not the payments', async () => {
    const { open, host, root, view } = await render();
    host.sale.set(aSaleDetail({ invoiced: true }));
    await open();
    await view();
    const disabled = [...root.querySelectorAll('dialog fieldset')].map((f) => (f as HTMLFieldSetElement).disabled);
    expect(root.textContent).toContain('SALES.ACTION.INVOICED_NOTE');
    expect(disabled.filter(Boolean).length).toBe(2);
    expect(disabled[0]).toBe(false);
  });

  it('starts clean at every opening', async () => {
    const { open, host, control, type, submit, view, failure } = await render();
    await open();
    await type(CASH, 'abc');
    await type(LOTTERY, 'LOT');
    await submit();
    expect(control(CASH).value).toBe('abc');
    host.open.set(false);
    await view();
    await open();
    expect(control(CASH).value).toBe('30.00');
    expect(control(LOTTERY).value).toBe('');
    expect(failure()).toBeNull();
    expect(host.sale().id).toBe(SALE_ID);
  });

  it('says nothing changed and sends nothing', async () => {
    const { open, submit, root, failure } = await render();
    await open();
    expect(root.textContent).not.toContain('SALES.ACTION.NOTHING_CHANGED');
    await submit();
    expect(failure()).toBe('SALES.ACTION.NOTHING_CHANGED');
    expect(document.activeElement).toBe(root.querySelector('fc-form-error'));
    backend().expectNone(URL);
  });

  it('sends only the payments that changed, with the version in quotes, and closes when done', async () => {
    const { open, host, type, send, dialog, root } = await render();
    await open();
    await type(CASH, '25,5');
    await type(ELECTRONIC, '4.5');
    const request = await send();
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.params.has('nonFiscal')).toBe(false);
    expect(request.request.body).toEqual({ payments: { cash: 25.5, electronic: 4.5 } });
    expect(host.done).toBe(1);
    expect(host.open()).toBe(false);
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(host.reread).toBe(0);
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('asks for the non fiscal sales when the sale is one', async () => {
    const { open, host, type, send } = await render();
    host.sale.set(aSaleDetail({ nonFiscal: true, version: 'v9' }));
    await open();
    await type(CASH, '1');
    const request = await send();
    expect(request.request.params.get('nonFiscal')).toBe('include');
    expect(request.request.headers.get('If-Match')).toBe('"v9"');
  });

  it('is locked while the request runs and cannot send a second one', async () => {
    const { open, host, type, submit, button, root, view, dialog } = await render();
    await open();
    await type(CASH, '1');
    await submit();
    const request = requestTo(backend(), URL);
    expect(button('SALES.ACTION.GO_BACK').disabled).toBe(true);
    expect(button(SUBMIT).disabled).toBe(true);
    expect(button(SUBMIT).getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>('dialog header button')!.disabled).toBe(true);
    const cancel = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await submit();
    backend().expectNone(URL);
    request.flush({ data: {} });
    await view();
    expect(host.done).toBe(1);
  });

  it('closes without sending with the close button and when the browser closes the dialog', async () => {
    const { open, host, root, view, dialog } = await render();
    await open();
    root.querySelector<HTMLButtonElement>('dialog header button')!.click();
    await view();
    expect(host.open()).toBe(false);
    await open();
    dialog().removeAttribute('open');
    dialog().dispatchEvent(new Event('close'));
    await view();
    expect(host.open()).toBe(false);
    expect(host.done).toBe(0);
  });

  it('closes without sending with the safe button', async () => {
    const { open, host, button, view } = await render();
    await open();
    button('SALES.ACTION.GO_BACK').click();
    await view();
    expect(host.open()).toBe(false);
    expect(host.done).toBe(0);
  });

  describe('customer', () => {
    it('shows the customer of the sale and sends the one chosen with the search', async () => {
      const { open, root, search, view, send } = await render(FULL, [
        { value: 'c2', label: 'Bianchi srl' },
      ]);
      await open();
      const combobox = root.querySelector<HTMLInputElement>('input[role=combobox]')!;
      expect(combobox.value).toBe('Verdi srl');
      combobox.dispatchEvent(new Event('focus'));
      await view();
      expect(search).toHaveBeenCalledWith('g1', '');
      root.querySelector<HTMLElement>('li[role=option]')!.click();
      await view();
      expect(combobox.value).toBe('Bianchi srl');
      const request = await send();
      expect(request.request.body).toEqual({ customer: { contactId: 'c2' } });
    });

    it('shows an empty search for a sale without a customer', async () => {
      const { open, host, root } = await render();
      host.sale.set(aSaleDetail({ customer: null }));
      await open();
      expect(root.querySelector<HTMLInputElement>('input[role=combobox]')!.value).toBe('');
      expect(root.querySelector('button[aria-label="SALES.ACTION.CUSTOMER_CLEAR"]')).toBeNull();
    });

    it('takes the customer away with the clear button and sends null', async () => {
      const { open, root, view, send } = await render();
      await open();
      root.querySelector<HTMLButtonElement>('button[aria-label="SALES.ACTION.CUSTOMER_CLEAR"]')!.click();
      await view();
      const request = await send();
      expect(request.request.body).toEqual({ customer: null });
    });

    it('does not offer the search without the permission to read the contacts', async () => {
      const { open, root } = await render(['sales:write', 'fidelity:read']);
      await open();
      expect(root.querySelector('input[role=combobox]')).toBeNull();
      expect(root.textContent).toContain('SALES.ACTION.CUSTOMER_NO_ACCESS');
    });
  });

  describe('card, receipt and lottery', () => {
    it('sends the card code that changed, or null when it is emptied', async () => {
      const { open, type, send, host, view } = await render();
      await open();
      await type(CARD, ' NEW ');
      expect((await send()).request.body).toEqual({ fidelityCardCode: 'NEW' });
      host.open.set(false);
      await view();
      await open();
      await type(CARD, '  ');
      expect((await send()).request.body).toEqual({ fidelityCardCode: null });
    });

    it('does not show the card code without the permission to read the cards', async () => {
      const { open, root, type, send } = await render(['sales:write', 'contacts:read']);
      await open();
      expect([...root.querySelectorAll('label')].some((l) => l.textContent?.trim() === CARD)).toBe(false);
      await type(CASH, '2');
      expect((await send()).request.body).toEqual({ payments: { cash: 2 } });
    });

    it('sends the whole fiscal receipt when a field of it changed', async () => {
      const { open, type, send } = await render();
      await open();
      await type(RECEIPT_NUMBER, '400');
      const body = (await send()).request.body as { fiscalReceiptInfo: Record<string, unknown> };
      expect(body.fiscalReceiptInfo).toMatchObject({ report: 12, number: 400, amount: 30 });
      expect(typeof body.fiscalReceiptInfo['date']).toBe('string');
    });

    it('sends null when the whole receipt is emptied', async () => {
      const { open, type, send } = await render();
      await open();
      for (const label of [RECEIPT_DATE, RECEIPT_REPORT, RECEIPT_NUMBER, RECEIPT_AMOUNT]) {
        await type(label, '');
      }
      expect((await send()).request.body).toEqual({ fiscalReceiptInfo: null });
    });

    it('sends the lottery code only when it is typed', async () => {
      const { open, type, send } = await render();
      await open();
      await type(LOTTERY, ' ABCD1234 ');
      expect((await send()).request.body).toEqual({ lotteryCode: 'ABCD1234' });
    });
  });

  describe('issues of the form', () => {
    it('shows them only after the user tried to send, and does not send', async () => {
      const { open, type, submit, errorOf } = await render();
      await open();
      await type(CASH, 'abc');
      await type(ELECTRONIC, '');
      expect(errorOf(CASH)).toBe('');
      await submit();
      expect(errorOf(CASH)).toBe('FORM.ISSUE.TYPE');
      expect(errorOf(ELECTRONIC)).toBe('FORM.ISSUE.REQUIRED');
      backend().expectNone(URL);
    });

    it('refuses a card code and a lottery code that are too long and a negative amount', async () => {
      const { open, type, submit, errorOf } = await render();
      await open();
      await type(CARD, 'x'.repeat(65));
      await type(LOTTERY, 'y'.repeat(33));
      await type(CASH, '-3');
      await submit();
      expect(errorOf(CARD)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(errorOf(LOTTERY)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(errorOf(CASH)).toBe('FORM.ISSUE.TYPE');
      backend().expectNone(URL);
    });

    it('refuses a date of the receipt that is not a date', async () => {
      const { open, fixture, submit, errorOf, view } = await render();
      await open();
      const fields = fixture.debugElement.query(By.directive(SaleReceiptFields)).componentInstance as SaleReceiptFields;
      fields.valueChange.emit({ date: 'not a date', report: '12', number: '345', amount: '30.00' });
      await view();
      await submit();
      expect(errorOf(RECEIPT_DATE)).toBe('FORM.ISSUE.FORMAT');
      backend().expectNone(URL);
    });
  });

  describe('issues of the server', () => {
    const MAPPED: [string, string][] = [
      ['payments.cash', CASH],
      ['payments.electronic', ELECTRONIC],
      ['payments.cheque', money('SALES.PAYMENT.CHEQUE')],
      ['payments.tickets', money('SALES.PAYMENT.TICKETS')],
      ['payments.fidelityCredit', CREDIT],
      ['fidelityCardCode', CARD],
      ['lotteryCode', LOTTERY],
      ['fiscalReceiptInfo.date', RECEIPT_DATE],
      ['fiscalReceiptInfo.report', RECEIPT_REPORT],
      ['fiscalReceiptInfo.number', RECEIPT_NUMBER],
      ['fiscalReceiptInfo.amount', RECEIPT_AMOUNT],
    ];

    it.each(MAPPED)('shows the issue of %s under its field', async (field, label) => {
      const { open, type, send, errorOf, failure, control } = await render();
      await open();
      await type(CASH, '1');
      await send(invalid([{ field, issue: 'type' }]));
      expect(errorOf(label)).toBe('FORM.ISSUE.TYPE');
      expect(failure()).toBe('ERRORS.API.VALIDATION_ERROR');
      expect(document.activeElement).toBe(control(label));
      expect(backend().match(() => true)).toEqual([]);
    });

    it.each(['customer', 'customer.contactId'])('shows the issue of %s under the customer', async (field) => {
      const { open, type, send, root } = await render();
      await open();
      await type(CASH, '1');
      await send(invalid([{ field, issue: 'notAllowed' }]));
      const combobox = root.querySelector<HTMLInputElement>('input[role=combobox]')!;
      expect(combobox.getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector('fc-search-combobox .error')?.textContent?.trim()).toBe('FORM.ISSUE.NOT_ALLOWED');
      expect(document.activeElement).toBe(combobox);
    });

    it('ignores a field it does not know and shows the general message', async () => {
      const { open, type, send, failure, root } = await render();
      await open();
      await type(CASH, '1');
      await send(invalid([{ field: 'products.0.quantity', issue: 'type' }, { field: 'constructor', issue: 'type' }]));
      expect(failure()).toBe('SALES.ACTION.INVALID_UNMAPPED');
      expect([...root.querySelectorAll('.error span')].map((e) => e.textContent)).toEqual([]);
    });

    it('lets the user fix the field and send again', async () => {
      const { open, type, send, errorOf, host } = await render();
      await open();
      await type(CASH, '1');
      await send(invalid([{ field: 'payments.cash', issue: 'maximum' }]));
      expect(errorOf(CASH)).toBe('FORM.ISSUE.MAXIMUM');
      await type(CASH, '2');
      await send();
      expect(host.done).toBe(1);
    });
  });

  describe('failures', () => {
    it.each(SALE_FAILURES)('shows the message of a $name and keeps the dialog open', async (failureCase) => {
      const { open, type, send, failure, host } = await render();
      await open();
      await type(CASH, '1');
      await send(failureCase.answer);
      if (failureCase.message === null) {
        expect(failure()).toContain(failureCase.contains);
      } else {
        expect(failure()).toBe(failureCase.message);
      }
      expect(host.reread).toBe(failureCase.reread ? 1 : 0);
      expect(host.open()).toBe(true);
      expect(host.done).toBe(0);
    });

    it.each([
      ['credit', CREDIT, '5'],
      ['card', CARD, 'OTHER'],
      ['cash', CASH, '1'],
    ])('uses the central message for a 403 of a write of the %s', async (_name, label, text) => {
      const { open, type, send, failure } = await render();
      await open();
      await type(label, text);
      await send(forbidden);
      expect(failure()).toBe('ERRORS.API.FORBIDDEN');
    });

    it('logs an error that is not an API error and shows the generic message', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const error = new Error('boom');
      vi.spyOn(SaleApi.prototype, 'amend').mockRejectedValue(error);
      const { open, type, submit, failure, host } = await render();
      await open();
      await type(CASH, '1');
      await submit();
      expect(failure()).toBe('ERRORS.GENERIC.MESSAGE');
      expect(log).toHaveBeenCalledWith(error);
      expect(host.reread).toBe(0);
    });

    it('cannot send after an uncertain outcome until the page has read the sale again', async () => {
      const { open, type, send, submit, host, view, button } = await render();
      await open();
      await type(CASH, '1');
      await send((request) => request.error(new ProgressEvent('error')));
      expect(host.reread).toBe(1);
      expect(button(SUBMIT).disabled).toBe(true);
      await submit();
      backend().expectNone(URL);
      host.refreshing.set(true);
      await view();
      await submit();
      backend().expectNone(URL);
      host.refreshing.set(false);
      await view();
      expect(button(SUBMIT).disabled).toBe(false);
      await send();
      expect(host.done).toBe(1);
    });
  });

  describe('sale that changes while the dialog is open', () => {
    it('loads the form again from the new data and says so', async () => {
      const { open, host, type, control, root, view } = await render();
      await open();
      await type(CASH, '99');
      await type(CARD, 'TYPED');
      expect(root.textContent).not.toContain('SALES.ACTION.UPDATED');
      host.sale.set(
        aSaleDetail({
          version: 'v2',
          fidelityCardCode: 'CARD2',
          payments: { cash: 10, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 0, unpaid: 0 },
        }),
      );
      await view();
      expect(control(CASH).value).toBe('10.00');
      expect(control(CARD).value).toBe('CARD2');
      expect(root.querySelector('p.warning[role=status]')?.textContent).toContain('SALES.ACTION.UPDATED');
    });

    it('sends against the new version', async () => {
      const { open, host, type, send, view } = await render();
      await open();
      host.sale.set(aSaleDetail({ version: 'v2' }));
      await view();
      await type(CASH, '1');
      expect((await send()).request.headers.get('If-Match')).toBe('"v2"');
    });

    it('ignores a sale with the same version', async () => {
      const { open, host, type, control, root, view } = await render();
      await open();
      await type(CASH, '99');
      host.sale.set(aSaleDetail({ version: 'v1' }));
      await view();
      expect(control(CASH).value).toBe('99');
      expect(root.textContent).not.toContain('SALES.ACTION.UPDATED');
    });

    it('does not touch the form while the dialog is closed, and forgets the warning when it opens again', async () => {
      const { open, host, root, view, control } = await render();
      await open();
      host.sale.set(aSaleDetail({ version: 'v2' }));
      await view();
      expect(root.textContent).toContain('SALES.ACTION.UPDATED');
      host.open.set(false);
      await view();
      host.sale.set(aSaleDetail({ version: 'v3', fidelityCardCode: 'CARD3' }));
      await view();
      expect(root.textContent).toContain('SALES.ACTION.UPDATED');
      await open();
      expect(root.textContent).not.toContain('SALES.ACTION.UPDATED');
      expect(control(CARD).value).toBe('CARD3');
    });
  });

  describe('while it sends and while the sale is read again', () => {
    const FIELDS = [CASH, ELECTRONIC, CREDIT, CARD, LOTTERY, RECEIPT_DATE, RECEIPT_REPORT, RECEIPT_NUMBER, RECEIPT_AMOUNT];

    it('disables every field while the request runs', async () => {
      const { open, type, submit, control, root, view } = await render();
      await open();
      await type(CASH, '1');
      expect(root.querySelector('p[role=status]')).toBeNull();
      await submit();
      const request = requestTo(backend(), URL);
      for (const label of FIELDS) {
        expect(control(label).matches(':disabled'), label).toBe(true);
      }
      expect(root.querySelector<HTMLInputElement>('input[role=combobox]')!.matches(':disabled')).toBe(true);
      request.flush({ data: {} });
      await view();
    });

    it('disables every field and says it is reading the sale until the page has read it', async () => {
      const { open, type, send, control, root, host, view } = await render();
      await open();
      await type(CASH, '1');
      await send(fail500);
      expect(root.textContent).toContain('SALES.ACTION.REREADING');
      for (const label of FIELDS) {
        expect(control(label).matches(':disabled'), label).toBe(true);
      }
      host.refreshing.set(true);
      await view();
      host.refreshing.set(false);
      await view();
      expect(root.textContent).not.toContain('SALES.ACTION.REREADING');
      for (const label of FIELDS) {
        expect(control(label).matches(':disabled'), label).toBe(false);
      }
    });
  });

  describe('without the permission to write the loyalty cards', () => {
    const READ_ONLY = ['sales:write', 'contacts:read', 'fidelity:read'];

    it('blocks the credit and the card and says why', async () => {
      const { open, control, root } = await render(READ_ONLY);
      await open();
      expect(root.textContent).toContain('SALES.ACTION.NEEDS_FIDELITY');
      expect(control(CREDIT).matches(':disabled')).toBe(true);
      expect(control(CARD).matches(':disabled')).toBe(true);
      expect(control(CASH).matches(':disabled')).toBe(false);
      expect(control(LOTTERY).matches(':disabled')).toBe(false);
    });

    it('says it without the card fieldset when the cards cannot be read either', async () => {
      const { open, control, root } = await render(['sales:write']);
      await open();
      expect(root.textContent).toContain('SALES.ACTION.NEEDS_FIDELITY');
      expect(control(CREDIT).matches(':disabled')).toBe(true);
      expect([...root.querySelectorAll('label')].some((l) => l.textContent?.trim() === CARD)).toBe(false);
    });

    it('lets whoever can write them change both, with no warning', async () => {
      const { open, control, root } = await render();
      await open();
      expect(root.textContent).not.toContain('SALES.ACTION.NEEDS_FIDELITY');
      expect(control(CREDIT).matches(':disabled')).toBe(false);
      expect(control(CARD).matches(':disabled')).toBe(false);
    });
  });

  describe('hints', () => {
    it('explains the amounts, the card and the lottery code', async () => {
      const { open, root } = await render();
      await open();
      const text = root.textContent!;
      expect(text).toContain('SALES.ACTION.AMOUNT_HINT {"currency":"EUR"}');
      expect(text).toContain('SALES.ACTION.CARD_HINT {"max":64}');
      expect(text).toContain('SALES.ACTION.CARD_MOVES');
      expect(text).toContain('SALES.ACTION.LOTTERY_HINT {"max":32}');
      expect(text).toContain('SALES.ACTION.AMEND_NOTE');
    });
  });

  describe('lottery code', () => {
    it('is not sent when it was typed and then emptied again', async () => {
      const { open, type, submit, failure } = await render();
      await open();
      await type(LOTTERY, 'ABC');
      await type(LOTTERY, '  ');
      await submit();
      expect(failure()).toBe('SALES.ACTION.NOTHING_CHANGED');
      backend().expectNone(URL);
    });
  });

  describe('focus after a refused send', () => {
    it('goes to the first field that is not valid', async () => {
      const { open, type, submit, control } = await render();
      await open();
      await type(LOTTERY, 'y'.repeat(33));
      await type(ELECTRONIC, 'abc');
      await submit();
      expect(document.activeElement).toBe(control(ELECTRONIC));
    });

    it('goes to the summary of the failure when no field is to blame', async () => {
      const { open, type, send, root } = await render();
      await open();
      await type(CASH, '1');
      await send(fail500);
      expect(document.activeElement).toBe(root.querySelector('fc-form-error'));
    });
  });

  describe('a 422 the form cannot place', () => {
    it.each([
      ['a whole payments object', [{ field: 'payments', issue: 'type' }]],
      ['no detail at all', []],
    ])('says so for %s', async (_name, details) => {
      const { open, type, send, failure, root } = await render();
      await open();
      await type(CASH, '1');
      await send(invalid(details));
      expect(failure()).toBe('SALES.ACTION.INVALID_UNMAPPED');
      expect(root.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
    });

    it('shows what it can place and says the rest in the message', async () => {
      const { open, type, send, failure, errorOf } = await render();
      await open();
      await type(CASH, '1');
      await send(invalid([{ field: 'payments.cash', issue: 'maximum' }, { field: 'payments', issue: 'type' }]));
      expect(errorOf(CASH)).toBe('FORM.ISSUE.MAXIMUM');
      expect(failure()).toBe('SALES.ACTION.INVALID_UNMAPPED');
    });
  });
});

function fail500(request: ReturnType<typeof requestTo>): void {
  request.flush({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, { status: 500, statusText: 'x' });
}
