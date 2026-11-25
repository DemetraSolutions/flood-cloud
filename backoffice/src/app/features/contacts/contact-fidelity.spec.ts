import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { provideRouter } from '@angular/router';
import { settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { AdvancedCardInfo, CONTACT_LIMITS, PointsAdjustment } from './contact.types';
import { ContactApi } from './contact-api';
import { ContactFidelity } from './contact-fidelity';

const BALANCE = formatNumber(1200, DEFAULT_LANGUAGE, { maximumFractionDigits: 0 });

@Component({
  imports: [ContactFidelity],
  template: `<fc-contact-fidelity
    groupId="g1"
    [contactId]="contactId()"
    [(value)]="value"
    [points]="points()"
    [advanced]="advanced()"
    [canReadCards]="canReadCards()"
    [currency]="currency()"
    [canAdjust]="canAdjust()"
    [error]="error()"
    [disabled]="disabled()"
    (adjusted)="adjusted.push($event)"
    (uncertain)="uncertain = uncertain + 1"
  />`,
})
class Host {
  readonly value = signal<string[]>(['CARD-A', 'CARD-B']);
  readonly contactId = signal<string | undefined>('c1');
  readonly points = signal<Readonly<Record<string, number>>>({ 'CARD-A': 1200, 'CARD-B': 0 });
  readonly advanced = signal<Readonly<Record<string, AdvancedCardInfo>>>({});
  readonly canReadCards = signal(true);
  readonly currency = signal('EUR');
  readonly canAdjust = signal(true);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
  readonly adjusted: PointsAdjustment[] = [];
  uncertain = 0;
}

async function render(configure: (host: Host) => void = () => undefined) {
  emulateNativeDialog();
  const api = {
    adjustPoints: vi.fn(async (_g: string, _c: string, code: string, delta: number) => ({
      code,
      points: 1200 + delta,
    })),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: ContactApi, useValue: api }],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  configure(fixture.componentInstance);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const rows = () => [...root.querySelectorAll<HTMLElement>('ul.rows > li')];
  const buttonIn = (parent: ParentNode, text: string) =>
    [...parent.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    );
  const component = fixture.debugElement.children[0].componentInstance as ContactFidelity;
  return { host: fixture.componentInstance, root, view, rows, buttonIn, component, api };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactFidelity', () => {
  it('shows the saved cards as text with their balance, without a field', async () => {
    const { rows, root } = await render();
    expect(rows()).toHaveLength(2);
    expect(rows()[0].querySelector('input')).toBeNull();
    expect(rows()[0].querySelector('.card strong')?.textContent).toBe('CARD-A');
    expect(rows()[0].querySelector('.points')?.textContent).toBe(
      `CONTACTS.FIDELITY.POINTS {"points":"${BALANCE}"}`,
    );
    expect(rows()[1].querySelector('.points')?.textContent).toContain('"points":"0"');
    expect(root.querySelector('legend')?.textContent).toBe('CONTACTS.FIDELITY.TITLE');
    expect(root.querySelector('fieldset')?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('says there are no cards when none is set', async () => {
    const { root, view, host } = await render();
    host.value.set([]);
    await view();
    expect(root.querySelector('li.note')?.textContent).toBe('CONTACTS.FIDELITY.EMPTY');
  });

  it('adds an empty code with a field that takes the focus, and edits it', async () => {
    const { rows, root, view, host, buttonIn } = await render();
    buttonIn(root, 'CONTACTS.FIDELITY.ADD')!.click();
    await view();
    expect(host.value()).toEqual(['CARD-A', 'CARD-B', '']);
    expect(rows()[2].querySelector('.points')).toBeNull();
    expect(buttonIn(rows()[2], 'CONTACTS.FIDELITY.ADJUST')).toBeUndefined();
    const input = rows()[2].querySelector('input')!;
    expect(document.activeElement).toBe(input);
    expect(rows()[2].querySelector('label')?.textContent?.trim()).toBe(
      'CONTACTS.FIDELITY.CODE_N {"number":3}',
    );
    input.value = 'CARD-C';
    input.dispatchEvent(new Event('input'));
    await view();
    expect(host.value()).toEqual(['CARD-A', 'CARD-B', 'CARD-C']);
  });

  it('does not take more cards than the limit', async () => {
    const { root, view, host, buttonIn } = await render();
    host.value.set(Array.from({ length: CONTACT_LIMITS.cards }, (_, i) => `K${i}`));
    await view();
    expect(buttonIn(root, 'CONTACTS.FIDELITY.ADD')!.disabled).toBe(true);
  });

  it('removes a card without points at once and focuses the next row', async () => {
    const { rows, view, host, buttonIn, root } = await render((h) =>
      h.value.set(['CARD-B', 'CARD-A']),
    );
    buttonIn(rows()[0], 'CONTACTS.LIST.REMOVE')!.click();
    await view();
    expect(host.value()).toEqual(['CARD-A']);
    expect(root.querySelector('dialog[open]')).toBeNull();
    expect(document.activeElement).toBe(buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST'));
  });

  it('removes an unsaved card at once, names the button by its label while the code is empty, and focuses the previous row', async () => {
    const { rows, view, host, buttonIn } = await render((h) => h.value.set(['CARD-A', '']));
    const remove = buttonIn(rows()[1], 'CONTACTS.LIST.REMOVE')!;
    expect(remove.getAttribute('aria-label')).toBe(
      'CONTACTS.LIST.REMOVE_LABEL {"name":"CONTACTS.FIDELITY.CODE_N {\\"number\\":2}"}',
    );
    expect(buttonIn(rows()[0], 'CONTACTS.LIST.REMOVE')!.getAttribute('aria-label')).toBe(
      'CONTACTS.LIST.REMOVE_LABEL {"name":"CARD-A"}',
    );
    remove.click();
    await view();
    expect(host.value()).toEqual(['CARD-A']);
    expect(document.activeElement).toBe(buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST'));
  });

  it('focuses the button that adds a card when the last one is removed', async () => {
    const { rows, view, host, buttonIn, root } = await render((h) => h.value.set(['NEW']));
    buttonIn(rows()[0], 'CONTACTS.LIST.REMOVE')!.click();
    await view();
    expect(host.value()).toEqual([]);
    expect(document.activeElement).toBe(buttonIn(root, 'CONTACTS.FIDELITY.ADD'));
  });

  it('asks for confirmation before removing a card with points, naming it and saying the balance is lost', async () => {
    const { rows, view, host, buttonIn, root } = await render();
    buttonIn(rows()[0], 'CONTACTS.LIST.REMOVE')!.click();
    await view();
    const dialog = root.querySelector('dialog[open]')!;
    expect(dialog.querySelector('h2')?.textContent).toBe(
      'CONTACTS.FIDELITY.REMOVE_TITLE {"code":"CARD-A"}',
    );
    expect(dialog.textContent).toContain(
      `CONTACTS.FIDELITY.REMOVE_CONFIRM {"points":"${BALANCE}"}`,
    );
    expect(host.value()).toEqual(['CARD-A', 'CARD-B']);
    buttonIn(dialog, 'CONTACTS.LIST.REMOVE')!.click();
    await view();
    expect(host.value()).toEqual(['CARD-B']);
    expect(root.querySelector('dialog[open]')).toBeNull();
  });

  it('keeps the card when the user cancels the removal', async () => {
    const { rows, view, host, buttonIn, root } = await render();
    buttonIn(rows()[0], 'CONTACTS.LIST.REMOVE')!.click();
    await view();
    buttonIn(root.querySelector('dialog[open]')!, 'COMMON.CANCEL')!.click();
    await view();
    expect(host.value()).toEqual(['CARD-A', 'CARD-B']);
    expect(root.querySelector('dialog[open]')).toBeNull();
  });

  it('shows the error of a code and of the whole list', async () => {
    const { rows, view, host, root } = await render((h) => h.value.set(['x'.repeat(65), 'CARD-B']));
    host.error.set('Too many');
    await view();
    expect(rows()[0].textContent).toContain('FORM.ISSUE.MAX_LENGTH');
    expect(rows()[1].querySelector('[role=alert]')).toBeNull();
    const alert = root.querySelector('p.problem')!;
    expect(alert.textContent).toBe('Too many');
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('refuses a code made only of dots', async () => {
    const { rows } = await render((h) => h.value.set(['...']));
    expect(rows()[0].textContent).toContain('FORM.ISSUE.FORMAT');
  });

  it('is read only when disabled: a field that is disabled, no add, remove or adjust', async () => {
    const { rows, root, view, host } = await render((h) => h.value.set(['NEW', 'CARD-A']));
    host.disabled.set(true);
    await view();
    expect(rows()[0].querySelector('input')!.disabled).toBe(true);
    expect(root.querySelector('fieldset button')).toBeNull();
  });

  describe('adjusting the points', () => {
    it('offers the adjustment only for a saved card and with canAdjust', async () => {
      const { rows, buttonIn, view, host } = await render((h) => h.value.set(['CARD-A', 'NEW']));
      expect(buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')).toBeDefined();
      expect(buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')!.getAttribute('aria-label')).toBe(
        'CONTACTS.FIDELITY.ADJUST_LABEL {"name":"CARD-A"}',
      );
      expect(buttonIn(rows()[1], 'CONTACTS.FIDELITY.ADJUST')).toBeUndefined();
      host.canAdjust.set(false);
      await view();
      expect(buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')).toBeUndefined();
    });

    it('does not offer a dialog while the contact is being created', async () => {
      const { root, buttonIn, rows, view } = await render((h) => h.contactId.set(undefined));
      buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')!.click();
      await view();
      expect(root.querySelector('fc-contact-points-dialog')).toBeNull();
    });

    it('closes the adjustment when the native dialog is dismissed', async () => {
      const { root, rows, buttonIn, view } = await render();
      buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')!.click();
      await view();
      root.querySelector('dialog[open]')!.dispatchEvent(new Event('close'));
      await view();
      expect(root.querySelector('dialog[open]')).toBeNull();
    });

    it('forwards an uncertain outcome of the adjustment', async () => {
      const { root, rows, buttonIn, view, host, api } = await render();
      api.adjustPoints.mockRejectedValueOnce(
        new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' }),
      );
      buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')!.click();
      await view();
      const dialog = root.querySelector('dialog[open]')!;
      const amount = dialog.querySelector<HTMLInputElement>('input[inputmode=numeric]')!;
      amount.value = '5';
      amount.dispatchEvent(new Event('input'));
      await view();
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await view();
      buttonIn(dialog, 'COMMON.CANCEL')!.click();
      await view();
      expect(host.uncertain).toBe(1);
    });

    it('opens the dialog for the card and forwards the new balance', async () => {
      const { root, rows, buttonIn, view, host, api } = await render();
      buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')!.click();
      await view();
      const dialog = root.querySelector('dialog[open]')!;
      expect(dialog.textContent).toContain('CONTACTS.POINTS.TITLE {"code":"CARD-A"}');
      expect(dialog.textContent).toContain(`CONTACTS.POINTS.BALANCE {"points":"${BALANCE}"}`);
      const amount = dialog.querySelector<HTMLInputElement>('input[inputmode=numeric]')!;
      amount.value = '50';
      amount.dispatchEvent(new Event('input'));
      await view();
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await view();
      expect(api.adjustPoints).toHaveBeenCalledWith(
        'g1',
        'c1',
        'CARD-A',
        50,
        null,
        expect.any(String),
      );
      expect(host.adjusted).toEqual([{ code: 'CARD-A', points: 1250 }]);
    });
  });

  describe('advanced cards', () => {
    const card = (change: Partial<AdvancedCardInfo> = {}): AdvancedCardInfo => ({
      cardId: 'fc1',
      cardType: { id: 'ct1', name: 'Gold' },
      enabled: true,
      balance: 12.5,
      totalPoints: 1200,
      ...change,
    });
    const withCard = (change: Partial<AdvancedCardInfo> = {}) =>
      render((h) => {
        h.value.set(['ADV-1']);
        h.advanced.set({ 'ADV-1': card(change) });
        // The points of the contact must not be shown for an advanced card.
        h.points.set({ 'ADV-1': 500 });
      });

    it('shows type, state, credit and total points, with a link to the card, and no points of the contact', async () => {
      const { rows } = await withCard();
      const row = rows()[0];
      expect(row.querySelector('div.card strong')?.textContent).toBe('ADV-1');
      expect(row.textContent).toContain('CONTACTS.FIDELITY.ADVANCED');
      expect(row.textContent).toContain('Gold');
      expect(row.querySelector('fc-status-badge')?.textContent?.trim()).toBe(
        'FIDELITY_CARDS.STATE.ENABLED',
      );
      expect(row.textContent).toContain('FIDELITY_CARDS.BALANCES.CREDIT');
      expect(row.textContent).toContain(`CONTACTS.FIDELITY.TOTAL_POINTS {"points":"${BALANCE}"}`);
      expect(row.querySelector('a')?.getAttribute('href')).toBe('/groups/g1/fidelity/cards/fc1');
      expect(row.textContent).not.toContain('CONTACTS.FIDELITY.POINTS ');
      expect(row.querySelector('input')).toBeNull();
    });

    it('shows only the code and "advanced" when the user cannot read the card, and still asks before removing it', async () => {
      const { rows, buttonIn, view, host, root } = await render((h) => {
        h.value.set(['ADV-1']);
        h.advanced.set({
          'ADV-1': {
            cardId: null,
            cardType: null,
            enabled: null,
            balance: null,
            totalPoints: null,
          },
        });
      });
      const row = rows()[0];
      expect(row.querySelector('div.card strong')?.textContent).toBe('ADV-1');
      expect(row.textContent).toContain('CONTACTS.FIDELITY.ADVANCED');
      expect(row.querySelector('fc-status-badge')).toBeNull();
      expect(row.querySelector('a')).toBeNull();
      expect(row.textContent).not.toContain('TYPE_GONE');
      expect(row.textContent).not.toContain('TOTAL_POINTS');
      buttonIn(row, 'CONTACTS.LIST.REMOVE')!.click();
      await view();
      expect(root.querySelector('dialog[open]')?.textContent).toContain(
        'CONTACTS.FIDELITY.REMOVE_ADVANCED',
      );
      buttonIn(root.querySelector('dialog[open]')!, 'CONTACTS.LIST.REMOVE')!.click();
      await view();
      expect(host.value()).toEqual([]);
    });

    it('leaves the total points empty when the card has none', async () => {
      const { rows } = await withCard({ totalPoints: null });
      expect(rows()[0].querySelector('.points')?.textContent).toBe(
        'CONTACTS.FIDELITY.TOTAL_POINTS {"points":""}',
      );
    });

    it('offers no adjustment, even when the user may adjust and the code has points', async () => {
      const { rows, buttonIn } = await withCard();
      expect(buttonIn(rows()[0], 'CONTACTS.FIDELITY.ADJUST')).toBeUndefined();
    });

    it('shows a disabled card, a type that no longer exists and no credit, and no link without permission', async () => {
      const { rows, view, host } = await withCard({
        enabled: false,
        cardType: null,
        balance: null,
      });
      host.canReadCards.set(false);
      await view();
      const row = rows()[0];
      expect(row.querySelector('fc-status-badge')?.textContent?.trim()).toBe(
        'FIDELITY_CARDS.STATE.DISABLED',
      );
      expect(row.textContent).toContain('FIDELITY_CARDS.TYPE_GONE');
      expect(row.textContent).not.toContain('BALANCES.CREDIT');
      expect(row.querySelector('a')).toBeNull();
    });

    it('formats the credit in the currency given', async () => {
      const { rows, view, host } = await withCard({ balance: 3 });
      host.currency.set('USD');
      await view();
      expect(rows()[0].textContent).toContain('BALANCES.CREDIT');
      expect(rows()[0].textContent).toMatch(/3[.,]00/);
    });

    it('always asks before removing it, with the text of the advanced card', async () => {
      const { rows, buttonIn, view, host, root } = await withCard();
      host.points.set({});
      await view();
      buttonIn(rows()[0], 'CONTACTS.LIST.REMOVE')!.click();
      await view();
      const dialog = root.querySelector('dialog[open]')!;
      expect(dialog.querySelector('h2')?.textContent).toBe(
        'CONTACTS.FIDELITY.REMOVE_TITLE {"code":"ADV-1"}',
      );
      expect(dialog.textContent).toContain('CONTACTS.FIDELITY.REMOVE_ADVANCED');
      buttonIn(dialog, 'CONTACTS.LIST.REMOVE')!.click();
      await view();
      expect(host.value()).toEqual([]);
    });
  });

  it('focuses the first field of a code', async () => {
    const { rows, component } = await render((h) => h.value.set(['CARD-A', 'NEW']));
    component.focus();
    expect(document.activeElement).toBe(rows()[1].querySelector('input'));
  });

  it('does not fail to focus when it has no field', async () => {
    const { component } = await render();
    expect(() => component.focus()).not.toThrow();
  });
});
