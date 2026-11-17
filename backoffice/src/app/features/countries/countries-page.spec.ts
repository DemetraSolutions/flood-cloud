import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { Country } from '../../core/reference/countries';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CountriesPage } from './countries-page';

const LIST = `${API}/v1/countries`;
const COUNTRIES: Country[] = [
  {
    code: 'IT',
    name: 'Italia',
    areas: [
      { code: 'MI', name: 'Milano' },
      { code: 'RM', name: 'Roma' },
    ],
  },
  { code: 'CI', name: 'Côte d’Ivoire', areas: [] },
  { code: 'FR', name: 'Francia', areas: [] },
];
const CODE = 'COUNTRIES.FIELD.CODE';
const NAME = 'COUNTRIES.FIELD.NAME';

async function render() {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter(
        [
          { path: 'settings/countries', component: CountriesPage },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', permissions: ['countries:manage', 'profile:read'] });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/settings/countries');
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const flush = async (data: Country[] = COUNTRIES) => {
    backend()
      .expectOne(LIST)
      .flush({ data, page: { limit: 250, next: null } });
    await view();
  };
  const type = async (label: string, value: string) => {
    const field = findControl(scope, label);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await view();
  };
  const rows = () =>
    [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
    );
  const submit = async () => {
    root
      .querySelector('dialog[open] form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  return {
    root,
    view,
    flush,
    type,
    rows,
    submit,
    button,
    toasts,
    error: (label: string) => errorOf(scope, label),
    router: TestBed.inject(Router),
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CountriesPage', () => {
  it('reads the countries once and lists them by name with the number of provinces and a link to each', async () => {
    const { root, flush, rows } = await render();
    expect(root.querySelector('h1')?.textContent).toBe('COUNTRIES.TITLE');
    await flush();
    expect(rows()).toEqual([
      ['CI', 'Côte d’Ivoire', '0'],
      ['FR', 'Francia', '0'],
      ['IT', 'Italia', '2'],
    ]);
    expect(root.querySelector('tbody a')?.getAttribute('href')).toBe('/settings/countries/CI');
  });

  it('searches by code or name, without regard to case and accents', async () => {
    const { root, flush, type, rows } = await render();
    await flush();
    await type('COUNTRIES.SEARCH', 'cote');
    expect(rows().map((row) => row[0])).toEqual(['CI']);
    await type('COUNTRIES.SEARCH', 'fr');
    expect(rows().map((row) => row[0])).toEqual(['FR']);
    await type('COUNTRIES.SEARCH', 'zzz');
    expect(rows().map((row) => row[0])).not.toContain('IT');
    expect(root.textContent).toContain('COUNTRIES.EMPTY');
  });

  it('does not submit the search form', async () => {
    const { root, flush, view } = await render();
    await flush();
    const event = new Event('submit', { cancelable: true });
    root.querySelector('form[role=search]')!.dispatchEvent(event);
    await view();
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows the failure of the read and reads again on retry', async () => {
    const { root, view, button } = await render();
    backend().expectOne(LIST).flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')).not.toBeNull();
    button('COMMON.RETRY').click();
    await view();
    backend()
      .expectOne(LIST)
      .flush({ data: COUNTRIES, page: { limit: 250, next: null } });
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  describe('new country', () => {
    it('creates the country, reads the list again and opens the country', async () => {
      const { root, flush, button, type, submit, toasts, router, view } = await render();
      await flush();
      button('COUNTRIES.NEW').click();
      await view();
      expect(root.querySelector('dialog[open]')).not.toBeNull();
      await type(CODE, 'es');
      await type(NAME, 'Spagna');
      await submit();
      const request = backend().expectOne({ method: 'POST', url: LIST });
      expect(request.request.body).toEqual({ code: 'ES', name: 'Spagna' });
      request.flush(
        { data: { code: 'ES', name: 'Spagna', areas: [] } },
        { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } },
      );
      await view();
      backend()
        .expectOne(LIST)
        .flush({ data: [...COUNTRIES], page: { limit: 250, next: null } });
      await view();
      expect(toasts()).toEqual(['success: COUNTRIES.CREATED {"name":"Spagna"}']);
      expect(router.url).toBe('/settings/countries/ES');
    });

    it('keeps the dialog open with the error on the code when it is taken', async () => {
      const { root, flush, button, type, submit, error, view } = await render();
      await flush();
      button('COUNTRIES.NEW').click();
      await view();
      await type(CODE, 'IT');
      await type(NAME, 'Italia');
      await submit();
      backend()
        .expectOne({ method: 'POST', url: LIST })
        .flush(errorBody('CONFLICT', [{ field: 'code', issue: 'taken' }]), {
          status: 409,
          statusText: 'x',
        });
      await view();
      expect(root.querySelector('dialog[open]')).not.toBeNull();
      expect(error(CODE)).toBe('FORM.ISSUE.TAKEN');
    });

    it('closes the dialog and tells the failure when the server fails', async () => {
      const { root, flush, button, type, submit, view } = await render();
      await flush();
      button('COUNTRIES.NEW').click();
      await view();
      await type(CODE, 'ES');
      await type(NAME, 'Spagna');
      await submit();
      backend()
        .expectOne({ method: 'POST', url: LIST })
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
      expect(root.querySelector('dialog[open]')).toBeNull();
      expect(root.querySelector('.failure')?.textContent).toBe('ERRORS.API.INTERNAL_ERROR');
      button('COUNTRIES.NEW').click();
      await view();
      expect(root.querySelector('.failure')).toBeNull();
    });

    it('closes when the browser closes the dialog (Esc)', async () => {
      const { root, flush, button, view } = await render();
      await flush();
      button('COUNTRIES.NEW').click();
      await view();
      root.querySelector('dialog')!.dispatchEvent(new Event('close'));
      await view();
      expect(root.querySelector('dialog[open]')).toBeNull();
    });

    it('closes on cancel', async () => {
      const { root, flush, button, view } = await render();
      await flush();
      button('COUNTRIES.NEW').click();
      await view();
      button('COMMON.CANCEL').click();
      await view();
      expect(root.querySelector('dialog[open]')).toBeNull();
    });
  });
});
