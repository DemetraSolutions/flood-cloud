import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { ErrorState } from './error-state';

@Component({
  imports: [ErrorState],
  template: `<fc-error-state
    title="Errore"
    [message]="message()"
    [requestId]="requestId()"
    [retryable]="retryable()"
    (retry)="retries.set(retries() + 1)"
  />`,
})
class Host {
  readonly message = signal<string | null>('Qualcosa è andato storto');
  readonly requestId = signal<string | null>('req-1');
  readonly retryable = signal(true);
  readonly retries = signal(0);
}

describe('ErrorState', () => {
  async function render() {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
      key === 'ERRORS.REQUEST_ID' ? `Codice: ${params?.['requestId']}` : 'Riprova',
    );
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, host: fixture.componentInstance, root: fixture.nativeElement as HTMLElement };
  }

  it('is an alert with message, request id and a retry button', async () => {
    const { host, root } = await render();
    expect(root.querySelector('fc-error-state')?.getAttribute('role')).toBe('alert');
    expect(root.querySelector('.title')?.textContent).toBe('Errore');
    expect(root.querySelector('.message')?.textContent).toBe('Qualcosa è andato storto');
    expect(root.querySelector('.request-id')?.textContent).toBe('Codice: req-1');
    root.querySelector('button')!.click();
    expect(host.retries()).toBe(1);
  });

  it('omits message, request id and retry when not available', async () => {
    const { fixture, host, root } = await render();
    host.message.set(null);
    host.requestId.set(null);
    host.retryable.set(false);
    await fixture.whenStable();
    expect(root.querySelector('.message')).toBeNull();
    expect(root.querySelector('.request-id')).toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });
});
