import { Provider, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Country } from '../../core/reference/countries';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CountryPage } from './country-page';

const ONE = `${API}/v1/countries/IT`;
const IT: Country = {
  code: 'IT',
  name: 'Italia',
  areas: [
    { code: 'RM', name: 'Roma' },
    { code: 'MI', name: 'Milano' },
  ],
};
const CODE = 'COUNTRIES.FIELD.CODE';
const NAME = 'COUNTRIES.FIELD.NAME';

async function render(extra: Provider[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'settings/countries/:countryCode', component: CountryPage },
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
  await harness.navigateByUrl('/settings/countries/IT');
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const load = async (country: Country = IT, etag = '"v1"') => {
    backend()
      .expectOne(ONE)
      .flush({ data: country }, { headers: { ETag: etag } });
    await view();
  };
  const type = async (label: string, value: string) => {
    const field = findControl(scope, label);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await view();
  };
  const submit = async () => {
    root
      .querySelector('dialog[open] form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  const click = async (text: string) => {
    button(text).click();
    await view();
  };
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const rows = () =>
    [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
    );
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  const fail = async (
    request: ReturnType<typeof backend.prototype.expectOne>,
    status: number,
    code: string,
    details?: { field: string; issue: string }[],
  ) => {
    request.flush(errorBody(code, details), { status, statusText: 'x' });
    await view();
  };
  return {
    root,
    view,
    load,
    type,
    submit,
    click,
    button,
    dialogButton,
    rows,
    toasts,
    fail,
    router: TestBed.inject(Router),
    error: (label: string) => errorOf(scope, label),
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CountryPage: reading', () => {
  it('shows the code, the name and the provinces sorted by name', async () => {
    const { root, load, rows } = await render();
    expect(root.textContent).toContain('COMMON.LOADING');
    await load();
    expect(root.querySelector('h1')?.textContent).toBe('Italia');
    expect(root.querySelector('dl')?.textContent).toContain('IT');
    expect(rows().map((row) => row.slice(0, 2))).toEqual([
      ['MI', 'Milano'],
      ['RM', 'Roma'],
    ]);
  });

  it('reports an unexpected failure to read generically', async () => {
    const { root, view } = await render([
      { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
    ]);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('shows an empty list of provinces', async () => {
    const { root, load } = await render();
    await load({ ...IT, areas: [] });
    expect(root.textContent).toContain('COUNTRIES.AREAS.EMPTY');
  });

  it('shows the failure of the read and a way back, and reads again on retry', async () => {
    const { root, view, button, fail, load } = await render();
    await fail(backend().expectOne(ONE), 404, 'NOT_FOUND');
    expect(root.querySelector('fc-error-state')).not.toBeNull();
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/settings/countries');
    button('COMMON.RETRY').click();
    await view();
    await load();
    expect(root.querySelector('h1')?.textContent).toBe('Italia');
  });
});

describe('CountryPage: the name', () => {
  it('changes the name with the version and keeps the new version for the next write', async () => {
    const { root, load, click, type, submit, toasts, view } = await render();
    await load();
    await click('COUNTRIES.RENAME');
    expect(root.querySelector('dialog[open]')?.textContent).toContain('COUNTRIES.RENAME_TITLE');
    expect((root.querySelector('dialog[open] input[disabled]') as HTMLInputElement).value).toBe(
      'IT',
    );
    await type(NAME, 'Italy');
    await submit();
    const request = backend().expectOne({ method: 'PATCH', url: ONE });
    expect(request.request.body).toEqual({ name: 'Italy' });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush({ data: { ...IT, name: 'Italy' } }, { headers: { ETag: '"v2"' } });
    await view();
    expect(toasts()).toEqual(['success: COUNTRIES.SAVED']);
    expect(root.querySelector('h1')?.textContent).toBe('Italy');
    expect(root.querySelector('dialog[open]')).toBeNull();
    await click('COUNTRIES.AREAS.NEW');
    await type(CODE, 'to');
    await type(NAME, 'Torino');
    await submit();
    const next = backend().expectOne({ method: 'POST', url: `${ONE}/areas` });
    expect(next.request.headers.get('If-Match')).toBe('"v2"');
    next.flush({ data: IT }, { headers: { ETag: '"v3"' } });
    await view();
  });

  it('asks to reload when the country changed meanwhile, then reads it again', async () => {
    const { root, load, click, type, submit, fail, view } = await render();
    await load();
    await click('COUNTRIES.RENAME');
    await type(NAME, 'Italy');
    await submit();
    await fail(backend().expectOne({ method: 'PATCH', url: ONE }), 412, 'PRECONDITION_FAILED');
    expect(root.querySelector('dialog[open]')).toBeNull();
    expect(root.querySelector('.notice')?.textContent).toContain('COUNTRIES.STALE');
    await click('COUNTRIES.RELOAD');
    expect(root.querySelector('.notice')).toBeNull();
    backend()
      .expectOne(ONE)
      .flush({ data: { ...IT, name: 'Italia 2' } }, { headers: { ETag: '"v9"' } });
    await view();
    expect(root.querySelector('h1')?.textContent).toBe('Italia 2');
  });

  it('closes the dialog and tells the failure when the server fails', async () => {
    const { root, load, click, type, submit, fail } = await render();
    await load();
    await click('COUNTRIES.RENAME');
    await type(NAME, 'Italy');
    await submit();
    await fail(backend().expectOne({ method: 'PATCH', url: ONE }), 500, 'INTERNAL_ERROR');
    expect(root.querySelector('dialog[open]')).toBeNull();
    expect(root.querySelector('.notice')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(root.querySelector('.notice button')).toBeNull();
  });

  it('shows the errors of the server on the field and keeps the dialog open', async () => {
    const { root, load, click, type, submit, fail, error } = await render();
    await load();
    await click('COUNTRIES.RENAME');
    await type(NAME, 'Italy');
    await submit();
    await fail(backend().expectOne({ method: 'PATCH', url: ONE }), 422, 'VALIDATION_ERROR', [
      { field: 'name', issue: 'pattern' },
    ]);
    expect(root.querySelector('dialog[open]')).not.toBeNull();
    expect(error(NAME)).toBe('FORM.ISSUE.PATTERN');
  });

  it('closes the dialog on cancel', async () => {
    const { root, load, click } = await render();
    await load();
    await click('COUNTRIES.RENAME');
    await click('COMMON.CANCEL');
    expect(root.querySelector('dialog[open]')).toBeNull();
  });
});

describe('CountryPage: the provinces', () => {
  it('adds a province', async () => {
    const { root, load, click, type, submit, toasts, view } = await render();
    await load();
    await click('COUNTRIES.AREAS.NEW');
    expect(root.querySelector('dialog[open]')?.textContent).toContain('COUNTRIES.AREAS.NEW_TITLE');
    await type(CODE, 'to');
    await type(NAME, 'Torino');
    await submit();
    const request = backend().expectOne({ method: 'POST', url: `${ONE}/areas` });
    expect(request.request.body).toEqual({ code: 'TO', name: 'Torino' });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush(
      { data: { ...IT, areas: [...IT.areas, { code: 'TO', name: 'Torino' }] } },
      { status: 201, statusText: 'Created', headers: { ETag: '"v2"' } },
    );
    await view();
    expect(toasts()).toEqual(['success: COUNTRIES.AREAS.CREATED']);
    expect(root.querySelectorAll('tbody tr').length).toBe(3);
  });

  it('maps a code that is taken onto the code field', async () => {
    const { root, load, click, type, submit, fail, error } = await render();
    await load();
    await click('COUNTRIES.AREAS.NEW');
    await type(CODE, 'MI');
    await type(NAME, 'Milano');
    await submit();
    await fail(backend().expectOne({ method: 'POST', url: `${ONE}/areas` }), 409, 'CONFLICT', [
      { field: 'code', issue: 'taken' },
    ]);
    expect(root.querySelector('dialog[open]')).not.toBeNull();
    expect(error(CODE)).toBe('FORM.ISSUE.TAKEN');
  });

  it('changes the name of a province, never its code', async () => {
    const { root, load, type, submit, view } = await render();
    await load();
    root
      .querySelector<HTMLButtonElement>('button[aria-label^="COUNTRIES.AREAS.RENAME_LABEL"]')!
      .click();
    await view();
    expect(root.querySelector('dialog[open]')?.textContent).toContain(
      'COUNTRIES.AREAS.RENAME_TITLE',
    );
    expect((root.querySelector('dialog[open] input[disabled]') as HTMLInputElement).value).toBe(
      'MI',
    );
    await type(NAME, 'Milano città');
    await submit();
    const request = backend().expectOne({ method: 'PATCH', url: `${ONE}/areas/MI` });
    expect(request.request.body).toEqual({ name: 'Milano città' });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush({ data: IT }, { headers: { ETag: '"v2"' } });
    await view();
    expect(root.querySelector('dialog[open]')).toBeNull();
  });

  it('deletes a province after confirmation', async () => {
    const { root, load, dialogButton, toasts, view } = await render();
    await load();
    root
      .querySelector<HTMLButtonElement>('button[aria-label^="COUNTRIES.AREAS.DELETE_LABEL"]')!
      .click();
    await view();
    expect(root.querySelector('dialog[open]')?.textContent).toContain(
      'COUNTRIES.AREAS.DELETE_CONFIRM {"name":"Milano"}',
    );
    dialogButton('COUNTRIES.DELETE_ACTION').click();
    await view();
    const request = backend().expectOne({ method: 'DELETE', url: `${ONE}/areas/MI` });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush({ data: { ...IT, areas: [IT.areas[0]] } }, { headers: { ETag: '"v2"' } });
    await view();
    expect(toasts()).toEqual(['success: COUNTRIES.AREAS.DELETED {"name":"Milano"}']);
    expect(root.querySelectorAll('tbody tr').length).toBe(1);
    expect(root.querySelector('dialog[open]')).toBeNull();
  });

  it('says how many companies and places use a province that cannot be deleted', async () => {
    const { root, load, dialogButton, fail, view } = await render();
    await load();
    root
      .querySelector<HTMLButtonElement>('button[aria-label^="COUNTRIES.AREAS.DELETE_LABEL"]')!
      .click();
    await view();
    dialogButton('COUNTRIES.DELETE_ACTION').click();
    await view();
    await fail(backend().expectOne({ method: 'DELETE', url: `${ONE}/areas/MI` }), 409, 'CONFLICT', [
      { field: 'companies.a', issue: 'inUse' },
      { field: 'places.b', issue: 'inUse' },
      { field: 'places.c', issue: 'inUse' },
    ]);
    const notice = root.querySelector('.notice')?.textContent as string;
    expect(notice).toContain('COUNTRIES.IN_USE.AREA');
    expect(notice).toContain('COUNTRIES.IN_USE.COMPANY {\\"count\\":1}');
    expect(notice).toContain('COUNTRIES.IN_USE.PLACES {\\"count\\":2}');
    expect(root.querySelectorAll('tbody tr').length).toBe(2);
    expect(root.querySelector('dialog[open]')).toBeNull();
  });
});

describe('CountryPage: deleting the country', () => {
  it('deletes the country after confirmation and goes back to the list', async () => {
    const { load, click, dialogButton, toasts, view, router } = await render();
    await load();
    await click('COUNTRIES.DELETE');
    dialogButton('COUNTRIES.DELETE_ACTION').click();
    await view();
    const request = backend().expectOne({ method: 'DELETE', url: ONE });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(toasts()).toEqual(['success: COUNTRIES.DELETED {"name":"Italia"}']);
    expect(router.url).toBe('/settings/countries');
  });

  it('asks nothing of the server when the confirmation is dismissed', async () => {
    const { root, load, click, dialogButton, view } = await render();
    await load();
    await click('COUNTRIES.DELETE');
    expect(root.querySelector('dialog[open]')?.textContent).toContain(
      'COUNTRIES.DELETE_CONFIRM {"name":"Italia"}',
    );
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(root.querySelector('dialog[open]')).toBeNull();
  });

  it('says that a country used by companies or places cannot be deleted', async () => {
    const { root, load, click, dialogButton, fail, view } = await render();
    await load();
    await click('COUNTRIES.DELETE');
    dialogButton('COUNTRIES.DELETE_ACTION').click();
    await view();
    await fail(backend().expectOne({ method: 'DELETE', url: ONE }), 409, 'CONFLICT', [
      { field: 'companies.a', issue: 'inUse' },
    ]);
    expect(root.querySelector('.notice')?.textContent).toContain('COUNTRIES.IN_USE.COUNTRY');
    expect(root.querySelector('h1')?.textContent).toBe('Italia');
  });

  it('shows a timeout of the usage check through the central mapping and keeps the page', async () => {
    const { root, load, click, dialogButton, fail, view } = await render();
    await load();
    await click('COUNTRIES.DELETE');
    dialogButton('COUNTRIES.DELETE_ACTION').click();
    await view();
    await fail(backend().expectOne({ method: 'DELETE', url: ONE }), 503, 'SERVICE_UNAVAILABLE');
    expect(root.querySelector('.notice')?.textContent).toContain('ERRORS.API.SERVICE_UNAVAILABLE');
    expect(root.querySelector('.notice button')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Italia');
    expect(root.querySelector('dialog[open]')).toBeNull();
  });

  it('asks to reload when the country changed meanwhile', async () => {
    const { root, load, click, dialogButton, fail, view } = await render();
    await load();
    await click('COUNTRIES.DELETE');
    dialogButton('COUNTRIES.DELETE_ACTION').click();
    await view();
    await fail(backend().expectOne({ method: 'DELETE', url: ONE }), 412, 'PRECONDITION_FAILED');
    expect(root.querySelector('.notice button')).not.toBeNull();
  });
});
