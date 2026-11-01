import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { ConfirmDialog } from './confirm-dialog';

@Component({
  imports: [ConfirmDialog],
  template: `<fc-confirm-dialog
    heading="Elimina"
    message="Eliminare «Centro»?"
    [confirmLabel]="label()"
    [danger]="danger()"
    [busy]="busy()"
    [(open)]="open"
    (confirmed)="confirms.set(confirms() + 1)"
  />`,
})
class Host {
  readonly open = signal(false);
  readonly label = signal<string | null>(null);
  readonly danger = signal(true);
  readonly busy = signal(false);
  readonly confirms = signal(0);
}

async function render() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `[${key}]`);
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const footer = () => root.querySelectorAll<HTMLButtonElement>('footer button');
  return { fixture, host: fixture.componentInstance, root, footer };
}

describe('ConfirmDialog', () => {
  it('shows the message naming the object with cancel and confirm buttons', async () => {
    const { root, footer } = await render();
    expect(root.querySelector('h2')?.textContent).toBe('Elimina');
    expect(root.querySelector('.body p')?.textContent).toBe('Eliminare «Centro»?');
    expect(footer()[0].textContent?.trim()).toBe('[COMMON.CANCEL]');
    expect(footer()[1].textContent?.trim()).toBe('[COMMON.CONFIRM]');
    expect(footer()[1].getAttribute('data-variant')).toBe('danger');
  });

  it('emits confirmed without closing, and cancel closes', async () => {
    const { fixture, host, footer } = await render();
    host.open.set(true);
    await fixture.whenStable();
    footer()[1].click();
    expect(host.confirms()).toBe(1);
    expect(host.open()).toBe(true);
    footer()[0].click();
    await fixture.whenStable();
    expect(host.open()).toBe(false);
  });

  it('uses a custom label, the primary variant, and a busy state', async () => {
    const { fixture, host, footer } = await render();
    host.label.set('Elimina definitivamente');
    host.danger.set(false);
    host.busy.set(true);
    await fixture.whenStable();
    expect(footer()[1].textContent?.trim()).toBe('Elimina definitivamente');
    expect(footer()[1].getAttribute('data-variant')).toBe('primary');
    expect(footer()[1].getAttribute('aria-busy')).toBe('true');
    expect(footer()[0].disabled).toBe(true);
  });

  it('keeps the model in sync when the browser closes the dialog (Esc)', async () => {
    const { fixture, host, root } = await render();
    host.open.set(true);
    await fixture.whenStable();
    root.querySelector('dialog')!.dispatchEvent(new Event('close'));
    await fixture.whenStable();
    expect(host.open()).toBe(false);
  });
});
