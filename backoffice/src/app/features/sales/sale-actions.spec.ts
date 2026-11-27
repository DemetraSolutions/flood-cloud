import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { requestTo } from '../../../testing/sale-dialogs';
import { aSaleDetail, aSaleProduct, SALE_ID } from '../../../testing/sales';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ContactApi } from '../contacts/contact-api';
import { SaleActions } from './sale-actions';
import { SaleDetail } from './sale.types';

const URL = `${API}/v1/groups/g1/sales/${SALE_ID}`;
const BUTTONS = ['SALES.ACTION.AMEND', 'SALES.ACTION.REFUND', 'SALES.ACTION.CANCEL'];
const NOTHING = { products: [aSaleProduct({ quantity: 2, returned: 2 })] };
const DELETE = 'SALES.ACTION.DELETE';

interface Options {
  permissions?: string[];
  sale?: Partial<SaleDetail>;
  mode?: boolean;
}

async function render({ permissions = ['sales:write'], sale = {}, mode = false }: Options = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: ContactApi, useValue: { searchContacts: async () => [] } },
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', permissions });
  const nonFiscalMode = TestBed.inject(NonFiscalMode);
  if (mode) {
    for (let click = 0; click < 7; click++) {
      nonFiscalMode.brandClick(click);
    }
  }
  const fixture = TestBed.createComponent(SaleActions);
  fixture.componentRef.setInput('groupId', 'g1');
  fixture.componentRef.setInput('sale', aSaleDetail({ fidelityCardUsed: false, ...sale }));
  fixture.componentRef.setInput('currency', 'EUR');
  fixture.componentRef.setInput('refreshing', false);
  const events = { changed: 0, deleted: 0 };
  fixture.componentInstance.changed.subscribe(() => events.changed++);
  fixture.componentInstance.deleted.subscribe(() => events.deleted++);
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const actionButtons = () => [...root.querySelectorAll<HTMLButtonElement>('.group button')];
  const action = (text: string) => actionButtons().find((b) => b.textContent?.trim() === text);
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === text && b.closest('dialog')!.hasAttribute('open'),
    )!;
  const openDialogs = () => [...root.querySelectorAll('dialog[open] h2')].map((h) => h.textContent);
  const update = async (over: Partial<SaleDetail>) => {
    fixture.componentRef.setInput('sale', aSaleDetail({ fidelityCardUsed: false, ...over }));
    await view();
  };
  const note = (reason: string) => root.querySelector<HTMLElement>(`[data-note="${reason}"]`);
  const notes = () =>
    [...root.querySelectorAll('[data-note]')].map((n) => n.getAttribute('data-note'));
  const closeDialog = async () => {
    root.querySelector<HTMLButtonElement>('dialog[open] header button')!.click();
    await view();
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((toast) => toast.message);
  return {
    fixture,
    root,
    view,
    events,
    actionButtons,
    action,
    dialogButton,
    openDialogs,
    toasts,
    update,
    note,
    notes,
    closeDialog,
  };
}

