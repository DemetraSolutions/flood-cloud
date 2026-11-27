import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { forbidden, requestTo, SALE_FAILURES } from '../../../testing/sale-dialogs';
import { aSaleDetail, SALE_ID } from '../../../testing/sales';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { SaleApi } from './sale-api';
import { ConfirmKind, SaleConfirmDialog } from './sale-confirm-dialog';
import { SaleDetail } from './sale.types';

const URL = `${API}/v1/groups/g1/sales/${SALE_ID}`;

@Component({
  imports: [SaleConfirmDialog],
  template: `<fc-sale-confirm-dialog
    groupId="g1"
    [kind]="kind()"
    [sale]="sale()"
    currency="EUR"
    [refreshing]="refreshing()"
    [(open)]="open"
    (done)="done = done + 1"
    (reread)="reread = reread + 1"
  />`,
})
class Host {
  readonly kind = signal<ConfirmKind>('cancel');
  readonly open = signal(false);
  readonly sale = signal<SaleDetail>(aSaleDetail({ fidelityCardUsed: false }));
  readonly refreshing = signal(false);
  done = 0;
  reread = 0;
}

async function render(
  kind: ConfirmKind = 'cancel',
  sale: Partial<SaleDetail> = { fidelityCardUsed: false },
  permissions: string[] = ['sales:write', 'sales:delete'],
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', permissions });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.kind.set(kind);
  host.sale.set(aSaleDetail(sale));
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
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
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const failure = () => root.querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const confirm = async (
    label: string,
    answer: (request: ReturnType<typeof requestTo>) => void = (r) => r.flush({ data: {} }),
  ) => {
    button(label).click();
    await view();
    const request = requestTo(backend(), URL + (kind === 'cancel' ? '/cancellation' : ''));
    answer(request);
    await view();
    return request;
  };
  return { fixture, host, root, view, open, dialog, button, failure, confirm };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SaleConfirmDialog', () => {
  describe.each([
    ['cancel', 'CANCEL', 'POST'],
    ['delete', 'DELETE', 'DELETE'],
  ] as const)('%s', (kind, key, method) => {
    const CONFIRM = `SALES.ACTION.${key}_CONFIRM`;

    it('says what happens, as an alert dialog with the focus on the safe answer', async () => {
      const { open, dialog, root } = await render(kind);
      await open();
      expect(dialog().getAttribute('role')).toBe('alertdialog');
      const reference = '{"reference":"SALES.REFERENCE.NUMBER {\\"number\\":\\"12-345\\"}"}';
      expect(dialog().querySelector('h2')?.textContent).toBe(
        `SALES.ACTION.${key}_TITLE ${reference}`,
      );
      expect(dialog().textContent).toContain(`SALES.ACTION.${key}_MESSAGE ${reference}`);
      expect(dialog().querySelector('p.note')?.textContent).toContain('SALES.ACTION.SUMMARY');
      expect(dialog().querySelector('p.note')?.textContent).toContain('"total":"30,00');
      expect([...dialog().querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual([
        `SALES.ACTION.${key}_STOCK`,
        `SALES.ACTION.${key}_LOYALTY`,
        `SALES.ACTION.${key}_LAST`,
      ]);
      const first = root.querySelector('dialog footer button')!;
      expect(first.textContent?.trim()).toBe('SALES.ACTION.GO_BACK');
      expect(first.hasAttribute('autofocus')).toBe(true);
      expect(root.querySelector('fc-form-error')).toBeNull();
    });

    it('closes with the close button and when the browser closes the dialog', async () => {
      const { open, host, root, view, dialog } = await render(kind);
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

    it('does not send anything when the user goes back', async () => {
      const { open, button, host, view } = await render(kind);
      await open();
      button('SALES.ACTION.GO_BACK').click();
      await view();
      expect(host.open()).toBe(false);
      expect(host.done).toBe(0);
    });

    it('sends the request with the version and closes when done', async () => {
      const { open, confirm, host } = await render(kind);
      await open();
      const request = await confirm(CONFIRM);
      expect(request.request.method).toBe(method);
      expect(request.request.headers.get('If-Match')).toBe('"v1"');
      expect(host.done).toBe(1);
      expect(host.open()).toBe(false);
      expect(host.reread).toBe(0);
    });

    it('is locked while the request runs and does not send twice', async () => {
      const { open, button, root, view, host, dialog } = await render(kind);
      await open();
      button(CONFIRM).click();
      await view();
      const request = requestTo(backend(), URL + (kind === 'cancel' ? '/cancellation' : ''));
      expect(button('SALES.ACTION.GO_BACK').disabled).toBe(true);
      expect(button(CONFIRM).disabled).toBe(true);
      expect(root.querySelector<HTMLButtonElement>('dialog header button')!.disabled).toBe(true);
      const cancel = new Event('cancel', { cancelable: true });
      dialog().dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
      button(CONFIRM).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await view();
      backend().expectNone(URL + (kind === 'cancel' ? '/cancellation' : ''));
      request.flush({ data: {} });
      await view();
      expect(host.done).toBe(1);
    });

    it.each(SALE_FAILURES)(
      'shows the message of a $name and keeps the dialog open',
      async (failureCase) => {
        const { open, confirm, failure, host } = await render(kind);
        await open();
        await confirm(CONFIRM, failureCase.answer);
        if (failureCase.message === null) {
          expect(failure()).toContain(failureCase.contains);
        } else {
          expect(failure()).toBe(failureCase.message);
        }
        expect(host.reread).toBe(failureCase.reread ? 1 : 0);
        expect(host.open()).toBe(true);
        expect(host.done).toBe(0);
      },
    );

    it('says the loyalty permission is missing on a 403 of a sale that used a card', async () => {
      const { open, confirm, failure } = await render(kind, { fidelityCardUsed: true });
      await open();
      await confirm(CONFIRM, forbidden);
      expect(failure()).toBe('SALES.ACTION.FIDELITY_REQUIRED');
    });

    it('says it too for a sale paid with the credit of a card', async () => {
      const { open, confirm, failure } = await render(kind, {
        fidelityCardUsed: false,
        payments: { cash: 0, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 2, unpaid: 0 },
      });
      await open();
      await confirm(CONFIRM, forbidden);
      expect(failure()).toBe('SALES.ACTION.FIDELITY_REQUIRED');
    });

    it('warns that the credit cannot be given back when the sale moved credit and the user cannot write the cards', async () => {
      const { open, dialog } = await render(kind, { fidelityCardUsed: true });
      await open();
      expect(dialog().textContent).toContain('SALES.ACTION.FIDELITY_NOTE');
    });

    it('does not warn about the cards for a sale that moved no credit', async () => {
      const { open, dialog } = await render(kind);
      await open();
      expect(dialog().textContent).not.toContain('SALES.ACTION.FIDELITY_NOTE');
    });

    it('does not warn about the cards, and a 403 is any other refusal, when the user can write them', async () => {
      const { open, dialog, confirm, failure } = await render(kind, { fidelityCardUsed: true }, [
        'sales:write',
        'sales:delete',
        'fidelity:update',
      ]);
      await open();
      expect(dialog().textContent).not.toContain('SALES.ACTION.FIDELITY_NOTE');
      await confirm(CONFIRM, forbidden);
      expect(failure()).toBe('ERRORS.API.FORBIDDEN');
    });

    it('uses the central message for a 403 of a sale without a card', async () => {
      const { open, confirm, failure } = await render(kind);
      await open();
      await confirm(CONFIRM, forbidden);
      expect(failure()).toBe('ERRORS.API.FORBIDDEN');
    });

    it('cannot confirm after an uncertain outcome until the page has read the sale again', async () => {
      const { open, confirm, button, host, view, dialog } = await render(kind);
      await open();
      await confirm(CONFIRM, (request) => request.error(new ProgressEvent('error')));
      expect(host.reread).toBe(1);
      expect(button(CONFIRM).disabled).toBe(true);
      expect(dialog().textContent).toContain('SALES.ACTION.REREADING');
      host.refreshing.set(true);
      await view();
      expect(button(CONFIRM).disabled).toBe(true);
      expect(dialog().textContent).toContain('SALES.ACTION.REREADING');
      host.refreshing.set(false);
      await view();
      expect(button(CONFIRM).disabled).toBe(false);
      expect(dialog().textContent).not.toContain('SALES.ACTION.REREADING');
      await confirm(CONFIRM);
      expect(host.done).toBe(1);
    });

    it('starts every opening without the failure of the last one', async () => {
      const { open, confirm, failure, host, view } = await render(kind);
      await open();
      await confirm(CONFIRM, forbidden);
      expect(failure()).not.toBeNull();
      host.open.set(false);
      await view();
      await open();
      expect(failure()).toBeNull();
    });
  });

  it('does not say it is reading the sale again when nothing needs a new read', async () => {
    const { open, dialog } = await render('cancel');
    await open();
    expect(dialog().textContent).not.toContain('SALES.ACTION.REREADING');
  });

  it('warns that the cancellation of a fiscal sale does not cancel the receipt at the cash desk', async () => {
    const { open, dialog } = await render('cancel', { nonFiscal: false, fidelityCardUsed: false });
    await open();
    expect(dialog().textContent).toContain('SALES.ACTION.CANCEL_FISCAL');
  });

  it('does not give that warning for a non fiscal sale', async () => {
    const { open, dialog } = await render('cancel', { nonFiscal: true, fidelityCardUsed: false });
    await open();
    expect(dialog().textContent).not.toContain('SALES.ACTION.CANCEL_FISCAL');
  });

  it('does not give that warning for the deletion', async () => {
    const { open, dialog } = await render('delete', { nonFiscal: false, fidelityCardUsed: false });
    await open();
    expect(dialog().textContent).not.toContain('SALES.ACTION.CANCEL_FISCAL');
  });

  it('names a sale without a number by its date', async () => {
    const { open, dialog } = await render('cancel', { number: null, fidelityCardUsed: false });
    await open();
    expect(dialog().querySelector('h2')?.textContent).toContain('SALES.REFERENCE.DATE');
    expect(dialog().querySelector('h2')?.textContent).not.toContain('SALES.REFERENCE.NUMBER');
  });

  it('names a sale without a number and without a date as having none', async () => {
    const { open, dialog } = await render('delete', {
      number: null,
      date: null,
      fidelityCardUsed: false,
    });
    await open();
    expect(dialog().querySelector('h2')?.textContent).toContain('SALES.REFERENCE.NONE');
  });

  it('cancels with the instant of the cancellation in the body', async () => {
    const { open, confirm } = await render('cancel');
    await open();
    const before = Date.now();
    const request = await confirm('SALES.ACTION.CANCEL_CONFIRM');
    const body = request.request.body as { date: string };
    expect(Object.keys(body)).toEqual(['date']);
    expect(new Date(body.date).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(body.date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(request.request.params.has('nonFiscal')).toBe(false);
  });

  it('asks for the non fiscal sales when cancelling a non fiscal sale', async () => {
    const { open, confirm } = await render('cancel', { nonFiscal: true, fidelityCardUsed: false });
    await open();
    expect((await confirm('SALES.ACTION.CANCEL_CONFIRM')).request.params.get('nonFiscal')).toBe(
      'include',
    );
  });

  it('deletes without a body and always asks for the non fiscal sales', async () => {
    const { open, confirm } = await render('delete');
    await open();
    const request = await confirm('SALES.ACTION.DELETE_CONFIRM', (r) =>
      r.flush(null, { status: 204, statusText: 'No Content' }),
    );
    expect(request.request.params.get('nonFiscal')).toBe('include');
    expect(request.request.body).toBeNull();
  });

  it('logs an error that is not an API error and shows the generic message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('boom');
    vi.spyOn(SaleApi.prototype, 'cancel').mockRejectedValue(error);
    const { open, button, view, failure } = await render('cancel');
    await open();
    button('SALES.ACTION.CANCEL_CONFIRM').click();
    await view();
    expect(failure()).toBe('ERRORS.GENERIC.MESSAGE');
    expect(log).toHaveBeenCalledWith(error);
  });
});
