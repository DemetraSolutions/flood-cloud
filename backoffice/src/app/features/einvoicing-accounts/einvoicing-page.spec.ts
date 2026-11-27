import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { UNCONFIGURED } from '../../../testing/einvoicing';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { EInvoicingPage } from './einvoicing-page';

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('EInvoicingPage', () => {
  it('shows the title and the account of the platform', async () => {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    signIn({ role: 'PSA', permissions: ['eInvoicingAccounts:manage'] });
    const fixture = TestBed.createComponent(EInvoicingPage);
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await settle();
    fixture.detectChanges();
    backend()
      .expectOne(`${API}/v1/settings/integrations/aruba`)
      .flush({ data: UNCONFIGURED }, { headers: { ETag: '"v1"' } });
    await settle();
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent).toContain('EINVOICING.TITLE');
    expect(root.querySelector('fc-einvoicing-account-card')).not.toBeNull();
    expect(root.querySelector('[role=heading]')?.getAttribute('aria-level')).toBe('2');
  });
});