afterEach(() => {
  backend().verify();
  TestBed.inject(NonFiscalMode).reset();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SaleActions', () => {
  it('shows nothing to a user who can neither write nor delete', async () => {
    const { root } = await render({ permissions: ['sales:read'] });
    expect(root.querySelector('.group')).toBeNull();
    expect(root.querySelector('dialog')).toBeNull();
  });

  it('shows amend and refund apart from cancel to whoever can write, and no deletion', async () => {
    const { actionButtons, root, notes } = await render({
      permissions: ['sales:write'],
      mode: true,
      sale: { nonFiscal: true },
    });
    expect(actionButtons().map((b) => b.textContent?.trim())).toEqual(BUTTONS);
    expect(
      actionButtons().every((b) => !b.hasAttribute('aria-disabled') && !b.hasAttribute('disabled')),
    ).toBe(true);
    const groups = [...root.querySelectorAll('[role="group"]')];
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'SALES.SECTION.ACTIONS',
      'SALES.SECTION.ACTIONS_DESTRUCTIVE',
    ]);
    expect(groups.map((g) => g.classList.contains('destructive'))).toEqual([false, true]);
    expect([...groups[0].querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(
      BUTTONS.slice(0, 2),
    );
    expect([...groups[1].querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      BUTTONS[2],
    ]);
    expect(notes()).toEqual([]);
    expect(root.querySelector(':scope > .note')).toBeNull();
    expect(root.querySelectorAll('dialog').length).toBe(3);
  });

  it.each([
    [['sales:write', 'sales:delete'], true, true, true],
    [['sales:write', 'sales:delete'], true, false, false],
    [['sales:write', 'sales:delete'], false, true, false],
    [['sales:write', 'sales:delete'], false, false, false],
    [['sales:write'], true, true, false],
    [['sales:delete'], true, true, true],
    [['sales:delete'], false, true, false],
  ])(
    'with %j, nonFiscal %s and UM mode %s the deletion is visible: %s',
    async (permissions, nonFiscal, mode, visible) => {
      const { action, actionButtons } = await render({ permissions, sale: { nonFiscal }, mode });
      expect(action(DELETE) !== undefined).toBe(visible);
      expect(actionButtons().some((b) => BUTTONS.includes(b.textContent!.trim()))).toBe(
        permissions.includes('sales:write'),
      );
    },
  );

  it('shows the deletion of a quote beside the cancellation, in the destructive group', async () => {
    const { root } = await render({
      permissions: ['sales:write', 'sales:delete'],
      sale: { nonFiscal: true },
      mode: true,
    });
    expect(
      [...root.querySelectorAll('.destructive button')].map((b) => b.textContent?.trim()),
    ).toEqual(['SALES.ACTION.CANCEL', DELETE]);
  });

  it('shows only the deletion to whoever cannot write, with one dialog and no notes', async () => {
    const { actionButtons, root, notes } = await render({
      permissions: ['sales:delete'],
      sale: { nonFiscal: true, canceled: true },
      mode: true,
    });
    expect(actionButtons().map((b) => b.textContent?.trim())).toEqual([DELETE]);
    expect(actionButtons()[0].hasAttribute('aria-disabled')).toBe(false);
    expect(root.querySelectorAll('[role="group"]').length).toBe(1);
    expect(root.querySelectorAll('dialog').length).toBe(1);
    expect(notes()).toEqual([]);
    expect(root.querySelector(':scope > .note')).toBeNull();
  });

  it('announces amend, refund and cancel of a canceled sale as disabled and links the reason', async () => {
    const { actionButtons, root, notes, note } = await render({
      permissions: ['sales:write', 'sales:delete'],
      sale: {
        canceled: true,
        nonFiscal: true,
        products: [aSaleProduct({ quantity: 1, returned: 1 })],
      },
      mode: true,
    });
    expect(
      actionButtons().map((b) => [
        b.textContent?.trim(),
        b.getAttribute('aria-disabled'),
        b.hasAttribute('disabled'),
      ]),
    ).toEqual([
      ['SALES.ACTION.AMEND', 'true', false],
      ['SALES.ACTION.REFUND', 'true', false],
      ['SALES.ACTION.CANCEL', 'true', false],
      [DELETE, null, false],
    ]);
    expect(notes()).toEqual(['canceled']);
    expect(note('canceled')!.textContent?.trim()).toBe('SALES.ACTION.CANCELED_NOTE');
    expect(note('canceled')!.getAttribute('role')).toBe('status');
    expect(note('canceled')!.getAttribute('tabindex')).toBe('-1');
    const id = note('canceled')!.id;
    expect(id).not.toBe('');
    expect(actionButtons().map((b) => b.getAttribute('aria-describedby'))).toEqual([
      id,
      id,
      id,
      null,
    ]);
    expect(root.querySelectorAll('#' + id).length).toBe(1);
  });

  it('keeps amend, refund and cancel available on an invoiced sale', async () => {
    const { actionButtons, notes } = await render({ sale: { invoiced: true } });
    expect(actionButtons().every((b) => !b.hasAttribute('aria-disabled'))).toBe(true);
    expect(notes()).toEqual([]);
  });

  it('shows only the note of the cancellation when the sale is both canceled and invoiced', async () => {
    const { actionButtons, notes, note } = await render({
      sale: { canceled: true, invoiced: true },
    });
    expect(notes()).toEqual(['canceled']);
    expect(actionButtons().map((b) => b.getAttribute('aria-describedby'))).toEqual([
      note('canceled')!.id,
      note('canceled')!.id,
      note('canceled')!.id,
    ]);
  });

  it('announces the refund as disabled when nothing is left to return and says why', async () => {
    const { actionButtons, notes, note } = await render({ sale: NOTHING });
    expect(actionButtons().map((b) => b.getAttribute('aria-disabled'))).toEqual([
      null,
      'true',
      null,
    ]);
    expect(notes()).toEqual(['returned']);
    expect(note('returned')!.textContent?.trim()).toBe('SALES.ACTION.NOTHING_TO_RETURN_NOTE');
    expect(actionButtons().map((b) => b.getAttribute('aria-describedby'))).toEqual([
      null,
      note('returned')!.id,
      null,
    ]);
  });

  it('does nothing when a disabled action is clicked, and the button keeps its place in the tab order', async () => {
    const { action, view, openDialogs, root } = await render({
      sale: { canceled: true, products: [aSaleProduct({ quantity: 1, returned: 1 })] },
    });
    for (const label of BUTTONS) {
      const button = action(label)!;
      button.focus();
      expect(document.activeElement).toBe(button);
      button.click();
      await view();
      expect(openDialogs()).toEqual([]);
    }
    expect(root.querySelector('dialog[open]')).toBeNull();
  });

  it('opens an action again once the sale allows it', async () => {
    const { action, view, openDialogs, update } = await render({ sale: { canceled: true } });
    action('SALES.ACTION.AMEND')!.click();
    await view();
    expect(openDialogs()).toEqual([]);
    await update({ canceled: false });
    expect(action('SALES.ACTION.AMEND')!.hasAttribute('aria-disabled')).toBe(false);
    action('SALES.ACTION.AMEND')!.click();
    await view();
    expect(openDialogs().length).toBe(1);
    expect(openDialogs()[0]).toContain('SALES.ACTION.AMEND_TITLE');
  });

  it('drops the note when the reason is gone after the sale is read again', async () => {
    const { notes, update, actionButtons } = await render({ sale: NOTHING });
    expect(notes()).toEqual(['returned']);
    await update({});
    expect(notes()).toEqual([]);
    expect(actionButtons().every((b) => !b.hasAttribute('aria-describedby'))).toBe(true);
  });

  describe('the loyalty note', () => {
    it('is shown and linked to cancel, refund and delete when the sale moved credit and the user cannot write the cards', async () => {
      const { actionButtons, root } = await render({
        permissions: ['sales:write', 'sales:delete'],
        sale: { fidelityCardUsed: true, nonFiscal: true },
        mode: true,
      });
      const fidelity = root.querySelector<HTMLElement>(':scope > .note:not([data-note])')!;
      expect(fidelity.textContent?.trim()).toBe('SALES.ACTION.FIDELITY_NOTE');
      expect(actionButtons().map((b) => b.getAttribute('aria-describedby'))).toEqual([
        null,
        fidelity.id,
        fidelity.id,
        fidelity.id,
      ]);
    });

    it('is shown for credit spent too, and not when the sale moved none', async () => {
      const spent = await render({
        sale: {
          payments: { cash: 0, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 2, unpaid: 0 },
        },
      });
      expect(spent.root.querySelector(':scope > .note:not([data-note])')).not.toBeNull();
      TestBed.resetTestingModule();
      document.body.replaceChildren();
      const none = await render();
      expect(none.root.querySelector(':scope > .note:not([data-note])')).toBeNull();
    });

    it('is not shown to a user who can write the cards', async () => {
      const { actionButtons, root } = await render({
        permissions: ['sales:write', 'fidelity:update'],
        sale: { fidelityCardUsed: true },
      });
      expect(root.querySelector(':scope > .note:not([data-note])')).toBeNull();
      expect(actionButtons().every((b) => b.getAttribute('aria-describedby') === null)).toBe(true);
    });

    it('is shown to whoever can only delete, linked to the deletion', async () => {
      const { actionButtons, root } = await render({
        permissions: ['sales:delete'],
        sale: { fidelityCardUsed: true, nonFiscal: true },
        mode: true,
      });
      const fidelity = root.querySelector<HTMLElement>(':scope > .note:not([data-note])')!;
      expect(actionButtons()[0].getAttribute('aria-describedby')).toBe(fidelity.id);
    });

    it('gives way to the reason when an action is not available', async () => {
      const { actionButtons, note, root } = await render({
        sale: { fidelityCardUsed: true, canceled: true },
      });
      expect(root.querySelector(':scope > .note:not([data-note])')).not.toBeNull();
      expect(actionButtons().map((b) => b.getAttribute('aria-describedby'))).toEqual([
        note('canceled')!.id,
        note('canceled')!.id,
        note('canceled')!.id,
      ]);
    });
  });

  it('opens the dialog of each action', async () => {
    const { action, openDialogs, view, closeDialog } = await render({
      permissions: ['sales:write', 'sales:delete'],
      sale: { nonFiscal: true },
      mode: true,
    });
    expect(openDialogs()).toEqual([]);
    for (const [label, title] of [
      ['SALES.ACTION.AMEND', 'SALES.ACTION.AMEND_TITLE'],
      ['SALES.ACTION.REFUND', 'SALES.ACTION.REFUND_TITLE'],
      ['SALES.ACTION.CANCEL', 'SALES.ACTION.CANCEL_TITLE'],
      [DELETE, 'SALES.ACTION.DELETE_TITLE'],
    ]) {
      action(label)!.click();
      await view();
      expect(openDialogs().length).toBe(1);
      expect(openDialogs()[0]).toContain(title);
      await closeDialog();
      expect(openDialogs()).toEqual([]);
    }
  });

  it('closes the confirmations with the safe button and opens them again afterwards', async () => {
    const { action, view, dialogButton, openDialogs } = await render({
      permissions: ['sales:write', 'sales:delete'],
      sale: { nonFiscal: true },
      mode: true,
    });
    for (const label of ['SALES.ACTION.CANCEL', DELETE, DELETE]) {
      action(label)!.click();
      await view();
      expect(openDialogs().length).toBe(1);
      dialogButton('SALES.ACTION.GO_BACK').click();
      await view();
      expect(openDialogs()).toEqual([]);
    }
  });

  it('closes each dialog with its close button and opens it again afterwards', async () => {
    const { action, view, openDialogs, closeDialog } = await render({
      permissions: ['sales:write', 'sales:delete'],
      sale: { nonFiscal: true },
      mode: true,
    });
    for (const label of [
      'SALES.ACTION.AMEND',
      'SALES.ACTION.REFUND',
      'SALES.ACTION.CANCEL',
      DELETE,
      DELETE,
    ]) {
      action(label)!.click();
      await view();
      expect(openDialogs().length).toBe(1);
      await closeDialog();
      expect(openDialogs()).toEqual([]);
    }
  });

  describe('after an action', () => {
    it('amend: shows the toast and asks the page to read the sale again', async () => {
      const { action, view, events, toasts, root } = await render();
      action('SALES.ACTION.AMEND')!.click();
      await view();
      const input = root.querySelector<HTMLInputElement>(
        'fc-sale-amend-dialog input[inputmode=decimal]',
      )!;
      input.value = '5';
      input.dispatchEvent(new Event('input'));
      await view();
      root
        .querySelector('#sale-amend-form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await view();
      requestTo(backend(), URL).flush({ data: {} });
      await view();
      expect(toasts()).toEqual(['SALES.ACTION.DONE_AMEND']);
      expect(events).toEqual({ changed: 1, deleted: 0 });
    });

    it('refund: shows the toast and asks the page to read the sale again', async () => {
      const { action, view, root, events, toasts } = await render();
      action('SALES.ACTION.REFUND')!.click();
      await view();
      const input = root.querySelector<HTMLInputElement>(
        'fc-sale-refund-dialog input[inputmode=decimal]',
      )!;
      input.value = '1';
      input.dispatchEvent(new Event('input'));
      await view();
      root
        .querySelector('#sale-refund-form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await view();
      requestTo(backend(), `${URL}/refunds`).flush({ data: {} });
      await view();
      expect(toasts()).toEqual(['SALES.ACTION.DONE_REFUND']);
      expect(events).toEqual({ changed: 1, deleted: 0 });
    });

    it('cancel: shows the toast and asks the page to read the sale again', async () => {
      const { action, view, dialogButton, events, toasts } = await render();
      action('SALES.ACTION.CANCEL')!.click();
      await view();
      dialogButton('SALES.ACTION.CANCEL_CONFIRM').click();
      await view();
      requestTo(backend(), `${URL}/cancellation`).flush({ data: {} });
      await view();
      expect(toasts()).toEqual(['SALES.ACTION.DONE_CANCEL']);
      expect(events).toEqual({ changed: 1, deleted: 0 });
    });

    it('delete: shows the toast and says the sale is gone, without reading it again', async () => {
      const { action, view, dialogButton, events, toasts } = await render({
        permissions: ['sales:delete'],
        sale: { nonFiscal: true },
        mode: true,
      });
      action(DELETE)!.click();
      await view();
      dialogButton('SALES.ACTION.DELETE_CONFIRM').click();
      await view();
      requestTo(backend(), URL).flush(null, { status: 204, statusText: 'No Content' });
      await view();
      expect(toasts()).toEqual(['SALES.ACTION.DONE_DELETE']);
      expect(events).toEqual({ changed: 0, deleted: 1 });
    });
  });

  describe('when an outcome is not known', () => {
    const lost = (request: ReturnType<typeof requestTo>) =>
      request.error(new ProgressEvent('error'));

    it('amend: asks the page to read the sale again, with no toast', async () => {
      const { action, view, events, toasts, root } = await render();
      action('SALES.ACTION.AMEND')!.click();
      await view();
      const input = root.querySelector<HTMLInputElement>(
        'fc-sale-amend-dialog input[inputmode=decimal]',
      )!;
      input.value = '5';
      input.dispatchEvent(new Event('input'));
      await view();
      root
        .querySelector('#sale-amend-form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await view();
      lost(requestTo(backend(), URL));
      await view();
      expect(events).toEqual({ changed: 1, deleted: 0 });
      expect(toasts()).toEqual([]);
    });

    it('refund: asks the page to read the sale again', async () => {
      const { action, view, root, events } = await render();
      action('SALES.ACTION.REFUND')!.click();
      await view();
      const input = root.querySelector<HTMLInputElement>(
        'fc-sale-refund-dialog input[inputmode=decimal]',
      )!;
      input.value = '1';
      input.dispatchEvent(new Event('input'));
      await view();
      root
        .querySelector('#sale-refund-form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await view();
      lost(requestTo(backend(), `${URL}/refunds`));
      await view();
      expect(events.changed).toBe(1);
    });

    it('cancel: asks the page to read the sale again', async () => {
      const { action, view, dialogButton, events } = await render();
      action('SALES.ACTION.CANCEL')!.click();
      await view();
      dialogButton('SALES.ACTION.CANCEL_CONFIRM').click();
      await view();
      lost(requestTo(backend(), `${URL}/cancellation`));
      await view();
      expect(events.changed).toBe(1);
    });

    it('delete: asks the page to read the sale again', async () => {
      const { action, view, dialogButton, events } = await render({
        permissions: ['sales:delete'],
        sale: { nonFiscal: true },
        mode: true,
      });
      action(DELETE)!.click();
      await view();
      dialogButton('SALES.ACTION.DELETE_CONFIRM').click();
      await view();
      lost(requestTo(backend(), URL));
      await view();
      expect(events).toEqual({ changed: 1, deleted: 0 });
    });
  });

  describe('the focus after an action', () => {
    async function cancelSale(context: Awaited<ReturnType<typeof render>>) {
      context.action('SALES.ACTION.CANCEL')!.click();
      await context.view();
      context.dialogButton('SALES.ACTION.CANCEL_CONFIRM').click();
      await context.view();
      requestTo(backend(), `${URL}/cancellation`).flush({ data: {} });
      await context.view();
    }

    async function refundOne(context: Awaited<ReturnType<typeof render>>) {
      context.action('SALES.ACTION.REFUND')!.click();
      await context.view();
      const input = context.root.querySelector<HTMLInputElement>(
        'fc-sale-refund-dialog input[inputmode=decimal]',
      )!;
      input.value = '1';
      input.dispatchEvent(new Event('input'));
      await context.view();
      context.root
        .querySelector('#sale-refund-form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await context.view();
      requestTo(backend(), `${URL}/refunds`).flush({ data: {} });
      await context.view();
    }

    it('goes to the note of the cancellation as soon as the sale read again has it', async () => {
      const context = await render();
      await cancelSale(context);
      expect(context.events.changed).toBe(1);
      expect(context.note('canceled')).toBeNull();
      await context.update({ canceled: true });
      expect(document.activeElement).toBe(context.note('canceled'));
    });

    it('goes to the note of a refund that leaves nothing to return', async () => {
      const context = await render();
      await refundOne(context);
      await context.update(NOTHING);
      expect(document.activeElement).toBe(context.note('returned'));
    });

    it('does not move when the refund is partial and there is no note', async () => {
      const context = await render();
      const before = document.activeElement;
      await refundOne(context);
      await context.update({ products: [aSaleProduct({ quantity: 2, returned: 1 })] });
      expect(context.notes()).toEqual([]);
      expect(document.activeElement).toBe(before);
    });

    it('does not move after an amendment', async () => {
      const context = await render();
      context.action('SALES.ACTION.AMEND')!.click();
      await context.view();
      const input = context.root.querySelector<HTMLInputElement>(
        'fc-sale-amend-dialog input[inputmode=decimal]',
      )!;
      input.value = '5';
      input.dispatchEvent(new Event('input'));
      await context.view();
      context.root
        .querySelector('#sale-amend-form')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      await context.view();
      requestTo(backend(), URL).flush({ data: {} });
      await context.view();
      await context.update(NOTHING);
      expect(context.note('returned')).not.toBeNull();
      expect(document.activeElement).not.toBe(context.note('returned'));
    });

    it('is forgotten when the user opens another dialog before the note appears', async () => {
      const context = await render();
      await refundOne(context);
      context.action('SALES.ACTION.AMEND')!.click();
      await context.view();
      await context.closeDialog();
      await context.update(NOTHING);
      expect(context.note('returned')).not.toBeNull();
      expect(document.activeElement).not.toBe(context.note('returned'));
    });

    it('is not asked after a deletion, which leaves the page', async () => {
      const context = await render({
        permissions: ['sales:delete'],
        sale: { nonFiscal: true },
        mode: true,
      });
      context.action(DELETE)!.click();
      await context.view();
      context.dialogButton('SALES.ACTION.DELETE_CONFIRM').click();
      await context.view();
      requestTo(backend(), URL).flush(null, { status: 204, statusText: 'No Content' });
      await context.view();
      expect(context.events).toEqual({ changed: 0, deleted: 1 });
      expect(document.activeElement).toBe(document.body);
    });
  });
});
