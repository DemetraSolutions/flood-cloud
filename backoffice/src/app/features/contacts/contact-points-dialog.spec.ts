import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  API,
  backend,
  errorBody,
  failRequest,
  provideApiTesting,
  settle,
} from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { amountIssue, ContactPointsDialog } from './contact-points-dialog';
import { CONTACT_LIMITS, PointsAdjustment } from './contact.types';

const URL = `/v1/groups/g1/contacts/c1/fidelity-cards/${encodeURIComponent('A/B 1')}/points-adjustments`;

@Component({
  imports: [ContactPointsDialog],
  template: `<fc-contact-points-dialog
    groupId="g1"
    contactId="c1"
    code="A/B 1"
    [points]="points()"
    [(open)]="open"
    (adjusted)="adjusted.push($event)"
    (uncertain)="uncertain = uncertain + 1"
  />`,
})
class Host {
  readonly open = signal(true);
  readonly points = signal(100);
  readonly adjusted: PointsAdjustment[] = [];
  uncertain = 0;
}

async function render(extra: object[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), ...extra] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const dialog = () => root.querySelector('dialog')!;
  const field = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))!
      .control as HTMLInputElement;
  const type = async (label: string, text: string) => {
    const input = field(label);
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const direct = async (value: 'add' | 'remove') => {
    const select = field('CONTACTS.POINTS.DIRECTION') as unknown as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await view();
  };
  const formError = () => root.querySelector('fc-form-error')?.textContent?.trim() ?? null;
  return {
    direct,
    fixture,
    host: fixture.componentInstance,
    root,
    view,
    dialog,
    field,
    type,
    button,
    submit,
    formError,
  };
}

const AMOUNT = 'CONTACTS.POINTS.AMOUNT';
const REASON = 'CONTACTS.POINTS.REASON';
const DONE = { data: { code: 'A/B 1', points: 125 } };
const internal = [
  { error: { code: 'INTERNAL_ERROR', message: 'x' } },
  { status: 500, statusText: 'x' },
] as const;

describe('amountIssue', () => {
  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['abc', 'type'],
    ['1.5', 'type'],
    ['-5', 'type'],
    ['+5', 'type'],
    ['0', 'incorrect'],
    ['000', 'incorrect'],
    [String(CONTACT_LIMITS.pointsDelta + 1), 'maximum'],
    [String(CONTACT_LIMITS.pointsDelta), undefined],
    ['5', undefined],
    [' 5 ', undefined],
  ])('judges %j as %s', (text, issue) => {
    expect(amountIssue(text)).toBe(issue);
  });
});

