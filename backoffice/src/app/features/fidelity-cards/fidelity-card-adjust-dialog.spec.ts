import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { aCard } from '../../../testing/fidelity-card-page';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { entryIssue, FidelityCardAdjustDialog } from './fidelity-card-adjust-dialog';
import { FIDELITY_CARD_LIMITS, FidelityCard } from './fidelity-card.types';

const URL = `/v1/groups/g1/fidelity-cards/${aCard().id}/adjustments`;
const COLLECTIONS = [
  { id: 'pc1', name: 'Spring' },
  { id: 'pc2', name: 'Winter' },
];

@Component({
  imports: [FidelityCardAdjustDialog],
  template: `<fc-fidelity-card-adjust-dialog
    groupId="g1"
    [card]="card()"
    [prepaid]="prepaid()"
    [currency]="currency()"
    [collections]="collections()"
    [(open)]="open"
    (adjusted)="adjusted.push($event)"
    (uncertain)="uncertain = uncertain + 1"
  />`,
})
class Host {
  readonly open = signal(true);
  readonly card = signal<FidelityCard>(aCard());
  readonly prepaid = signal(true);
  readonly collections = signal<readonly { id: string; name: string }[]>(COLLECTIONS);
  readonly currency = signal('EUR');
  readonly adjusted: FidelityCard[] = [];
  uncertain = 0;
}

