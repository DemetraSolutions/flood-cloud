import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { findControl } from '../../../testing/forms';
import { forbidden, invalid, requestTo, SALE_FAILURES } from '../../../testing/sale-dialogs';
import { aSaleDetail, aSaleProduct, SALE_ID } from '../../../testing/sales';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { SaleApi } from './sale-api';
import { SaleRefundDialog } from './sale-refund-dialog';
import { SaleDetail } from './sale.types';

const URL = `${API}/v1/groups/g1/sales/${SALE_ID}/refunds`;
/** The label of an amount field: its name and the symbol of the currency. */
const money = (key: string) => `SALES.ACTION.AMOUNT_LABEL {"label":"${key}","symbol":"€"}`;
const TAXABLE = money('SALES.TOTALS.TAXABLE');
const TAX = money('SALES.TOTALS.TAX');
const TOTAL = money('SALES.TOTALS.TOTAL');
const REPORT = 'SALES.ACTION.RECEIPT_REPORT';
const NUMBER = 'SALES.ACTION.RECEIPT_NUMBER';
const RECEIPT_DATE = 'SALES.ACTION.RECEIPT_DATE';
const RECEIPT_AMOUNT = money('SALES.ACTION.RECEIPT_AMOUNT');
const SUBMIT = 'SALES.ACTION.REFUND_SUBMIT';

const PRODUCTS = [
  aSaleProduct({ index: 0, productId: 'p1', name: 'Caffè', quantity: 2, returned: 0.5 }),
  aSaleProduct({ index: 1, productId: null, code: 'C2', name: null, quantity: 1.5, returned: 0 }),
  aSaleProduct({ index: 2, productId: 'p3', name: 'Reso intero', quantity: 1, returned: 1 }),
  aSaleProduct({ index: 3, productId: 'p4', name: 'Gratis', quantity: 0, returned: 0 }),
  aSaleProduct({ index: 4, productId: null, code: null, name: null, quantity: 1, returned: 0 }),
];
const PLAIN = { fidelityCardUsed: false };