describe('ContactPointsDialog', () => {
  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('shows the card, the balance, the note and the empty form', async () => {
    const { dialog, field, root } = await render();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().querySelector('h2')?.textContent).toBe(
      'CONTACTS.POINTS.TITLE {"code":"A/B 1"}',
    );
    expect(dialog().textContent).toContain('CONTACTS.POINTS.BALANCE {"points":"100"}');
    expect(dialog().textContent).toContain('CONTACTS.POINTS.IMMEDIATE');
    expect((field('CONTACTS.POINTS.DIRECTION') as unknown as HTMLSelectElement).value).toBe('add');
    expect(field(AMOUNT).value).toBe('');
    expect(field(REASON).value).toBe('');
    expect(dialog().textContent).toContain('CONTACTS.POINTS.REASON_HINT {"max":200}');
    expect(root.querySelector('button[type=submit]')?.getAttribute('form')).toBe(
      'contact-points-form',
    );
    expect(root.querySelector('form')?.id).toBe('contact-points-form');
  });

  it('shows the error of the amount after the field is left, and of the reason at once', async () => {
    const { field, type, view, root } = await render();
    expect(root.querySelector('[role=alert]')).toBeNull();
    field(AMOUNT).dispatchEvent(new Event('blur'));
    await view();
    expect(root.textContent).toContain('FORM.ISSUE.REQUIRED');
    await type(AMOUNT, '0');
    expect(root.textContent).toContain('FORM.ISSUE.INCORRECT');
    await type(REASON, 'x'.repeat(CONTACT_LIMITS.pointsReason + 1));
    expect(root.textContent).toContain('FORM.ISSUE.MAX_LENGTH');
  });

  it('previews the new balance for adding and for taking away', async () => {
    const { type, direct, root } = await render();
    expect(root.textContent).not.toContain('CONTACTS.POINTS.PREVIEW');
    await type(AMOUNT, '25');
    expect(root.querySelector('[role=status]')?.textContent).toBe(
      'CONTACTS.POINTS.PREVIEW {"points":"125"}',
    );
    await direct('remove');
    expect(root.querySelector('[role=status]')?.textContent).toBe(
      'CONTACTS.POINTS.PREVIEW {"points":"75"}',
    );
  });

  it('does not send anything while the form is not valid, and shows the errors', async () => {
    const { submit, type, root } = await render();
    await submit();
    expect(root.textContent).toContain('FORM.ISSUE.REQUIRED');
    await type(AMOUNT, '5');
    await type(REASON, 'x'.repeat(CONTACT_LIMITS.pointsReason + 1));
    await submit();
    backend().expectNone(`${API}${URL}`);
  });

  it('does not send a balance below zero and says so', async () => {
    const { submit, type, direct, root } = await render();
    await direct('remove');
    await type(AMOUNT, '101');
    expect(root.textContent).toContain('CONTACTS.POINTS.INSUFFICIENT');
    await submit();
    backend().expectNone(`${API}${URL}`);
    await type(AMOUNT, '100');
    expect(root.textContent).not.toContain('CONTACTS.POINTS.INSUFFICIENT');
  });

  it('adds points with the key of the opening, shows the new balance, emits it and moves the focus', async () => {
    const { host, type, submit, view, dialog, button } = await render();
    await type(AMOUNT, '25');
    await submit();
    const req = backend().expectOne(`${API}${URL}`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ delta: 25 });
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    req.flush(DONE);
    await view();
    expect(host.adjusted).toEqual([{ code: 'A/B 1', points: 125 }]);
    const outcome = dialog().querySelector('[role=status]') as HTMLElement;
    expect(outcome.textContent).toBe('CONTACTS.POINTS.DONE {"points":"125"}');
    expect(outcome.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(outcome);
    expect(dialog().querySelector('input')).toBeNull();
    button('COMMON.CLOSE').click();
    await view();
    expect(host.open()).toBe(false);
  });

  it('takes points away with a negative delta and a trimmed reason', async () => {
    const { type, direct, submit, view } = await render();
    await direct('remove');
    await type(AMOUNT, '40');
    await type(REASON, '  Correction  ');
    await submit();
    const req = backend().expectOne(`${API}${URL}`);
    expect(req.request.body).toEqual({ delta: -40, reason: 'Correction' });
    req.flush({ data: { code: 'A/B 1', points: 60 } });
    await view();
  });

  it('sends no reason when it is only blanks', async () => {
    const { type, submit, view } = await render();
    await type(AMOUNT, '3');
    await type(REASON, '   ');
    await submit();
    const req = backend().expectOne(`${API}${URL}`);
    expect(req.request.body).toEqual({ delta: 3 });
    req.flush(DONE);
    await view();
  });

  it('uses the same key for every submission of an opening, even when the values change', async () => {
    const { type, submit, view, formError } = await render();
    await type(AMOUNT, '10');
    await submit();
    const first = backend().expectOne(`${API}${URL}`);
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(...internal);
    await view();
    expect(formError()).toBe('CONTACTS.POINTS.UNCERTAIN');
    await type(AMOUNT, '11');
    await submit();
    const second = backend().expectOne(`${API}${URL}`);
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    expect(second.request.body).toEqual({ delta: 11 });
    second.flush(DONE);
    await view();
  });

  it('ignores a second submission while the request is running and cannot be dismissed meanwhile', async () => {
    const { type, submit, button, view, host, dialog } = await render();
    await type(AMOUNT, '1');
    await submit();
    await submit();
    expect(button('COMMON.CANCEL').disabled).toBe(true);
    dialog().querySelector<HTMLButtonElement>('header button')!.click();
    await view();
    expect(host.open()).toBe(true);
    backend().expectOne(`${API}${URL}`).flush(DONE);
    await view();
  });

  it('says the key was used for other values on a 409 reused', async () => {
    const { type, submit, view, formError } = await render();
    await type(AMOUNT, '5');
    await submit();
    failRequest(backend(), URL, 'CONFLICT', {
      details: [{ field: 'Idempotency-Key', issue: 'reused' }],
    });
    await view();
    expect(formError()).toBe('CONTACTS.POINTS.KEY_REUSED');
  });

  it.each([
    ['points', 'insufficient', 'CONTACTS.POINTS.INSUFFICIENT'],
    ['code', 'duplicate', 'CONTACTS.POINTS.DUPLICATE'],
    ['code', 'advancedCard', 'CONTACTS.POINTS.ADVANCED_CARD'],
    ['points', 'other', 'CONTACTS.ERROR.CONCURRENT'],
    ['Idempotency-Key', 'other', 'CONTACTS.ERROR.CONCURRENT'],
  ])('maps a 409 on %s (%s) to its own text', async (field, issue, message) => {
    const { type, submit, view, formError } = await render();
    await type(AMOUNT, '5');
    await submit();
    failRequest(backend(), URL, 'CONFLICT', { details: [{ field, issue }] });
    await view();
    expect(formError()).toBe(message);
  });

  it('maps a 409 without details to the concurrent change text', async () => {
    const { type, submit, view, formError } = await render();
    await type(AMOUNT, '5');
    await submit();
    failRequest(backend(), URL, 'CONFLICT');
    await view();
    expect(formError()).toBe('CONTACTS.ERROR.CONCURRENT');
  });

  it('says how long to wait after a 429', async () => {
    const { type, submit, view, formError } = await render();
    await type(AMOUNT, '5');
    await submit();
    failRequest(backend(), URL, 'RATE_LIMITED', { headers: { 'Retry-After': '30' } });
    await view();
    expect(formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
  });

  it.each([
    ['FORBIDDEN', 'ERRORS.API.FORBIDDEN'],
    ['NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
    ['VALIDATION_ERROR', 'ERRORS.API.VALIDATION_ERROR'],
  ])('shows the generic text of a %s', async (code, message) => {
    const { type, submit, view, formError } = await render();
    await type(AMOUNT, '5');
    await submit();
    failRequest(backend(), URL, code);
    await view();
    expect(formError()).toBe(message);
  });

  it('reports an unexpected failure generically and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { type, submit, formError, view } = await render([
      { provide: AppConfig, useValue: { apiBaseUrl: () => null } },
    ]);
    await type(AMOUNT, '5');
    await submit();
    expect(formError()).toBe('ERRORS.GENERIC.MESSAGE');
    expect(error).toHaveBeenCalled();
    await view();
  });

  it('cancels without sending', async () => {
    const { button, view, host } = await render();
    button('COMMON.CANCEL').click();
    await view();
    expect(host.open()).toBe(false);
  });

  it('follows the native dialog when it is dismissed (Esc once the request is over)', async () => {
    const { view, host } = await render();
    document.querySelector('dialog')!.dispatchEvent(new Event('close'));
    await view();
    expect(host.open()).toBe(false);
  });

  it('starts clean at every opening, with a new key', async () => {
    const { type, direct, submit, view, host, field, formError } = await render();
    await direct('remove');
    await type(AMOUNT, '10');
    await type(REASON, 'Because');
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
    expect(field(AMOUNT).value).toBe('');
    expect(field(REASON).value).toBe('');
    expect((field('CONTACTS.POINTS.DIRECTION') as unknown as HTMLSelectElement).value).toBe('add');
    expect(formError()).toBeNull();
    await type(AMOUNT, '10');
    await submit();
    const second = backend().expectOne(`${API}${URL}`);
    expect(second.request.headers.get('Idempotency-Key')).not.toBe(key);
    second.flush(DONE);
    await view();
  });

  it('drops the outcome of an earlier opening', async () => {
    const { type, submit, view, host, dialog, formError } = await render();
    await type(AMOUNT, '10');
    await submit();
    const old = backend().expectOne(`${API}${URL}`);
    host.open.set(false);
    await view();
    host.open.set(true);
    await view();
    old.flush(DONE);
    await view();
    expect(host.adjusted).toEqual([{ code: 'A/B 1', points: 125 }]);
    expect(dialog().querySelector('[role=status]')).toBeNull();
    expect(dialog().querySelector('input')).not.toBeNull();
  });

  it('announces an uncertain outcome of an earlier opening at once', async () => {
    const { type, submit, view, host } = await render();
    await type(AMOUNT, '10');
    await submit();
    const old = backend().expectOne(`${API}${URL}`);
    host.open.set(false);
    await view();
    host.open.set(true);
    await view();
    old.flush(...internal);
    await view();
    expect(host.uncertain).toBe(1);
  });

  it('says the outcome is not known after a server error or no answer, and reports it once when the dialog closes', async () => {
    const { type, submit, view, host, formError, button } = await render();
    await type(AMOUNT, '10');
    await submit();
    backend()
      .expectOne(`${API}${URL}`)
      .flush(...internal);
    await view();
    expect(formError()).toBe('CONTACTS.POINTS.UNCERTAIN');
    expect(host.uncertain).toBe(0);
    await submit();
    backend().expectOne(`${API}${URL}`).error(new ProgressEvent('error'));
    await view();
    expect(formError()).toBe('CONTACTS.POINTS.UNCERTAIN');
    button('COMMON.CANCEL').click();
    await view();
    expect(host.uncertain).toBe(1);
    host.open.set(true);
    await view();
    host.open.set(false);
    await view();
    expect(host.uncertain).toBe(1);
  });

  it('does not report as uncertain a failure whose outcome is known', async () => {
    const { type, submit, view, host, button } = await render();
    await type(AMOUNT, '10');
    await submit();
    failRequest(backend(), URL, 'FORBIDDEN');
    await view();
    button('COMMON.CANCEL').click();
    await view();
    expect(host.uncertain).toBe(0);
  });

  it('keeps the dialog open on Esc while the request runs, with the close button disabled', async () => {
    const { type, submit, view, host, dialog } = await render();
    await type(AMOUNT, '10');
    await submit();
    const cancel = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog().querySelector<HTMLButtonElement>('header button')!.disabled).toBe(true);
    backend().expectOne(`${API}${URL}`).flush(DONE);
    await view();
    const later = new Event('cancel', { cancelable: true });
    dialog().dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    expect(host.open()).toBe(true);
  });

  it('ignores a failure of an earlier opening whose outcome is known', async () => {
    const { type, submit, view, host } = await render();
    await type(AMOUNT, '10');
    await submit();
    const old = backend().expectOne(`${API}${URL}`);
    host.open.set(false);
    await view();
    host.open.set(true);
    await view();
    old.flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(host.uncertain).toBe(0);
  });

  it('drops the failure of an earlier opening', async () => {
    const { type, submit, view, host, formError } = await render();
    await type(AMOUNT, '10');
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

  it('shows the form again after a success and a reopening', async () => {
    const { type, submit, view, host, dialog } = await render();
    await type(AMOUNT, '10');
    await submit();
    backend().expectOne(`${API}${URL}`).flush(DONE);
    await view();
    host.open.set(false);
    await view();
    host.open.set(true);
    await view();
    expect(dialog().querySelector('[role=status]')).toBeNull();
    expect(dialog().querySelector('input')).not.toBeNull();
  });
});