async function render(extra: object[] = [], setup?: (host: Host) => void) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), ...extra] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  setup?.(fixture.componentInstance);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const dialog = () => root.querySelector('dialog')!;
  const lines = () => [...root.querySelectorAll('dialog form fieldset')];
  const legends = () => lines().map((line) => line.querySelector('legend')?.textContent);
  const amountField = (index: number) => lines()[index].querySelector<HTMLInputElement>('input')!;
  const directionField = (index: number) =>
    lines()[index].querySelector<HTMLSelectElement>('select')!;
  const type = async (index: number, text: string) => {
    const input = amountField(index);
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const direct = async (index: number, value: 'add' | 'remove') => {
    const select = directionField(index);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await view();
  };
  const reasonField = () =>
    [...root.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === 'FIDELITY_CARDS.ADJUST.REASON',
    )!.control as HTMLInputElement;
  const reason = async (text: string) => {
    const input = reasonField();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const submit = async () => {
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const formError = () => root.querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const previews = () => lines().map((line) => line.querySelector('[role=status]')?.textContent);
  const errors = () => lines().map((line) => line.querySelector('.error span')?.textContent ?? '');
  return {
    fixture,
    host: fixture.componentInstance,
    root,
    view,
    dialog,
    lines,
    legends,
    amountField,
    directionField,
    type,
    direct,
    reason,
    reasonField,
    button,
    submit,
    formError,
    previews,
    errors,
  };
}

type View = Awaited<ReturnType<typeof render>>;

const DONE = { data: aCard({ balance: 15, points: [] }) };
const internal = [
  { error: { code: 'INTERNAL_ERROR', message: 'x' } },
  { status: 500, statusText: 'x' },
] as const;

describe('entryIssue', () => {
  it.each([
    ['', false, undefined],
    ['   ', false, undefined],
    ['abc', false, 'type'],
    ['1.5', false, 'type'],
    ['-5', false, 'type'],
    ['+5', false, 'type'],
    ['1e3', false, 'type'],
    ['0', false, 'incorrect'],
    ['000', false, 'incorrect'],
    [String(FIDELITY_CARD_LIMITS.amount + 1), false, 'maximum'],
    [String(FIDELITY_CARD_LIMITS.amount), false, undefined],
    ['5', false, undefined],
    [' 5 ', false, undefined],
    ['abc', true, 'type'],
    ['1.234', true, 'type'],
    ['1.', true, 'type'],
    ['.5', true, 'type'],
    ['0.00', true, 'incorrect'],
    ['0', true, 'incorrect'],
    ['1000000.01', true, 'maximum'],
    ['1000000', true, undefined],
    ['2.5', true, undefined],
    ['2.55', true, undefined],
    ['3', true, undefined],
  ] as const)('judges %j (money %s) as %s', (text, money, issue) => {
    expect(entryIssue(text, money)).toBe(issue);
  });
});

describe('FidelityCardAdjustDialog', () => {
  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('shows the title with the code, the note and a line for the credit and one for each collection', async () => {
    const { dialog, legends, root, directionField, amountField, reasonField } = await render();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().querySelector('h2')?.textContent).toBe(
      'FIDELITY_CARDS.ADJUST.TITLE {"code":"CARD-001"}',
    );
    expect(dialog().textContent).toContain('FIDELITY_CARDS.ADJUST.IMMEDIATE');
    expect(legends()).toEqual([
      'FIDELITY_CARDS.ADJUST.CREDIT',
      'FIDELITY_CARDS.ADJUST.POINTS_OF {"name":"Spring"}',
      'FIDELITY_CARDS.ADJUST.POINTS_OF {"name":"Winter"}',
    ]);
    expect(directionField(0).value).toBe('add');
    expect([...directionField(0).options].map((o) => o.textContent?.trim())).toEqual([
      'FIDELITY_CARDS.ADJUST.ADD',
      'FIDELITY_CARDS.ADJUST.REMOVE',
    ]);
    expect(amountField(0).value).toBe('');
    expect(reasonField().value).toBe('');
    expect(dialog().textContent).toContain('FIDELITY_CARDS.ADJUST.REASON_HINT {"max":200}');
    expect(root.querySelector('button[type=submit]')?.getAttribute('form')).toBe(
      'fidelity-card-adjust-form',
    );
    expect(root.querySelector('form')?.id).toBe('fidelity-card-adjust-form');
  });

  it('has no line for the credit of a card that is not prepaid', async () => {
    const { legends } = await render([], (host) => host.prepaid.set(false));
    expect(legends()).toEqual([
      'FIDELITY_CARDS.ADJUST.POINTS_OF {"name":"Spring"}',
      'FIDELITY_CARDS.ADJUST.POINTS_OF {"name":"Winter"}',
    ]);
  });

  it('has only the credit when the type has no collection', async () => {
    const { legends } = await render([], (host) => host.collections.set([]));
    expect(legends()).toEqual(['FIDELITY_CARDS.ADJUST.CREDIT']);
  });

  it('previews the new credit with two decimals and the new points, for adding and for taking away', async () => {
    const { type, direct, previews } = await render();
    expect(previews()).toEqual([undefined, undefined, undefined]);
    await type(0, '2.5');
    await type(1, '30');
    await direct(1, 'remove');
    await type(2, '2');
    expect(previews()[0]).toMatch(/^FIDELITY_CARDS\.ADJUST\.PREVIEW \{"value":"15,00\s€"\}$/);
    expect(previews().slice(1)).toEqual([
      'FIDELITY_CARDS.ADJUST.PREVIEW {"value":"90"}',
      'FIDELITY_CARDS.ADJUST.PREVIEW {"value":"9"}',
    ]);
    await direct(0, 'remove');
    expect(previews()[0]).toMatch(/"value":"10,00\s€"/);
  });

  it('starts a collection the card has no points on from zero', async () => {
    const { type, previews } = await render([], (host) =>
      host.card.set(aCard({ points: [], balance: null })),
    );
    await type(0, '4');
    await type(1, '3');
    expect(previews()[0]).toMatch(/"value":"4,00\s€"/);
    expect(previews().slice(1)).toEqual(['FIDELITY_CARDS.ADJUST.PREVIEW {"value":"3"}', undefined]);
  });

  it('shows the error of an amount only after a field is left, and gives no preview for it', async () => {
    const { type, errors, previews, amountField, view } = await render();
    await type(1, 'abc');
    expect(errors()).toEqual(['', '', '']);
    amountField(1).dispatchEvent(new Event('blur'));
    await view();
    expect(errors()[1]).toBe('FORM.ISSUE.TYPE');
    expect(previews()[1]).toBeUndefined();
    await type(1, '0');
    expect(errors()[1]).toBe('FORM.ISSUE.INCORRECT');
    await type(1, String(FIDELITY_CARD_LIMITS.amount + 1));
    expect(errors()[1]).toBe('FORM.ISSUE.MAXIMUM');
    await type(1, '5');
    expect(errors()[1]).toBe('');
  });

  it('refuses a credit with more than two decimals and points with decimals', async () => {
    const { type, submit, errors } = await render();
    await type(0, '1.234');
    await type(1, '1.5');
    await submit();
    expect(errors()).toEqual(['FORM.ISSUE.TYPE', 'FORM.ISSUE.TYPE', '']);
    backend().expectNone(`${API}${URL}`);
  });

  it('shows the error of the reason at once and does not send', async () => {
    const { type, reason, submit, root } = await render();
    await type(0, '1');
    await reason('x'.repeat(FIDELITY_CARD_LIMITS.reason + 1));
    expect(root.textContent).toContain('FORM.ISSUE.MAX_LENGTH');
    await submit();
    backend().expectNone(`${API}${URL}`);
  });

  it('does not send anything when nothing is filled in', async () => {
    const { submit } = await render();
    await submit();
    backend().expectNone(`${API}${URL}`);
  });

  it('does not send a balance below zero and says so at once, for the credit and for the points', async () => {
    const { type, direct, errors, submit } = await render();
    await direct(0, 'remove');
    await type(0, '12.51');
    await direct(1, 'remove');
    await type(1, '121');
    expect(errors()).toEqual([
      'FIDELITY_CARDS.ADJUST.INSUFFICIENT',
      'FIDELITY_CARDS.ADJUST.INSUFFICIENT',
      '',
    ]);
    await submit();
    backend().expectNone(`${API}${URL}`);
    await type(0, '12.5');
    await type(1, '120');
    expect(errors()).toEqual(['', '', '']);
  });

  describe('submitting', () => {
    it('adds to the credit with the key of the opening, shows the new balances, emits the card and moves the focus', async () => {
      const { host, type, submit, view, dialog, button, root } = await render();
      await type(0, '2.5');
      await submit();
      const request = backend().expectOne(`${API}${URL}`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ balanceDelta: 2.5 });
      expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      request.flush(DONE);
      await view();
      expect(host.adjusted).toEqual([DONE.data]);
      const outcome = dialog().querySelector('[data-outcome]') as HTMLElement;
      expect(outcome.textContent).toBe('FIDELITY_CARDS.ADJUST.DONE');
      expect(outcome.getAttribute('role')).toBe('status');
      expect(outcome.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(outcome);
      expect(dialog().textContent).toMatch(/NEW_CREDIT \{"amount":"15,00\s€"\}/);
      expect(dialog().querySelector('input')).toBeNull();
      expect(root.querySelector('button[type=submit]')).toBeNull();
      button('COMMON.CLOSE').click();
      await view();
      expect(host.open()).toBe(false);
    });

    it('lists the points of the answer with their names, and none for a collection without name', async () => {
      const { type, submit, view, dialog } = await render();
      await type(1, '5');
      await submit();
      backend()
        .expectOne(`${API}${URL}`)
        .flush({
          data: aCard({
            points: [
              { collectionId: 'pc1', name: 'Spring', points: 125, active: true },
              { collectionId: 'pcX', name: null, points: 1200, active: false },
            ],
          }),
        });
      await view();
      expect(dialog().textContent).toContain(
        'FIDELITY_CARDS.ADJUST.NEW_POINTS {"name":"Spring","points":"125"}',
      );
      expect(dialog().textContent).toMatch(
        /FIDELITY_CARDS\.ADJUST\.NEW_POINTS \{"name":"","points":"1\.?200"\}/,
      );
    });

    it('shows no credit in the outcome for a card that is not prepaid, and zero for a credit that is not known', async () => {
      const first = await render([], (host) => host.prepaid.set(false));
      await first.type(0, '5');
      await first.submit();
      backend().expectOne(`${API}${URL}`).flush(DONE);
      await first.view();
      expect(first.dialog().textContent).not.toContain('FIDELITY_CARDS.ADJUST.NEW_CREDIT');
    });

    it('shows a credit that is not known as zero', async () => {
      const { type, submit, view, dialog } = await render();
      await type(0, '5');
      await submit();
      backend()
        .expectOne(`${API}${URL}`)
        .flush({ data: aCard({ balance: null }) });
      await view();
      expect(dialog().textContent).toMatch(/NEW_CREDIT \{"amount":"0,00\s€"\}/);
    });

    it('takes points away with a negative delta, for each collection, and a trimmed reason', async () => {
      const { type, direct, reason, submit, view } = await render();
      await direct(1, 'remove');
      await type(1, '40');
      await type(2, '3');
      await reason('  Correction  ');
      await submit();
      const request = backend().expectOne(`${API}${URL}`);
      expect(request.request.body).toEqual({
        pointsDeltas: [
          { collectionId: 'pc1', delta: -40 },
          { collectionId: 'pc2', delta: 3 },
        ],
        reason: 'Correction',
      });
      request.flush(DONE);
      await view();
    });

    it('sends the credit and the points together, and no reason when it is only blanks', async () => {
      const { type, direct, reason, submit, view } = await render();
      await direct(0, 'remove');
      await type(0, '1.25');
      await type(1, '7');
      await reason('   ');
      await submit();
      const request = backend().expectOne(`${API}${URL}`);
      expect(request.request.body).toEqual({
        balanceDelta: -1.25,
        pointsDeltas: [{ collectionId: 'pc1', delta: 7 }],
      });
      request.flush(DONE);
      await view();
    });

    it('uses the same key for every submission of an opening, even when the values change', async () => {
      const { type, submit, view, formError } = await render();
      await type(0, '1');
      await submit();
      const first = backend().expectOne(`${API}${URL}`);
      const key = first.request.headers.get('Idempotency-Key');
      first.flush(...internal);
      await view();
      expect(formError()).toBe('FIDELITY_CARDS.ADJUST.UNCERTAIN');
      await type(0, '2');
      await submit();
      const second = backend().expectOne(`${API}${URL}`);
      expect(second.request.headers.get('Idempotency-Key')).toBe(key);
      expect(second.request.body).toEqual({ balanceDelta: 2 });
      second.flush(DONE);
      await view();
      expect(formError()).toBeNull();
    });

    it('ignores a second submission while the request runs and cannot be dismissed meanwhile', async () => {
      const { type, submit, button, view, host, dialog } = await render();
      await type(0, '1');
      await submit();
      await submit();
      expect(button('COMMON.CANCEL').disabled).toBe(true);
      dialog().querySelector<HTMLButtonElement>('header button')!.click();
      await view();
      expect(host.open()).toBe(true);
      backend().expectOne(`${API}${URL}`).flush(DONE);
      await view();
    });

    it('keeps the dialog open on Esc while the request runs, with the close button disabled', async () => {
      const { type, submit, view, host, dialog } = await render();
      await type(0, '1');
      await submit();
      const cancel = new Event('cancel', { cancelable: true });
      dialog().dispatchEvent(cancel);
      await view();
      expect(cancel.defaultPrevented).toBe(true);
      expect(host.open()).toBe(true);
      expect(dialog().querySelector<HTMLButtonElement>('header button')!.disabled).toBe(true);
      backend().expectOne(`${API}${URL}`).flush(DONE);
      await view();
      const later = new Event('cancel', { cancelable: true });
      dialog().dispatchEvent(later);
      expect(later.defaultPrevented).toBe(false);
    });

    it('can be dismissed again after a failure', async () => {
      const { type, submit, button, view, host } = await render();
      await type(0, '1');
      await submit();
      backend()
        .expectOne(`${API}${URL}`)
        .flush(...internal);
      await view();
      button('COMMON.CANCEL').click();
      await view();
      expect(host.open()).toBe(false);
    });
  });

  describe('failures', () => {
    const fail = async (
      code: string,
      options: {
        details?: { field: string; issue: string }[];
        headers?: Record<string, string>;
      } = {},
    ) => {
      const view = await render();
      await view.type(0, '1');
      await view.submit();
      failRequest(backend(), URL, code, options);
      await view.view();
      return view;
    };

    it('says the key was used for other values on a 409 reused', async () => {
      const { formError } = await fail('CONFLICT', {
        details: [{ field: 'Idempotency-Key', issue: 'reused' }],
      });
      expect(formError()).toBe('FIDELITY_CARDS.ADJUST.KEY_REUSED');
    });

    it.each([
      ['balanceDelta', 'insufficient', 'FIDELITY_CARDS.ADJUST.INSUFFICIENT'],
      ['pointsDeltas', 'insufficient', 'FIDELITY_CARDS.ADJUST.INSUFFICIENT'],
      ['balanceDelta', 'other', 'CONTACTS.ERROR.CONCURRENT'],
      ['Idempotency-Key', 'other', 'CONTACTS.ERROR.CONCURRENT'],
      ['reason', 'reused', 'CONTACTS.ERROR.CONCURRENT'],
    ])('maps a 409 on %s (%s) to its own text', async (field, issue, message) => {
      const { formError } = await fail('CONFLICT', { details: [{ field, issue }] });
      expect(formError()).toBe(message);
    });

    it('maps a 409 without details to the concurrent change text', async () => {
      const { formError } = await fail('CONFLICT');
      expect(formError()).toBe('CONTACTS.ERROR.CONCURRENT');
    });

    it('says how long to wait after a 429', async () => {
      const { formError } = await fail('RATE_LIMITED', { headers: { 'Retry-After': '30' } });
      expect(formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    });

    it.each([
      ['FORBIDDEN', 'ERRORS.API.FORBIDDEN'],
      ['NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
      ['VALIDATION_ERROR', 'ERRORS.API.VALIDATION_ERROR'],
    ])('shows the generic text of a %s', async (code, message) => {
      const { formError } = await fail(code);
      expect(formError()).toBe(message);
    });

    it.each([
      ['a server error', 500, 'INTERNAL_ERROR', undefined],
      ['an unavailable service', 503, 'SERVICE_UNAVAILABLE', undefined],
      ['a bad gateway', 502, 'PROVIDER_ERROR', undefined],
      [
        'a 409 with the key still pending',
        409,
        'CONFLICT',
        [{ field: 'Idempotency-Key', issue: 'pending' }],
      ],
    ])(
      'says the outcome is not known after %s, and asks the page to read again on close',
      async (_label, _status, code, details) => {
        const { host, button, view } = await fail(code, { details });
        expect(host.uncertain).toBe(0);
        button('COMMON.CANCEL').click();
        await view();
        expect(host.uncertain).toBe(1);
      },
    );

    it('says the outcome is not known when no answer came, and asks the page to read again once', async () => {
      const { type, submit, view, formError, button, host } = await render();
      await type(0, '1');
      await submit();
      backend().expectOne(`${API}${URL}`).error(new ProgressEvent('error'));
      await view();
      expect(formError()).toBe('FIDELITY_CARDS.ADJUST.UNCERTAIN');
      button('COMMON.CANCEL').click();
      await view();
      host.open.set(true);
      await view();
      host.open.set(false);
      await view();
      expect(host.uncertain).toBe(1);
    });

    it('follows the native dialog when it is dismissed (Esc once the request is over)', async () => {
      const { view, host } = await render();
      document.querySelector('dialog')!.dispatchEvent(new Event('close'));
      await view();
      expect(host.open()).toBe(false);
    });

    it('does not ask the page to read again after a failure that is certain', async () => {
      const { button, view, host } = await fail('FORBIDDEN');
      button('COMMON.CANCEL').click();
      await view();
      expect(host.uncertain).toBe(0);
    });

    it('does not ask the page to read again after a success', async () => {
      const { type, submit, view, host, button } = await render();
      await type(0, '1');
      await submit();
      backend().expectOne(`${API}${URL}`).flush(DONE);
      await view();
      button('COMMON.CLOSE').click();
      await view();
      expect(host.uncertain).toBe(0);
    });

    it('forgets a doubt of an earlier opening when the dialog is opened again', async () => {
      const { type, submit, view, host } = await render();
      await type(0, '1');
      await submit();
      backend()
        .expectOne(`${API}${URL}`)
        .flush(...internal);
      await view();
      host.open.set(false);
      await view();
      expect(host.uncertain).toBe(1);
      host.open.set(true);
      await view();
      host.open.set(false);
      await view();
      expect(host.uncertain).toBe(1);
    });

    it('asks the page to read again at once when a doubtful answer arrives for an earlier opening', async () => {
      const { type, submit, view, host, formError } = await render();
      await type(0, '1');
      await submit();
      const old = backend().expectOne(`${API}${URL}`);
      host.open.set(false);
      await view();
      host.open.set(true);
      await view();
      old.flush(...internal);
      await view();
      expect(host.uncertain).toBe(1);
      expect(formError()).toBeNull();
    });

    it('keeps what was typed after a failure', async () => {
      const { amountField } = await fail('INTERNAL_ERROR');
      expect(amountField(0).value).toBe('1');
    });

    it('reports an unexpected failure generically and logs it', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { type, submit, formError, view } = await render([
        { provide: AppConfig, useValue: { apiBaseUrl: () => null } },
      ]);
      await type(0, '1');
      await submit();
      expect(formError()).toBe('ERRORS.GENERIC.MESSAGE');
      expect(error).toHaveBeenCalled();
      await view();
    });
  });

  describe('openings', () => {
    it('cancels without sending', async () => {
      const { button, view, host } = await render();
      button('COMMON.CANCEL').click();
      await view();
      expect(host.open()).toBe(false);
    });

    it('starts clean at every opening, with a new key', async () => {
      const {
        type,
        direct,
        reason,
        submit,
        view,
        host,
        amountField,
        directionField,
        reasonField,
        formError,
      } = await render();
      await direct(0, 'remove');
      await type(0, '1');
      await reason('Because');
      await submit();
      const first = backend().expectOne(`${API}${URL}`);
      const key = first.request.headers.get('Idempotency-Key');
      first.flush(...internal);
      await view();
      expect(formError()).not.toBeNull();
      host.open.set(false);
      await view();
      host.open.set(true);
      await view();
      expect(amountField(0).value).toBe('');
      expect(directionField(0).value).toBe('add');
      expect(reasonField().value).toBe('');
      expect(formError()).toBeNull();
      await type(0, '1');
      await submit();
      const second = backend().expectOne(`${API}${URL}`);
      expect(second.request.headers.get('Idempotency-Key')).not.toBe(key);
      second.flush(DONE);
      await view();
    });

    it('shows the form again after a success and a reopening', async () => {
      const { type, submit, view, host, dialog } = await render();
      await type(0, '1');
      await submit();
      backend().expectOne(`${API}${URL}`).flush(DONE);
      await view();
      host.open.set(false);
      await view();
      host.open.set(true);
      await view();
      expect(dialog().querySelector('[data-outcome]')).toBeNull();
      expect(dialog().querySelector('input')).not.toBeNull();
    });

    it('drops the outcome of an earlier opening', async () => {
      const { type, submit, view, host, dialog } = await render();
      await type(0, '1');
      await submit();
      const old = backend().expectOne(`${API}${URL}`);
      host.open.set(false);
      await view();
      host.open.set(true);
      await view();
      old.flush(DONE);
      await view();
      expect(host.adjusted).toEqual([DONE.data]);
      expect(dialog().querySelector('[data-outcome]')).toBeNull();
      expect(dialog().querySelector('input')).not.toBeNull();
    });

    it('drops the failure of an earlier opening', async () => {
      const { type, submit, view, host, formError } = await render();
      await type(0, '1');
      await submit();
      const old = backend().expectOne(`${API}${URL}`);
      host.open.set(false);
      await view();
      host.open.set(true);
      await view();
      old.flush(...internal);
      await view();
      expect(formError()).toBeNull();
    });

    it('does not ask the page to read again when a certain failure arrives for an earlier opening', async () => {
      const { type, submit, view, host, formError } = await render();
      await type(0, '1');
      await submit();
      const old = backend().expectOne(`${API}${URL}`);
      host.open.set(false);
      await view();
      host.open.set(true);
      await view();
      old.flush({ error: { code: 'FORBIDDEN', message: 'x' } }, { status: 403, statusText: 'x' });
      await view();
      expect(host.uncertain).toBe(0);
      expect(formError()).toBeNull();
    });

    it('rebuilds the lines at an opening with the card and the collections of that moment', async () => {
      const { view, host, legends } = await render();
      host.open.set(false);
      host.prepaid.set(false);
      host.collections.set([{ id: 'pc2', name: 'Winter' }]);
      await view();
      host.open.set(true);
      await view();
      expect(legends()).toEqual(['FIDELITY_CARDS.ADJUST.POINTS_OF {"name":"Winter"}']);
    });
  });
});