@Component({
  imports: [SaleRefundDialog],
  template: `<fc-sale-refund-dialog
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
  readonly sale = signal<SaleDetail>(aSaleDetail({ products: PRODUCTS, ...PLAIN }));
  readonly refreshing = signal(false);
  done = 0;
  reread = 0;
}

async function render(permissions: string[] = ['sales:write']) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: provideApiTesting() });
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
  const lines = () => [...root.querySelectorAll<HTMLElement>('li.line')];
  const quantityInput = (position: number) => lines()[position].querySelector('input')!;
  const typeInput = async (input: HTMLInputElement | HTMLSelectElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const quantity = (position: number, text: string) => typeInput(quantityInput(position), text);
  const type = (label: string, text: string) => typeInput(findControl(fixture, label), text);
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) => b.textContent?.trim() === text)!;
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const errorOf = (input: HTMLElement) => {
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
  return { fixture, host, root, view, open, lines, quantity, quantityInput, type, button, submit, errorOf, failure, send, typeInput };
}

let counter = 0;
beforeEach(() => {
  counter = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
  );
});

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SaleRefundDialog', () => {
  it('lists only the lines sold of which something is left, with what is left', async () => {
    const { open, lines, root } = await render();
    await open();
    expect(root.querySelector('dialog h2')?.textContent).toBe(
      'SALES.ACTION.REFUND_TITLE {"reference":"SALES.REFERENCE.NUMBER {\\"number\\":\\"12-345\\"}"}',
    );
    expect(root.textContent).toContain('SALES.ACTION.SUMMARY');
    expect(lines().map((line) => line.querySelector('.line-name')!.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Caffè SALES.ACTION.REFUND_LEFT {"left":"1,5","sold":"2"}',
      'C2 SALES.ACTION.REFUND_LEFT {"left":"1,5","sold":"1,5"}',
      'SALES.ACTION.REFUND_LEFT {"left":"1","sold":"1"}',
    ]);
    expect(root.textContent).not.toContain('SALES.ACTION.REFUND_NOTHING_LEFT');
  });

  it('says there is nothing to return and disables the button when every line was returned', async () => {
    const { open, host, root, button, view } = await render();
    host.sale.set(aSaleDetail({ products: [aSaleProduct({ quantity: 1, returned: 1 })] }));
    await view();
    await open();
    expect(root.querySelectorAll('li.line').length).toBe(0);
    expect(root.textContent).toContain('SALES.ACTION.REFUND_NOTHING_LEFT');
    expect(button(SUBMIT).disabled).toBe(true);
  });

  it('asks to choose a line when none has a quantity, and sends nothing', async () => {
    const { open, submit, root, failure } = await render();
    await open();
    expect(root.querySelector('fc-form-error')).toBeNull();
    await submit();
    expect(failure()).toBe('SALES.ACTION.REFUND_NO_LINES');
    expect(document.activeElement).toBe(root.querySelector('fc-form-error'));
    backend().expectNone(URL);
  });

  it('refuses a quantity that is not valid or is above what is left', async () => {
    const { open, quantity, quantityInput, submit, errorOf } = await render();
    await open();
    await quantity(0, 'abc');
    await quantity(1, '1,6');
    await submit();
    expect(document.activeElement).toBe(quantityInput(0));
    expect(errorOf(quantityInput(0))).toBe('FORM.ISSUE.TYPE');
    expect(errorOf(quantityInput(1))).toBe('FORM.ISSUE.MAXIMUM');
    backend().expectNone(URL);
  });

  it('wants all of the value or none of it', async () => {
    const { open, quantity, type, submit, errorOf, fixture } = await render();
    await open();
    await quantity(0, '1');
    await type(TAXABLE, '1');
    await submit();
    expect(errorOf(findControl(fixture, TAX))).toBe('FORM.ISSUE.REQUIRED');
    expect(errorOf(findControl(fixture, TOTAL))).toBe('FORM.ISSUE.REQUIRED');
    expect(errorOf(findControl(fixture, TAXABLE))).toBe('');
    backend().expectNone(URL);
  });

  it('sends the lines with a quantity, the key of the refund and the version', async () => {
    const { open, quantity, send, host, root } = await render();
    await open();
    await quantity(0, '1');
    await quantity(1, '1,5');
    const before = Date.now();
    const request = await send();
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.params.has('nonFiscal')).toBe(false);
    const body = request.request.body as { timestampId: string; date: string };
    expect(body.timestampId).toBe('bo-00000000-0000-4000-8000-000000000001');
    expect(new Date(body.date).getTime()).toBeGreaterThanOrEqual(before);
    expect(request.request.body).toEqual({
      timestampId: body.timestampId,
      date: body.date,
      products: [
        { index: 0, productId: 'p1', quantity: 1 },
        { index: 1, quantity: 1.5 },
      ],
    });
    expect(host.done).toBe(1);
    expect(host.open()).toBe(false);
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('asks for the non fiscal sales for a non fiscal sale', async () => {
    const { open, host, quantity, send } = await render();
    host.sale.set(aSaleDetail({ products: PRODUCTS, nonFiscal: true, ...PLAIN }));
    await open();
    await quantity(0, '1');
    expect((await send()).request.params.get('nonFiscal')).toBe('include');
  });

  it('sends the value when it is typed and the fiscal receipt when something is in it', async () => {
    const { open, quantity, type, send } = await render();
    await open();
    await quantity(0, '1');
    await type(TAXABLE, '1');
    await type(TAX, '0,22');
    await type(TOTAL, '1.22');
    await type(REPORT, '4');
    await type(NUMBER, '5');
    await type(RECEIPT_AMOUNT, '1,22');
    await type(RECEIPT_DATE, '2026-11-27T09:30');
    const body = (await send()).request.body as Record<string, unknown>;
    expect(body['value']).toEqual({ taxable: 1, tax: 0.22, total: 1.22 });
    expect(body['fiscalReceiptInfo']).toEqual({
      date: new Date(2026, 10, 27, 9, 30).toISOString(),
      report: 4,
      number: 5,
      amount: 1.22,
    });
  });

  it('is locked while the request runs, and cannot send a second one', async () => {
    const { open, quantity, submit, button, root, view, host } = await render();
    await open();
    await quantity(0, '1');
    await submit();
    const request = requestTo(backend(), URL);
    expect(button('SALES.ACTION.GO_BACK').disabled).toBe(true);
    expect(button(SUBMIT).disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('dialog header button')!.disabled).toBe(true);
    await submit();
    backend().expectNone(URL);
    request.flush({ data: {} });
    await view();
    expect(host.done).toBe(1);
  });

  it('closes with the close button and when the browser closes the dialog', async () => {
    const { open, host, root, view } = await render();
    await open();
    root.querySelector<HTMLButtonElement>('dialog header button')!.click();
    await view();
    expect(host.open()).toBe(false);
    await open();
    const dialog = root.querySelector('dialog')!;
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));
    await view();
    expect(host.open()).toBe(false);
  });

  it('closes with Cancel without sending', async () => {
    const { open, host, button, view } = await render();
    await open();
    button('SALES.ACTION.GO_BACK').click();
    await view();
    expect(host.open()).toBe(false);
  });

  it('starts every opening clean and with a key of its own', async () => {
    const { open, host, quantity, quantityInput, send } = await render();
    await open();
    await quantity(0, '1');
    const first = ((await send()).request.body as { timestampId: string }).timestampId;
    expect(host.open()).toBe(false);
    await open();
    expect(quantityInput(0).value).toBe('');
    await quantity(0, '1');
    const second = ((await send()).request.body as { timestampId: string }).timestampId;
    expect(first).toBe('bo-00000000-0000-4000-8000-000000000001');
    expect(second).toBe('bo-00000000-0000-4000-8000-000000000002');
    expect(host.done).toBe(2);
  });

  describe('issues of the server', () => {
    const MAPPED: [string, string][] = [
      ['value.taxable', TAXABLE],
      ['value.tax', TAX],
      ['value.total', TOTAL],
      ['fiscalReceiptInfo.date', RECEIPT_DATE],
      ['fiscalReceiptInfo.report', REPORT],
      ['fiscalReceiptInfo.number', NUMBER],
      ['fiscalReceiptInfo.amount', RECEIPT_AMOUNT],
    ];

    it.each(MAPPED)('shows the issue of %s under its field', async (field, label) => {
      const { open, quantity, send, errorOf, failure, fixture } = await render();
      await open();
      await quantity(0, '1');
      await send(invalid([{ field, issue: 'type' }]));
      expect(errorOf(findControl(fixture, label))).toBe('FORM.ISSUE.TYPE');
      expect(failure()).toBe('ERRORS.API.VALIDATION_ERROR');
    });

    it('says so in the message for a field it does not know, and still shows the ones it does', async () => {
      const { open, quantity, send, failure, root, errorOf, fixture } = await render();
      await open();
      await quantity(0, '1');
      await send(invalid([{ field: 'value.tax', issue: 'type' }, { field: 'constructor', issue: 'type' }]));
      expect(failure()).toBe('SALES.ACTION.INVALID_UNMAPPED');
      expect(errorOf(findControl(fixture, TAX))).toBe('FORM.ISSUE.TYPE');
      expect(root.querySelectorAll('[aria-invalid="true"]').length).toBe(1);
    });

    it('says so when the server names no field', async () => {
      const { open, quantity, send, failure, root } = await render();
      await open();
      await quantity(0, '1');
      await send(invalid([]));
      expect(failure()).toBe('SALES.ACTION.INVALID_UNMAPPED');
      expect(root.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
    });

    describe('quantities', () => {
      it('places the issue of a position in the body on the line it was built from, and focuses it', async () => {
        const { open, quantity, quantityInput, send, errorOf, failure } = await render();
        await open();
        await quantity(1, '1');
        await quantity(2, '0,5');
        await send(invalid([{ field: 'products.1.quantity', issue: 'maximum' }]));
        expect(errorOf(quantityInput(2))).toBe('FORM.ISSUE.MAXIMUM');
        expect(errorOf(quantityInput(1))).toBe('');
        expect(failure()).toBe('ERRORS.API.VALIDATION_ERROR');
        expect(document.activeElement).toBe(quantityInput(2));
      });

      it('places the first position on the first line sent, not on the first line of the list', async () => {
        const { open, quantity, quantityInput, send, errorOf } = await render();
        await open();
        await quantity(2, '1');
        await send(invalid([{ field: 'products.0.quantity', issue: 'type' }]));
        expect(errorOf(quantityInput(2))).toBe('FORM.ISSUE.TYPE');
        expect(errorOf(quantityInput(0))).toBe('');
      });

      it('places an issue named by the index of the line', async () => {
        const { open, quantity, quantityInput, send, errorOf, failure } = await render();
        await open();
        await quantity(0, '1');
        await send(invalid([{ field: 'quantity.1', issue: 'maximum' }]));
        expect(errorOf(quantityInput(1))).toBe('FORM.ISSUE.MAXIMUM');
        expect(failure()).toBe('ERRORS.API.VALIDATION_ERROR');
      });

      it.each(['products.5.quantity', 'products.0.productId', 'quantity', 'quantity.x'])(
        'cannot place %s',
        async (field) => {
          const { open, quantity, send, failure, root } = await render();
          await open();
          await quantity(0, '1');
          await send(invalid([{ field, issue: 'type' }]));
          expect(failure()).toBe('SALES.ACTION.INVALID_UNMAPPED');
          expect(root.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
        },
      );
    });
  });

  describe('failures', () => {
    it.each(SALE_FAILURES)('shows the message of a $name and keeps the dialog open', async (failureCase) => {
      const { open, quantity, send, failure, host } = await render();
      await open();
      await quantity(0, '1');
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

    it('says the loyalty permission is missing on a 403 of a sale that used a card', async () => {
      const { open, host, quantity, send, failure } = await render();
      host.sale.set(aSaleDetail({ products: PRODUCTS, fidelityCardUsed: true }));
      await open();
      await quantity(0, '1');
      await send(forbidden);
      expect(failure()).toBe('SALES.ACTION.FIDELITY_REQUIRED');
    });

    it('says it too for a sale paid with the credit of a card', async () => {
      const { open, host, quantity, send, failure } = await render();
      host.sale.set(
        aSaleDetail({
          products: PRODUCTS,
          ...PLAIN,
          payments: { cash: 0, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 3, unpaid: 0 },
        }),
      );
      await open();
      await quantity(0, '1');
      await send(forbidden);
      expect(failure()).toBe('SALES.ACTION.FIDELITY_REQUIRED');
    });

    it('uses the central message for a 403 of a sale without a card', async () => {
      const { open, quantity, send, failure } = await render();
      await open();
      await quantity(0, '1');
      await send(forbidden);
      expect(failure()).toBe('ERRORS.API.FORBIDDEN');
    });

    it('logs an error that is not an API error and shows the generic message', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const error = new Error('boom');
      vi.spyOn(SaleApi.prototype, 'refund').mockRejectedValue(error);
      const { open, quantity, submit, failure } = await render();
      await open();
      await quantity(0, '1');
      await submit();
      expect(failure()).toBe('ERRORS.GENERIC.MESSAGE');
      expect(log).toHaveBeenCalledWith(error);
    });

    it('after an uncertain outcome waits for the page to read the sale, then sends the same refund again', async () => {
      const { open, quantity, send, submit, host, view, button } = await render();
      await open();
      await quantity(0, '1');
      const first = await send((request) => request.error(new ProgressEvent('error')));
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
      const second = await send();
      expect((second.request.body as { timestampId: string }).timestampId).toBe(
        (first.request.body as { timestampId: string }).timestampId,
      );
      expect(host.done).toBe(1);
    });
  });

  describe('key of the refund', () => {
    type Body = { timestampId: string; products: unknown[]; value?: unknown; fiscalReceiptInfo?: unknown };
    const bodyOf = (request: { request: { body: unknown } }) => request.request.body as Body;
    const KEY1 = 'bo-00000000-0000-4000-8000-000000000001';
    const KEY2 = 'bo-00000000-0000-4000-8000-000000000002';

    /** Opens, types a quantity and sends it with an answer; the dialog is then closed and opened again. */
    async function sendAndReopen(
      ctx: Awaited<ReturnType<typeof render>>,
      answer: (request: ReturnType<typeof requestTo>) => void,
    ) {
      const request = await ctx.send(answer);
      if (ctx.host.open()) {
        ctx.host.open.set(false);
        await ctx.view();
      }
      await ctx.open();
      return request;
    }

    it('keeps the key and the lines when the dialog is closed and opened again after an uncertain outcome', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      const first = await sendAndReopen(ctx, fail500);
      expect(ctx.root.querySelector('fc-form-error')).toBeNull();
      expect(ctx.root.textContent).not.toContain('SALES.ACTION.REREADING');
      await ctx.quantity(0, '1');
      const second = await ctx.send();
      expect(bodyOf(first).timestampId).toBe(KEY1);
      expect(bodyOf(second).timestampId).toBe(KEY1);
      expect(bodyOf(second).products).toEqual(bodyOf(first).products);
      expect(counter).toBe(1);
    });

    it('keeps the key after no answer at all', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, (request) => request.error(new ProgressEvent('error')));
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY1);
    });

    it('keeps it through several uncertain outcomes in a row', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY1);
    });

    it('takes a new key when the sale shows another refund', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      ctx.host.sale.set(aSaleDetail({ products: PRODUCTS, ...PLAIN, refunds: [{ report: 12, number: 346, date: null, amount: 1, canceled: false }] }));
      await ctx.view();
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY2);
    });

    it('takes a new key when what the sale returned changed', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      ctx.host.sale.set(aSaleDetail({ products: PRODUCTS, ...PLAIN, returnedValue: 2.4 }));
      await ctx.view();
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY2);
    });

    it('keeps the key when the sale was read again and shows the same', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      ctx.host.sale.set(aSaleDetail({ products: PRODUCTS, ...PLAIN, version: 'v2' }));
      await ctx.view();
      await ctx.quantity(0, '1');
      const request = await ctx.send();
      expect(bodyOf(request).timestampId).toBe(KEY1);
      expect(request.request.headers.get('If-Match')).toBe('"v2"');
    });

    it.each([
      ['another quantity', async (ctx: Awaited<ReturnType<typeof render>>) => ctx.quantity(0, '1,5')],
      ['another line', async (ctx: Awaited<ReturnType<typeof render>>) => {
        await ctx.quantity(0, '1');
        await ctx.quantity(1, '1');
      }],
      ['a value', async (ctx: Awaited<ReturnType<typeof render>>) => {
        await ctx.quantity(0, '1');
        await ctx.type(TAXABLE, '1');
        await ctx.type(TAX, '0');
        await ctx.type(TOTAL, '1');
      }],
      ['a receipt', async (ctx: Awaited<ReturnType<typeof render>>) => {
        await ctx.quantity(0, '1');
        await ctx.type(NUMBER, '5');
      }],
    ])('takes a new key when the user changes to %s', async (_name, change) => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      await change(ctx);
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY2);
    });

    it('takes a new key after a success', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY1);
      await ctx.open();
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY2);
    });

    it('takes a new key after a 412', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, SALE_FAILURES.find((c) => c.name === '412')!.answer);
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY2);
    });

    it.each(SALE_FAILURES.filter((c) => !c.name.includes('no answer') && !c.name.includes('500')))(
      'takes a new key after a $name',
      async (failureCase) => {
        const ctx = await render();
        await ctx.open();
        await ctx.quantity(0, '1');
        await sendAndReopen(ctx, failureCase.answer);
        await ctx.quantity(0, '1');
        expect(bodyOf(await ctx.send()).timestampId).toBe(KEY2);
      },
    );

    it('takes a new key after an uncertain outcome followed by a 422', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, invalid([{ field: 'value.tax', issue: 'type' }]));
      await ctx.quantity(0, '1');
      const request = await ctx.send();
      expect(bodyOf(request).timestampId).toBe(KEY2);
      expect(counter).toBe(2);
    });

    it('takes a new key after an uncertain outcome followed by an error that is not an API error', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      await sendAndReopen(ctx, fail500);
      vi.spyOn(SaleApi.prototype, 'refund').mockRejectedValueOnce(new Error('boom'));
      await ctx.quantity(0, '1');
      await ctx.submit();
      expect(ctx.failure()).toBe('ERRORS.GENERIC.MESSAGE');
      ctx.host.open.set(false);
      await ctx.view();
      await ctx.open();
      await ctx.quantity(0, '1');
      expect(bodyOf(await ctx.send()).timestampId).toBe(KEY2);
    });

    it('keeps the key when the same refund is sent again without closing the dialog', async () => {
      const ctx = await render();
      await ctx.open();
      await ctx.quantity(0, '1');
      const first = await ctx.send(fail500);
      ctx.host.refreshing.set(true);
      await ctx.view();
      ctx.host.refreshing.set(false);
      await ctx.view();
      const second = await ctx.send();
      expect(bodyOf(second).timestampId).toBe(bodyOf(first).timestampId);
    });
  });

  describe('permission to write the loyalty cards', () => {
    const CARD_SALE = () => aSaleDetail({ products: PRODUCTS, fidelityCardUsed: true });

    it('warns whoever cannot write them when the sale used a card', async () => {
      const { open, host, root } = await render();
      host.sale.set(CARD_SALE());
      await open();
      expect(root.querySelector('p.warning[role=status]')?.textContent).toContain('SALES.ACTION.FIDELITY_NOTE');
    });

    it('does not warn for a sale that moved no credit', async () => {
      const { open, root } = await render();
      await open();
      expect(root.textContent).not.toContain('SALES.ACTION.FIDELITY_NOTE');
    });

    it('does not warn whoever can write them, and a 403 is then a plain refusal', async () => {
      const { open, host, root, quantity, send, failure } = await render(['sales:write', 'fidelity:update']);
      host.sale.set(CARD_SALE());
      await open();
      expect(root.textContent).not.toContain('SALES.ACTION.FIDELITY_NOTE');
      await quantity(0, '1');
      await send(forbidden);
      expect(failure()).toBe('ERRORS.API.FORBIDDEN');
    });
  });

  describe('while it sends and while the sale is read again', () => {
    it('disables the lines, the value and the receipt while the request runs', async () => {
      const { open, quantity, submit, root, view } = await render();
      await open();
      await quantity(0, '1');
      await submit();
      const request = requestTo(backend(), URL);
      const fieldsets = [...root.querySelectorAll('fieldset')];
      expect(fieldsets.length).toBe(3);
      expect(fieldsets.every((fieldset) => fieldset.disabled)).toBe(true);
      expect(root.querySelector<HTMLInputElement>('li.line input')!.matches(':disabled')).toBe(true);
      request.flush({ data: {} });
      await view();
    });

    it('says it is reading the sale and keeps the fields disabled until the page has read it', async () => {
      const { open, quantity, send, root, host, view, button } = await render();
      await open();
      await quantity(0, '1');
      await send(fail500);
      expect(root.textContent).toContain('SALES.ACTION.REREADING');
      expect([...root.querySelectorAll('fieldset')].every((fieldset) => fieldset.disabled)).toBe(true);
      expect(button(SUBMIT).disabled).toBe(true);
      host.refreshing.set(true);
      await view();
      host.refreshing.set(false);
      await view();
      expect(root.textContent).not.toContain('SALES.ACTION.REREADING');
      expect([...root.querySelectorAll('fieldset')].some((fieldset) => fieldset.disabled)).toBe(false);
    });
  });

  describe('texts', () => {
    it('names the sale, the value in the currency and the amounts with the symbol', async () => {
      const { open, root, fixture } = await render();
      await open();
      expect(root.textContent).toContain('SALES.ACTION.REFUND_VALUE_HINT {"currency":"EUR"}');
      expect(root.textContent).toContain('SALES.ACTION.REFUND_NOTE');
      for (const label of [TAXABLE, TAX, TOTAL, RECEIPT_AMOUNT]) {
        expect(findControl(fixture, label)).toBeDefined();
      }
    });
  });
});

function fail500(request: ReturnType<typeof requestTo>): void {
  request.flush({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, { status: 500, statusText: 'x' });
}
