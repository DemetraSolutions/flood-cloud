import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { emulateNativeDialog } from '../../../testing/dialog';
import { findControl, typeInto } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { PinDialog, PinSubmission } from './pin-dialog';

@Component({
  imports: [PinDialog],
  template: `
    <form (submit)="outerSubmits.update((n) => n + 1)">
      <fc-pin-dialog
        heading="Titolo"
        [(open)]="open"
        [mode]="mode()"
        [askPassword]="askPassword()"
        [busy]="busy()"
        [pinError]="pinError()"
        [passwordError]="passwordError()"
        (submitted)="submissions.update((list) => [...list, $event])"
      />
    </form>
  `,
})
class Host {
  readonly open = signal(true);
  readonly mode = signal<'set' | 'remove'>('set');
  readonly askPassword = signal(false);
  readonly busy = signal(false);
  readonly pinError = signal<string | null>(null);
  readonly passwordError = signal<string | null>(null);
  readonly submissions = signal<PinSubmission[]>([]);
  readonly outerSubmits = signal(0);
}

async function render() {
  emulateNativeDialog();
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const host = fixture.componentInstance;
  const root = fixture.nativeElement as HTMLElement;
  const dialog = () => root.querySelector('dialog')!;
  const form = () => root.querySelector<HTMLFormElement>('form#pin-form');
  const footer = () => [...root.querySelectorAll<HTMLButtonElement>('footer button')];
  const submit = async () => {
    form()!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await fixture.whenStable();
  };
  const update = async (change: () => void) => {
    change();
    await fixture.whenStable();
  };
  const errors = () =>
    [...root.querySelectorAll('.error span')].map((element) => element.textContent?.trim());
  return { fixture, host, root, dialog, form, footer, submit, update, errors };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('PinDialog', () => {
  it('asks only for the new PIN in set mode, as a numeric one-time secret', async () => {
    const { root, dialog, footer, form } = await render();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Titolo');
    expect(form()!.querySelector('p')?.textContent).toBe('PIN.SET_INTRO');
    const pin = form()!.querySelector<HTMLInputElement>('input')!;
    expect(form()!.querySelectorAll('input').length).toBe(1);
    expect(pin.type).toBe('password');
    expect(pin.getAttribute('autocomplete')).toBe('new-password');
    expect(pin.getAttribute('inputmode')).toBe('numeric');
    expect(footer().map((b) => b.textContent?.trim())).toEqual(['COMMON.CANCEL', 'PIN.SET']);
    expect(footer()[1].getAttribute('data-variant')).toBe('primary');
    expect(footer()[1].getAttribute('form')).toBe('pin-form');
  });

  it.each(['', '12', '1234567', 'abcd', '12a4'])(
    'rejects the PIN "%s" locally without emitting',
    async (value) => {
      const { fixture, host, errors, submit } = await render();
      await typeInto(fixture, 'PIN.LABEL', value);
      await submit();
      expect(errors()).toEqual(['FORM.ISSUE.PATTERN']);
      expect(host.submissions()).toEqual([]);
    },
  );

  it.each(['123', '1234', '123456'])('emits the valid PIN "%s"', async (value) => {
    const { fixture, host, errors, submit } = await render();
    await typeInto(fixture, 'PIN.LABEL', value);
    await submit();
    expect(errors()).toEqual([]);
    expect(host.submissions()).toEqual([{ pin: value, password: '' }]);
  });

  it('clears the local error once the PIN is corrected and confirmed', async () => {
    const { fixture, host, errors, submit } = await render();
    await submit();
    expect(errors()).toEqual(['FORM.ISSUE.PATTERN']);
    await typeInto(fixture, 'PIN.LABEL', '4321');
    await submit();
    expect(errors()).toEqual([]);
    expect(host.submissions()).toEqual([{ pin: '4321', password: '' }]);
  });

  it('does not let the submission reach the form around the dialog', async () => {
    const { fixture, host, submit } = await render();
    await typeInto(fixture, 'PIN.LABEL', '1234');
    const event = new Event('submit', { cancelable: true, bubbles: true });
    fixture.nativeElement.querySelector('form#pin-form').dispatchEvent(event);
    await submit();
    expect(event.defaultPrevented).toBe(true);
    expect(host.submissions().length).toBe(2);
    expect(host.outerSubmits()).toBe(0);
  });

  it('also asks for the current password when required', async () => {
    const { fixture, host, update, form, errors, submit } = await render();
    await update(() => host.askPassword.set(true));
    expect(form()!.querySelectorAll('input').length).toBe(2);
    const password = findControl(fixture, 'PIN.CURRENT_PASSWORD');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect((password as HTMLInputElement).type).toBe('password');

    await typeInto(fixture, 'PIN.LABEL', '1234');
    await submit();
    expect(errors()).toEqual(['FORM.ISSUE.REQUIRED']);
    expect(host.submissions()).toEqual([]);

    await typeInto(fixture, 'PIN.CURRENT_PASSWORD', 'Secret-1234');
    await submit();
    expect(host.submissions()).toEqual([{ pin: '1234', password: 'Secret-1234' }]);
  });

  it('reports both local problems together', async () => {
    const { host, update, errors, submit } = await render();
    await update(() => host.askPassword.set(true));
    await submit();
    expect(errors()).toEqual(['FORM.ISSUE.PATTERN', 'FORM.ISSUE.REQUIRED']);
  });

  it('removes the PIN without asking for one and emits a null PIN', async () => {
    const { host, update, form, footer, submit } = await render();
    await update(() => host.mode.set('remove'));
    expect(form()!.querySelector('p')?.textContent).toBe('PIN.REMOVE_INTRO');
    expect(form()!.querySelectorAll('input').length).toBe(0);
    expect(footer()[1].textContent?.trim()).toBe('PIN.REMOVE');
    expect(footer()[1].getAttribute('data-variant')).toBe('danger');
    await submit();
    expect(host.submissions()).toEqual([{ pin: null, password: '' }]);
  });

  it('removes the PIN of the user asking for the current password', async () => {
    const { fixture, host, update, errors, submit } = await render();
    await update(() => {
      host.mode.set('remove');
      host.askPassword.set(true);
    });
    await submit();
    expect(errors()).toEqual(['FORM.ISSUE.REQUIRED']);
    expect(host.submissions()).toEqual([]);
    await typeInto(fixture, 'PIN.CURRENT_PASSWORD', 'Secret-1234');
    await submit();
    expect(host.submissions()).toEqual([{ pin: null, password: 'Secret-1234' }]);
  });

  it('shows the errors of the server on the PIN and on the password', async () => {
    const { host, update, errors } = await render();
    await update(() => {
      host.askPassword.set(true);
      host.pinError.set('PIN rifiutato');
      host.passwordError.set('Password errata');
    });
    expect(errors()).toEqual(['PIN rifiutato', 'Password errata']);
  });

  it('prefers the local message over the one of the server', async () => {
    const { host, update, errors, submit } = await render();
    await update(() => host.pinError.set('PIN rifiutato'));
    expect(errors()).toEqual(['PIN rifiutato']);
    await submit();
    expect(errors()).toEqual(['FORM.ISSUE.PATTERN']);
  });

  it('blocks cancel and shows progress while busy', async () => {
    const { host, update, footer } = await render();
    await update(() => host.busy.set(true));
    expect(footer()[0].disabled).toBe(true);
    expect(footer()[1].disabled).toBe(true);
    expect(footer()[1].getAttribute('aria-busy')).toBe('true');
  });

  it('closes from the cancel button', async () => {
    const { host, footer, fixture, dialog } = await render();
    footer()[0].click();
    await fixture.whenStable();
    expect(host.open()).toBe(false);
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('clears what was typed whenever it closes and starts clean when reopened', async () => {
    const { fixture, host, update, dialog, form, errors, submit } = await render();
    await update(() => host.askPassword.set(true));
    await typeInto(fixture, 'PIN.LABEL', '12');
    await typeInto(fixture, 'PIN.CURRENT_PASSWORD', 'Secret-1234');
    await submit();
    expect(errors()).toEqual(['FORM.ISSUE.PATTERN']);

    await update(() => host.open.set(false));
    expect(form()).toBeNull();
    await update(() => host.open.set(true));
    expect((findControl(fixture, 'PIN.LABEL') as HTMLInputElement).value).toBe('');
    expect((findControl(fixture, 'PIN.CURRENT_PASSWORD') as HTMLInputElement).value).toBe('');
    expect(errors()).toEqual([]);
    expect(dialog().hasAttribute('open')).toBe(true);
  });

  it('clears the values when the browser closes the dialog (Esc)', async () => {
    const { fixture, host, update, dialog } = await render();
    await typeInto(fixture, 'PIN.LABEL', '1234');
    dialog().dispatchEvent(new Event('close'));
    await fixture.whenStable();
    expect(host.open()).toBe(false);
    await update(() => host.open.set(true));
    expect((findControl(fixture, 'PIN.LABEL') as HTMLInputElement).value).toBe('');
  });

  it('closes with the close button of the header', async () => {
    const { fixture, host, root } = await render();
    root.querySelector<HTMLButtonElement>('header button')!.click();
    await fixture.whenStable();
    expect(host.open()).toBe(false);
  });
});
