import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { disabled, form } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { CredentialField } from './credential-field';
import { CredentialModel } from './place-model';

@Component({
  imports: [CredentialField],
  template: `<fc-credential-field [credential]="tree.secret" label="Chiave" [error]="error()" />`,
})
class Host {
  readonly model = signal<{ secret: CredentialModel }>({
    secret: { set: true, value: '', clear: false },
  });
  readonly off = signal(false);
  readonly error = signal<string | null>(null);
  readonly tree = form(this.model, (path) => {
    disabled(path.secret, { when: () => this.off() });
  });
}

async function render(set = true) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.model.set({ secret: { set, value: '', clear: false } });
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const host = fixture.componentInstance;
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  const press = async (text: string) => {
    (button(text) as HTMLButtonElement).click();
    await fixture.whenStable();
  };
  const state = () => root.querySelector('.credential-state')?.textContent?.trim();
  const input = () => root.querySelector<HTMLInputElement>('input');
  return { fixture, host, root, button, press, state, input };
}

describe('CredentialField', () => {
  it('shows that a credential is set and never its value', async () => {
    const { state, input, button, root } = await render();
    expect(state()).toBe('PLACES.CREDENTIAL.SET');
    expect(input()).toBeNull();
    expect(root.querySelector('[role=group]')?.getAttribute('aria-label')).toBe('Chiave');
    expect(button('PLACES.CREDENTIAL.CHANGE')).toBeDefined();
    expect(button('PLACES.CREDENTIAL.REMOVE')).toBeDefined();
  });

  it('shows that a credential is not set and offers only to set it', async () => {
    const { state, button } = await render(false);
    expect(state()).toBe('PLACES.CREDENTIAL.NOT_SET');
    expect(button('PLACES.CREDENTIAL.SET_NEW')).toBeDefined();
    expect(button('PLACES.CREDENTIAL.REMOVE')).toBeUndefined();
  });

  it('opens an empty password input and keeps what is typed in the model', async () => {
    const { press, input, host, fixture } = await render();
    await press('PLACES.CREDENTIAL.CHANGE');
    const field = input() as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    expect(field.autocomplete).toBe('new-password');
    expect(field.labels?.[0].textContent?.trim()).toBe(
      'PLACES.CREDENTIAL.NEW_VALUE {"label":"Chiave"}',
    );
    field.value = 'segreto';
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(host.model().secret).toEqual({ set: true, value: 'segreto', clear: false });
  });

  it('shows the error of the typed value while the input is open', async () => {
    const { press, root, host, fixture } = await render();
    host.error.set('Valore non corretto.');
    await press('PLACES.CREDENTIAL.CHANGE');
    await fixture.whenStable();
    expect(root.textContent).toContain('Valore non corretto.');
  });

  it('forgets what was typed when the change is cancelled', async () => {
    const { press, input, host, fixture, state } = await render();
    await press('PLACES.CREDENTIAL.CHANGE');
    const field = input() as HTMLInputElement;
    field.value = 'segreto';
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    await press('COMMON.CANCEL');
    expect(input()).toBeNull();
    expect(host.model().secret).toEqual({ set: true, value: '', clear: false });
    expect(state()).toBe('PLACES.CREDENTIAL.SET');
  });

  it('asks to remove the credential, drops what was typed and can take the request back', async () => {
    const { press, input, host, fixture, state, button } = await render();
    await press('PLACES.CREDENTIAL.CHANGE');
    (input() as HTMLInputElement).value = 'segreto';
    input()!.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    await press('COMMON.CANCEL');
    await press('PLACES.CREDENTIAL.REMOVE');
    expect(host.model().secret).toEqual({ set: true, value: '', clear: true });
    expect(state()).toBe('PLACES.CREDENTIAL.REMOVING');
    expect(button('PLACES.CREDENTIAL.CHANGE')).toBeUndefined();
    await press('PLACES.CREDENTIAL.KEEP');
    expect(host.model().secret.clear).toBe(false);
    expect(state()).toBe('PLACES.CREDENTIAL.SET');
  });

  it('has no buttons when the field is disabled', async () => {
    const { host, fixture, root } = await render();
    host.off.set(true);
    await fixture.whenStable();
    expect(root.querySelectorAll('button')).toHaveLength(0);
    expect(root.querySelector('.credential-state')?.textContent?.trim()).toBe(
      'PLACES.CREDENTIAL.SET',
    );
  });
});
