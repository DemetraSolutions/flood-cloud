import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { settle } from '../../../../testing/api';
import { AvatarEncoder, AvatarError } from '../../util/avatar-encoder';
import { AvatarField } from './avatar-field';

@Component({
  imports: [AvatarField],
  template: `<fc-avatar-field
    label="Avatar"
    initials="MR"
    [(value)]="value"
    [error]="error()"
    [hiddenImage]="hiddenImage()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly value = signal('');
  readonly error = signal<string | null>(null);
  readonly hiddenImage = signal(false);
  readonly disabled = signal(false);
}

const IMAGE = 'data:image/webp;base64,AAAA';

async function render() {
  const encode = vi.fn<(file: File) => Promise<string>>();
  TestBed.configureTestingModule({ providers: [{ provide: AvatarEncoder, useValue: { encode } }] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const pick = async (file: File | null) => {
    Object.defineProperty(picker, 'files', {
      configurable: true,
      value: { item: () => file },
    });
    picker.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  return { fixture, host: fixture.componentInstance, root, picker, buttons, pick, encode };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('AvatarField', () => {
  it('shows the legend, the initials and the choose button without a value', async () => {
    const { root, buttons } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('Avatar');
    expect(root.querySelector('fc-avatar')?.textContent?.trim()).toBe('MR');
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['AVATAR.CHOOSE']);
    expect(root.querySelector('.hint')?.textContent).toBe('AVATAR.HINT');
  });

  it('opens the file chooser from the button and accepts only the backend types', async () => {
    const { picker, buttons } = await render();
    const click = vi.spyOn(picker, 'click');
    buttons()[0].click();
    expect(click).toHaveBeenCalledOnce();
    expect(picker.accept).toBe('image/png,image/jpeg,image/webp');
  });

  it('sets the value to the encoded image and then offers change and remove', async () => {
    const { host, root, picker, buttons, pick, encode, fixture } = await render();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    encode.mockResolvedValue(IMAGE);
    await pick(file);
    await fixture.whenStable();
    expect(encode).toHaveBeenCalledWith(file);
    expect(host.value()).toBe(IMAGE);
    expect(picker.value).toBe('');
    expect(root.querySelector('fc-avatar img')?.getAttribute('src')).toBe(IMAGE);
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['AVATAR.CHANGE', 'AVATAR.REMOVE']);
    expect(root.querySelector('.error')?.textContent?.trim()).toBe('');
  });

  it('does nothing when no file was selected', async () => {
    const { host, pick, encode } = await render();
    await pick(null);
    expect(encode).not.toHaveBeenCalled();
    expect(host.value()).toBe('');
  });

  it.each([
    ['type', 'AVATAR.PROBLEM.TYPE'],
    ['file', 'AVATAR.PROBLEM.FILE'],
    ['read', 'AVATAR.PROBLEM.READ'],
    ['size', 'AVATAR.PROBLEM.SIZE'],
  ] as const)('shows the message of a "%s" problem and keeps the value', async (kind, key) => {
    const { fixture, host, root, pick, encode } = await render();
    host.value.set(IMAGE);
    encode.mockRejectedValue(new AvatarError(kind));
    await pick(new File(['x'], 'a.gif'));
    await fixture.whenStable();
    expect(root.querySelector('.error')?.textContent).toContain(key);
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toContain('-error');
    expect(host.value()).toBe(IMAGE);
  });

  it('logs an unexpected error and shows the generic message', async () => {
    const { fixture, root, pick, encode } = await render();
    const failure = new Error('boom');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    encode.mockRejectedValue(failure);
    await pick(new File(['x'], 'a.png'));
    await fixture.whenStable();
    expect(log).toHaveBeenCalledWith(failure);
    expect(root.querySelector('.error')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('shows a busy button while encoding and clears an old problem on a new pick', async () => {
    const { fixture, root, buttons, pick, encode } = await render();
    encode.mockRejectedValueOnce(new AvatarError('type'));
    await pick(new File(['x'], 'a.gif'));
    expect(root.querySelector('.error')?.textContent).toContain('AVATAR.PROBLEM.TYPE');

    let finish: (url: string) => void = () => undefined;
    encode.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await pick(new File(['x'], 'a.png'));
    expect(buttons()[0].disabled).toBe(true);
    expect(root.querySelector('.error')?.textContent?.trim()).toBe('');
    finish(IMAGE);
    await settle();
    await fixture.whenStable();
    expect(buttons()[0].disabled).toBe(false);
  });

  it('removes the image and clears the problem', async () => {
    const { fixture, host, root, buttons, pick, encode } = await render();
    host.value.set(IMAGE);
    await fixture.whenStable();
    encode.mockRejectedValue(new AvatarError('size'));
    await pick(new File(['x'], 'a.png'));
    await fixture.whenStable();
    expect(root.querySelector('.error')?.textContent).toContain('AVATAR.PROBLEM.SIZE');
    buttons()[1].click();
    await fixture.whenStable();
    expect(host.value()).toBe('');
    expect(root.querySelector('.error')?.textContent?.trim()).toBe('');
    expect(root.querySelector('fc-avatar img')).toBeNull();
  });

  it('shows the error of the server', async () => {
    const { fixture, host, root } = await render();
    host.error.set('Immagine non valida');
    await fixture.whenStable();
    expect(root.querySelector('.error')?.textContent).toContain('Immagine non valida');
  });

  it('warns about an image that cannot be shown, only while there is no value', async () => {
    const { fixture, host, root } = await render();
    expect(root.textContent).not.toContain('AVATAR.HIDDEN');
    host.hiddenImage.set(true);
    await fixture.whenStable();
    expect(root.textContent).toContain('AVATAR.HIDDEN');
    host.value.set(IMAGE);
    await fixture.whenStable();
    expect(root.textContent).not.toContain('AVATAR.HIDDEN');
  });

  it('disables the whole group', async () => {
    const { fixture, host, root } = await render();
    host.disabled.set(true);
    await fixture.whenStable();
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });

  it('focuses the choose button', async () => {
    const { fixture, buttons } = await render();
    const field = fixture.debugElement.children[0].componentInstance as AvatarField;
    field.focus();
    expect(document.activeElement).toBe(buttons()[0]);
  });
});
