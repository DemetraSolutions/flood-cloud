import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, pattern } from '@angular/forms/signals';
import { errorOf, findControl, typeInto } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactAccount } from './contact-account';

@Component({
  imports: [ContactAccount],
  template: `<fc-contact-account [form]="f" />`,
})
class Host {
  readonly model = signal({ email: 'anna@example.com', phone: '' });
  readonly f = form(this.model, (path) => pattern(path.phone, /^\d*$/));
}

async function render() {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, root: fixture.nativeElement as HTMLElement };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactAccount', () => {
  it('explains what the account is for and shows the e-mail and the phone', async () => {
    const { fixture, root } = await render();
    expect(root.querySelector('p.hint')?.textContent).toBe('CONTACTS.ACCOUNT.HINT');
    const email = findControl(fixture, 'CONTACTS.ACCOUNT.EMAIL');
    expect(email.value).toBe('anna@example.com');
    expect(email.getAttribute('type')).toBe('email');
    expect(findControl(fixture, 'CONTACTS.ACCOUNT.PHONE').getAttribute('type')).toBe('tel');
    expect(root.querySelector('input[type=password]')).toBeNull();
  });

  it('writes what the user types into the form', async () => {
    const { fixture, host } = await render();
    await typeInto(fixture, 'CONTACTS.ACCOUNT.EMAIL', 'b@example.com');
    await typeInto(fixture, 'CONTACTS.ACCOUNT.PHONE', '123');
    expect(host.model()).toEqual({ email: 'b@example.com', phone: '123' });
  });

  it('shows the error of a field only once the user touched it', async () => {
    const { fixture } = await render();
    await typeInto(fixture, 'CONTACTS.ACCOUNT.PHONE', 'abc');
    expect(errorOf(fixture, 'CONTACTS.ACCOUNT.PHONE')).toBe('');
    findControl(fixture, 'CONTACTS.ACCOUNT.PHONE').dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(errorOf(fixture, 'CONTACTS.ACCOUNT.PHONE')).not.toBe('');
    expect(errorOf(fixture, 'CONTACTS.ACCOUNT.EMAIL')).toBe('');
  });
});
