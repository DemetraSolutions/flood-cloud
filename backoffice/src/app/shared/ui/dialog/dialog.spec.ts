import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { Dialog } from './dialog';

/** jsdom does not implement the modal behaviour of `<dialog>`: emulate the observable parts. */
function emulateNativeDialog(): void {
  const proto = HTMLDialogElement.prototype;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

@Component({
  imports: [Dialog],
  template: `<button id="opener" type="button" (click)="open.set(true)">Apri</button>
    <fc-dialog heading="Titolo" [(open)]="open" (closed)="closes.set(closes() + 1)">
      <p>Contenuto</p>
      <button fcDialogActions type="button">Azione</button>
    </fc-dialog>`,
})
class Host {
  readonly open = signal(false);
  readonly closes = signal(0);
}

async function render() {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockReturnValue('Chiudi');
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, host: fixture.componentInstance, root, dialog: root.querySelector('dialog')! };
}

afterEach(() => vi.restoreAllMocks());

describe('Dialog', () => {
  it('is a named native dialog, closed at first', async () => {
    const { root, dialog } = await render();
    expect(dialog.open).toBe(false);
    const title = root.querySelector('h2')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(title.textContent).toBe('Titolo');
    expect(root.querySelector('.body p')?.textContent).toBe('Contenuto');
    expect(root.querySelector('footer button')?.textContent).toBe('Azione');
  });

  it('opens modally and returns the focus to the opener when closed with the button', async () => {
    const { fixture, host, root, dialog } = await render();
    const opener = root.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();
    host.open.set(true);
    await fixture.whenStable();
    expect(dialog.open).toBe(true);

    root.querySelector<HTMLButtonElement>('header button')!.click();
    await fixture.whenStable();
    expect(dialog.open).toBe(false);
    expect(host.open()).toBe(false);
    expect(host.closes()).toBe(1);
    expect(document.activeElement).toBe(opener);
  });

  it('syncs the model when the browser closes it (Esc) and copes with no opener', async () => {
    const { fixture, host, dialog } = await render();
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(null);
    host.open.set(true);
    await fixture.whenStable();
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));
    await fixture.whenStable();
    expect(host.open()).toBe(false);
    expect(host.closes()).toBe(1);
  });

  it('does not call showModal again when the dialog is already open', async () => {
    const { fixture, host, dialog } = await render();
    const show = vi.spyOn(dialog, 'showModal');
    dialog.setAttribute('open', '');
    host.open.set(true);
    await fixture.whenStable();
    expect(show).not.toHaveBeenCalled();
  });
});
