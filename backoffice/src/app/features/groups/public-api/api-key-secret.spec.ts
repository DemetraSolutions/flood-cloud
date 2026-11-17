import { TestBed } from '@angular/core/testing';
import { emulateNativeDialog } from '../../../../testing/dialog';
import { I18nService } from '../../../core/i18n/i18n.service';
import { ApiKeySecret } from './api-key-secret';

const SECRET = 'fc_pk_AbCdEfFAKEFAKEFAKEFAKEFAKEFAKEFAKE'; // gitleaks:allow (fake test value)

function render() {
  emulateNativeDialog();
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(ApiKeySecret);
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
  const instance = fixture.componentInstance;
  const view = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  const secretOf = () => (instance as unknown as { secret(): string | null }).secret();
  return { fixture, root, instance, view, button, secretOf };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ApiKeySecret', () => {
  it('shows nothing until a secret is given', async () => {
    const { root, view } = render();
    await view();
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    expect(root.textContent).not.toContain('fc_pk_');
  });

  it('shows the secret once, with the key name and the warning', async () => {
    const { root, instance, view } = render();
    instance.show('Webshop', SECRET);
    await view();
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('code')?.textContent).toBe(SECRET);
    expect(root.textContent).toContain('PUBLIC_API.SECRET.INTRO {"name":"Webshop"}');
    expect(root.querySelector('[role=note]')?.textContent).toContain('PUBLIC_API.SECRET.WARNING');
  });

  it('copies the secret and announces it in a live region', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { root, instance, view, button } = render();
    instance.show('Webshop', SECRET);
    await view();
    button('PUBLIC_API.SECRET.COPY').click();
    await view();
    expect(writeText).toHaveBeenCalledWith(SECRET);
    const status = root.querySelector('[role=status]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('PUBLIC_API.SECRET.COPIED');
    vi.unstubAllGlobals();
  });

  it('says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const { root, instance, view, button } = render();
    instance.show('Webshop', SECRET);
    await view();
    button('PUBLIC_API.SECRET.COPY').click();
    await view();
    expect(root.querySelector('[role=status]')?.textContent).toBe('PUBLIC_API.SECRET.COPY_FAILED');
    vi.unstubAllGlobals();
  });

  it('forgets the secret when the dialog is closed', async () => {
    const { root, instance, view, button, secretOf } = render();
    instance.show('Webshop', SECRET);
    await view();
    const box = root.querySelector<HTMLInputElement>('fc-checkbox input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await view();
    button('COMMON.CLOSE').click();
    await view();
    expect(secretOf()).toBeNull();
    expect(root.textContent).not.toContain(SECRET);
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('forgets the secret when the dialog closes with Esc', async () => {
    const { root, instance, view, secretOf } = render();
    instance.show('Webshop', SECRET);
    await view();
    root.querySelector('dialog')!.close();
    await view();
    expect(secretOf()).toBeNull();
  });

  it('forgets the secret when the component is destroyed', async () => {
    const { fixture, instance, view, secretOf } = render();
    instance.show('Webshop', SECRET);
    await view();
    expect(secretOf()).toBe(SECRET);
    fixture.destroy();
    expect(secretOf()).toBeNull();
  });

  it('starts with a clean announcement when a new secret is shown', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { root, instance, view, button } = render();
    instance.show('Webshop', SECRET);
    await view();
    button('PUBLIC_API.SECRET.COPY').click();
    await view();
    instance.show('Altra', SECRET);
    await view();
    expect(root.querySelector('[role=status]')?.textContent).toBe('');
    vi.unstubAllGlobals();
  });

  describe('accidental close', () => {
    it('keeps "Chiudi" disabled until the secret is copied or saved is ticked, and says so', async () => {
      const { root, instance, view, button } = render();
      instance.show('Webshop', SECRET);
      await view();
      expect(button('COMMON.CLOSE').disabled).toBe(true);
      const box = root.querySelector<HTMLInputElement>('fc-checkbox input')!;
      expect(root.querySelector(`label[for="${box.id}"]`)?.textContent).toContain(
        'PUBLIC_API.SECRET.SAVED_CHECK',
      );
      expect(box.getAttribute('aria-describedby')).not.toBeNull();
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(button('COMMON.CLOSE').disabled).toBe(false);
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(button('COMMON.CLOSE').disabled).toBe(true);
    });

    it('enables "Chiudi" after a successful copy only', async () => {
      vi.stubGlobal('navigator', {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      });
      const { instance, view, button } = render();
      instance.show('Webshop', SECRET);
      await view();
      button('PUBLIC_API.SECRET.COPY').click();
      await view();
      expect(button('COMMON.CLOSE').disabled).toBe(true);
      vi.stubGlobal('navigator', {
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
      button('PUBLIC_API.SECRET.COPY').click();
      await view();
      expect(button('COMMON.CLOSE').disabled).toBe(false);
      vi.unstubAllGlobals();
    });

    it('asks again for each new secret', async () => {
      const { root, instance, view, button } = render();
      instance.show('Webshop', SECRET);
      await view();
      const box = root.querySelector<HTMLInputElement>('fc-checkbox input')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      instance.show('Altra', SECRET);
      await view();
      expect(button('COMMON.CLOSE').disabled).toBe(true);
    });

    it('still clears the secret with Esc without any confirmation', async () => {
      const { root, instance, view, secretOf } = render();
      instance.show('Webshop', SECRET);
      await view();
      root.querySelector('dialog')!.close();
      await view();
      expect(secretOf()).toBeNull();
    });
  });

  describe('without a secret', () => {
    it('has a disabled copy button and copies nothing', async () => {
      const writeText = vi.fn();
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const { instance, view, button } = render();
      await view();
      expect(button('PUBLIC_API.SECRET.COPY').disabled).toBe(true);
      await (instance as unknown as { copy(): Promise<void> }).copy();
      expect(writeText).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});
