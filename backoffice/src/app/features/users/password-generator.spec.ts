import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import {
  GENERATED_PASSWORD_LENGTH,
  generatePassword,
  PASSWORD_ALPHABET,
  PasswordGenerator,
} from './password-generator';

describe('generatePassword', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds a password of the requested length from the alphabet', () => {
    const password = generatePassword();
    expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH);
    expect([...password].every((c) => PASSWORD_ALPHABET.includes(c))).toBe(true);
    expect(generatePassword(30)).toHaveLength(30);
  });

  it('discards the bytes that would bias the choice', () => {
    const spy = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementationOnce((array) => {
        (array as Uint8Array).fill(255);
        return array;
      })
      .mockImplementationOnce((array) => {
        (array as Uint8Array).fill(1);
        return array;
      });
    expect(generatePassword(4)).toBe(PASSWORD_ALPHABET[1].repeat(4));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not repeat itself', () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe('PasswordGenerator', () => {
  function render() {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    const fixture = TestBed.createComponent(PasswordGenerator);
    const emitted: string[] = [];
    fixture.componentInstance.generated.subscribe((value) => emitted.push(value));
    const root = fixture.nativeElement as HTMLElement;
    const buttons = () => root.querySelectorAll<HTMLButtonElement>('button');
    return { fixture, root, emitted, buttons };
  }
  afterEach(() => vi.restoreAllMocks());

  it('shows the generated password once and emits it', async () => {
    const { fixture, root, emitted, buttons } = render();
    await fixture.whenStable();
    expect(root.querySelector('output')).toBeNull();
    buttons()[0].click();
    await fixture.whenStable();
    expect(emitted).toHaveLength(1);
    expect(root.querySelector('output')?.textContent).toBe(emitted[0]);
  });

  it('copies the password and reports it', async () => {
    const { fixture, buttons } = render();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const toast = vi.spyOn(TestBed.inject(ToastService), 'success');
    buttons()[0].click();
    await fixture.whenStable();
    buttons()[1].click();
    await fixture.whenStable();
    expect(writeText).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith('PASSWORD_GENERATOR.COPIED');
  });

  it('reports a clipboard failure without hiding it', async () => {
    const { fixture, buttons } = render();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const toast = vi.spyOn(TestBed.inject(ToastService), 'error');
    buttons()[0].click();
    await fixture.whenStable();
    buttons()[1].click();
    await fixture.whenStable();
    expect(warn).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith('PASSWORD_GENERATOR.COPY_FAILED');
  });
});
