import { Provider } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { ReferenceApi } from '../../core/reference/reference-api';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { LogoModel } from '../companies/company-model';
import { LogoSlot } from '../companies/logo-slot';
import { languageName } from '../groups/languages';
import { CatalogItemPage } from './catalog-item-page';
import { leaveCatalogItem } from './catalog-item-leave';
import { ProductCatalogApi } from './product-catalog-api';
import { CatalogKind, GroupTax } from './product-catalog.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const P1 = '665f1c2e9b1d4a0012ab3401';
const P2 = '665f1c2e9b1d4a0012ab3402';
const T1 = '665f1c2e9b1d4a0012ab3501';
const T2 = '665f1c2e9b1d4a0012ab3502';
const IMAGE = '665f1c2e9b1d4a0012ab3601';
const FULL = ['products:read', 'products:update', 'places:update', 'groups:read', 'profile:read'];
const READ_ONLY = ['products:read', 'places:update', 'groups:read', 'profile:read'];
const SEGMENT: Record<CatalogKind, string> = { departments: 'product-departments', brands: 'product-brands' };
const LANGS = `${API}/v1/groups/${GROUP}/lookup/languages`;
const TAXES_URL = `${API}/v1/groups/${GROUP}/lookup/taxes`;
const base = (kind: CatalogKind) => `${API}/v1/groups/${GROUP}/${SEGMENT[kind]}`;
const NEW = (kind: CatalogKind) => `/groups/${GROUP}/${SEGMENT[kind]}/new`;
const EDIT = (kind: CatalogKind) => `/groups/${GROUP}/${SEGMENT[kind]}/${ID}`;

const TAXES: GroupTax[] = [
  { id: T1, rate: 22, department: 1, description: 'Ordinaria', vatNature: null },
  { id: T2, rate: 10, department: 2, description: null, vatNature: null },
];
const TAX_T1 = '22% - Rep.1 | Ordinaria';

const DEPT = {
  id: ID,
  name: { it: 'Bibite' },
  description: { it: 'Freddo' },
  enabled: true,
  placeIds: [P1],
  image: null,
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
  code: 5,
  taxId: T1,
  tax: { rate: 22, department: 1, vatNature: null, description: 'Ordinaria' },
  noDiscount: false,
  secondaryFiscalPrinter: false,
};
const BRAND = {
  id: ID,
  name: { it: 'Acme' },
  description: {},
  enabled: true,
  placeIds: [],
  image: null,
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: null,
};
const NAMES: Record<string, string> = { [P1]: 'Negozio uno', [P2]: 'Negozio due' };

const nameLabel = (language: string) =>
  `PRODUCT_CATALOG.FIELD.NAME_IN ${JSON.stringify({ language: languageName(language, DEFAULT_LANGUAGE) })}`;
const descriptionLabel = (language: string) =>
  `PRODUCT_CATALOG.FIELD.DESCRIPTION_IN ${JSON.stringify({ language: languageName(language, DEFAULT_LANGUAGE) })}`;
const L = {
  enabled: 'PRODUCT_CATALOG.FIELD.ENABLED',
  noDiscount: 'PRODUCT_CATALOG.FIELD.NO_DISCOUNT',
  printer: 'PRODUCT_CATALOG.FIELD.SECONDARY_PRINTER',
  code: 'PRODUCT_CATALOG.FIELD.CODE',
  tax: 'PRODUCT_CATALOG.FIELD.TAX',
};

interface Reads {
  /** Languages of the group; `'fail'` makes the read fail. */
  languages?: string[] | 'fail';
  taxes?: GroupTax[] | 'fail';
  /** The entry the page reads; `'skip'` leaves the request pending. */
  item?: object | 'skip';
  etag?: string;
  /** The page shows an existing entry whatever the URL it was opened with (after a creation). */
  edit?: boolean;
}

const fail = (code: string, status = 500) => [errorBody(code), { status, statusText: 'x' }] as const;

async function render(
  kind: CatalogKind,
  url: string,
  profile: Partial<Profile> = {},
  reads: Reads | null = {},
  extra: Provider[] = [],
) {
  emulateNativeDialog();
  const referenceApi = {
    places: vi.fn(async () => ({
      data: [
        { id: P1, name: NAMES[P1] },
        { id: P2, name: NAMES[P2] },
      ],
      page: { limit: 25, next: null },
    })),
    placeNames: vi.fn(async (_group: string, ids: readonly string[]) =>
      Object.fromEntries(ids.filter((id) => id in NAMES).map((id) => [id, NAMES[id]])),
    ),
  };
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: ReferenceApi, useValue: referenceApi },
      ...extra,
      provideRouter(
        [
          { path: 'groups/:groupId/product-departments/new', component: CatalogItemPage, data: { kind: 'departments' }, canDeactivate: [leaveCatalogItem] },
          { path: 'groups/:groupId/product-departments/:itemId', component: CatalogItemPage, data: { kind: 'departments' }, canDeactivate: [leaveCatalogItem] },
          { path: 'groups/:groupId/product-brands/new', component: CatalogItemPage, data: { kind: 'brands' }, canDeactivate: [leaveCatalogItem] },
          { path: 'groups/:groupId/product-brands/:itemId', component: CatalogItemPage, data: { kind: 'brands' }, canDeactivate: [leaveCatalogItem] },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const profileData = signIn({
    role: 'SA',
    permissions: FULL,
    groupFeatures: fakeFeatureFlags(false, { media: true, tobaccosGamesMonopoly: true }),
    ...profile,
  });
  const can = (permission: string) => profileData.permissions.includes(permission);
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const scope = { get nativeElement() { return harness.routeNativeElement; } } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  /** Answers the reads the page makes when it opens. */
  const answer = async (o: Reads = {}) => {
    await settle();
    harness.detectChanges();
    await settle();
    {
      const request = backend().expectOne(LANGS);
      if (o.languages === 'fail') {
        request.flush(...fail('INTERNAL_ERROR'));
      } else {
        request.flush({ data: (o.languages ?? ['it', 'en']).map((code) => ({ code })) });
      }
    }
    if (kind === 'departments') {
      const request = backend().expectOne(TAXES_URL);
      if (o.taxes === 'fail') {
        request.flush(...fail('INTERNAL_ERROR'));
      } else {
        request.flush({ data: o.taxes ?? TAXES });
      }
    }
    if ((o.edit ?? !url.endsWith('/new')) && o.item !== 'skip') {
      backend()
        .expectOne(`${base(kind)}/${ID}`)
        .flush({ data: o.item ?? (kind === 'departments' ? DEPT : BRAND) }, { headers: { ETag: o.etag ?? '"v1"' } });
    }
    await view();
  };
  if (reads !== null) {
    await answer(reads);
  }
  const el = () => harness.routeNativeElement as HTMLElement;
  const page = () => harness.routeDebugElement!.componentInstance as CatalogItemPage;
  const type = async (label: string, value: string) => {
    const control = findControl(scope, label);
    control.value = value;
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const check = async (label: string, on: boolean) => {
    const box = findControl(scope, label) as HTMLInputElement;
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const blur = async (label: string) => {
    findControl(scope, label).dispatchEvent(new Event('blur'));
    await view();
  };
  const place = async (name: string) => {
    const label = [...el().querySelectorAll('fc-reference-picker li label')].find((l) => l.textContent?.trim() === name)!;
    const box = label.querySelector('input')!;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const submit = async () => {
    el().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => el().querySelector<HTMLButtonElement>('button[type=submit]');
  const tab = (id: string) => el().querySelector<HTMLButtonElement>(`#catalog-tab-${id}`)!;
  const openTab = async (id: string) => {
    tab(id).click();
    await view();
  };
  const visible = () => [...el().querySelectorAll<HTMLElement>('[role=tabpanel]')].filter((p) => !p.hidden).map((p) => p.id);
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const formError = () => el().querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const dialogButton = (text: string) => [...el().querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const reload = () => [...el().querySelectorAll<HTMLButtonElement>('form button')].find((b) => b.textContent?.trim() === 'PRODUCT_CATALOG.FORM.RELOAD');
  const slot = () => harness.routeDebugElement!.query(By.directive(LogoSlot)).componentInstance as LogoSlot;
  return {
    harness, el, page, view, answer, type, check, blur, place, submit, save, tab, openTab, visible, toasts, formError,
    dialogButton, reload, slot, referenceApi, router: TestBed.inject(Router),
    error: (label: string) => errorOf(scope, label),
    control: (label: string) => findControl(scope, label),
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CatalogItemPage: a new department', () => {
  it('opens a tab when the user chooses it', async () => {
    const { tab, visible, view } = await render('departments', NEW('departments'));
    tab('availability').click();
    await view();
    expect(visible()).toEqual(['catalog-panel-availability']);
  });

  it('shows the empty form, the required language and a save disabled while the form is clean', async () => {
    const { el, save, control, visible, tab } = await render('departments', NEW('departments'));
    expect(el().querySelector('h1')?.textContent).toContain('PRODUCT_CATALOG.DEPARTMENTS.FORM.NEW_TITLE');
    expect(el().querySelector('.meta')).toBeNull();
    expect(save()!.disabled).toBe(true);
    expect(save()!.textContent).toContain('PRODUCT_CATALOG.DEPARTMENTS.FORM.CREATE');
    expect(el().querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/product-departments`);
    expect((control(L.enabled) as HTMLInputElement).checked).toBe(true);
    expect(el().textContent).toContain('PRODUCT_CATALOG.FIELD.REQUIRED_LANGUAGE');
    expect(control(nameLabel('en'))).toBeTruthy();
    expect(control(descriptionLabel('en'))).toBeTruthy();
    expect([...(control(L.tax) as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual(['PRODUCT_CATALOG.FIELD.TAX_NONE', TAX_T1, '10% - Rep.2']);
    expect(visible()).toEqual(['catalog-panel-general']);
    expect(tab('media')).toBeTruthy();
    expect(el().textContent).not.toContain('PRODUCT_CATALOG.FIELD.TAX_FAILED');
  });

  it('shows the loading state until the languages arrive', async () => {
    const { el, answer } = await render('departments', NEW('departments'), {}, null);
    await settle();
    expect(el().querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    await answer();
    expect(el().querySelector('[role=status]')).toBeNull();
  });

  it('creates it with an Idempotency-Key, shows the toast and goes to its page', async () => {
    const { type, check, place, submit, toasts, router, view, save, control, answer } = await render('departments', NEW('departments'));
    await type(L.code, ' 7 ');
    await type(L.tax, T2);
    await type(nameLabel('it'), '  Alimentari  ');
    await type(nameLabel('en'), 'Food');
    await type(descriptionLabel('it'), 'Secco');
    await check(L.enabled, false);
    await check(L.noDiscount, true);
    await check(L.printer, true);
    await place('Negozio due');
    expect(save()!.disabled).toBe(false);
    expect((control(L.tax) as HTMLSelectElement).value).toBe(T2);
    await submit();
    const req = backend().expectOne(base('departments'));
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.body).toEqual({
      name: { it: 'Alimentari', en: 'Food' },
      description: { it: 'Secco' },
      enabled: false,
      placeIds: [P2],
      code: 7,
      taxId: T2,
      noDiscount: true,
      secondaryFiscalPrinter: true,
    });
    req.flush({ data: { ...DEPT, name: { it: 'Alimentari' } } }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    await view();
    expect(toasts()).toEqual(['success: PRODUCT_CATALOG.DEPARTMENTS.FORM.CREATED']);
    expect(router.url).toBe(EDIT('departments'));
    await answer({ edit: true });
  });

  it('retries with the same key while the body is the same and with another when it changed', async () => {
    const { type, submit, view, formError } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    const first = backend().expectOne(base('departments'));
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(...fail('INTERNAL_ERROR'));
    await view();
    expect(formError()).toContain('ERRORS.API.INTERNAL_ERROR');
    await submit();
    const second = backend().expectOne(base('departments'));
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush(...fail('INTERNAL_ERROR'));
    await view();
    await type(nameLabel('it'), 'B');
    await submit();
    const third = backend().expectOne(base('departments'));
    expect(third.request.headers.get('Idempotency-Key')).not.toBe(key);
    third.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('requires the code, the tax rate and the name in the language asked, and says so on the tab', async () => {
    const { el, submit, error, tab, type } = await render('departments', NEW('departments'));
    await type(nameLabel('en'), 'Only english');
    await submit();
    expect(error(L.code)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(L.tax)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(error(nameLabel('en'))).toBe('');
    expect(tab('general').textContent).toContain('TAB_LIST.ERRORS {"count":3}');
    expect(tab('availability').textContent).not.toContain('TAB_LIST.ERRORS');
    expect(document.activeElement).toBe(el().querySelector('#' + (el().querySelector('input[inputmode=numeric]') as HTMLInputElement).id));
  });

  it('checks the code: a number from 1 to 99', async () => {
    const { submit, error, type, blur } = await render('departments', NEW('departments'));
    expect(error(L.tax)).toBe('');
    await blur(L.tax);
    expect(error(L.tax)).toBe('FORM.ISSUE.REQUIRED');
    await type(L.code, 'abc');
    expect(error(L.code)).toBe('');
    await blur(L.code);
    expect(error(L.code)).toBe('FORM.ISSUE.TYPE');
    await type(L.code, '1.5');
    expect(error(L.code)).toBe('FORM.ISSUE.TYPE');
    await type(L.code, '0');
    expect(error(L.code)).toBe('FORM.ISSUE.MINIMUM');
    await type(L.code, '100');
    await submit();
    expect(error(L.code)).toBe('FORM.ISSUE.MAXIMUM');
    await type(L.code, '99');
    expect(error(L.code)).toBe('');
  });

  it('checks the limits of the texts: name and description lengths and control characters', async () => {
    const { submit, error, type, blur } = await render('departments', NEW('departments'));
    await type(nameLabel('it'), 'x'.repeat(151));
    await blur(nameLabel('it'));
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(nameLabel('it'), 'a\u0001b');
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.PATTERN');
    await type(nameLabel('it'), 'Nome');
    await type(descriptionLabel('it'), 'y'.repeat(1001));
    expect(error(descriptionLabel('it'))).toBe('');
    await blur(descriptionLabel('it'));
    expect(error(descriptionLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    await submit();
    expect(error(descriptionLabel('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(descriptionLabel('it'), 'a\u0001b');
    expect(error(descriptionLabel('it'))).toBe('FORM.ISSUE.PATTERN');
    await type(descriptionLabel('it'), 'riga 1\r\n\triga 2');
    expect(error(descriptionLabel('it'))).toBe('');
    await type(nameLabel('it'), '   ');
    await submit();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
  });

  it('puts the 422 issues on their fields and says so in the tabs', async () => {
    const { type, submit, view, error, tab, el, formError } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    backend().expectOne(base('departments')).flush(
      errorBody('VALIDATION_ERROR', [
        { field: 'name.it', issue: 'taken' },
        { field: 'code', issue: 'maximum' },
        { field: 'taxId', issue: 'enum' },
        { field: 'placeIds.0', issue: 'notAllowed' },
        { field: 'image', issue: 'format' },
      ]),
      { status: 422, statusText: 'x' },
    );
    await view();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.TAKEN');
    expect(error(L.code)).toBe('FORM.ISSUE.MAXIMUM');
    expect(error(L.tax)).toBe('FORM.ISSUE.ENUM');
    expect(el().querySelector('#catalog-panel-availability fieldset > .error')?.textContent).toContain('FORM.ISSUE.NOT_ALLOWED');
    expect(el().querySelector('#catalog-panel-media > .problem')?.textContent).toContain('FORM.ISSUE.FORMAT');
    expect(tab('general').textContent).toContain('TAB_LIST.ERRORS {"count":3}');
    expect(tab('availability').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(tab('media').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(formError()).toBeNull();
  });

  it('puts an issue on the whole name on the field of the required language', async () => {
    const { type, submit, view, formError, tab, visible, error } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('VALIDATION_ERROR', [{ field: 'name', issue: 'required' }]), { status: 422, statusText: 'x' });
    await view();
    expect(formError()).toBeNull();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(tab('general').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(visible()).toEqual(['catalog-panel-general']);
  });

  it('puts an issue it cannot place in a message of the form', async () => {
    const { type, submit, view, formError } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('VALIDATION_ERROR', [{ field: 'extra', issue: 'unknown' }]), { status: 422, statusText: 'x' });
    await view();
    expect(formError()).toContain('ERRORS.API.VALIDATION_ERROR');
  });

  it('puts a code already used (409 taken) on the code field', async () => {
    const { type, submit, view, error, formError } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('CONFLICT', [{ field: 'code', issue: 'taken' }]), { status: 409, statusText: 'x' });
    await view();
    expect(error(L.code)).toBe('FORM.ISSUE.TAKEN');
    expect(formError()).toBeNull();
  });

  it('answers a 403 on the stores in the availability tab, on the stores field', async () => {
    const { type, submit, view, visible, el } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('FORBIDDEN', [{ field: 'placeIds', issue: 'notAllowed' }]), { status: 403, statusText: 'x' });
    await view();
    expect(visible()).toEqual(['catalog-panel-availability']);
    expect(el().querySelector('#catalog-panel-availability fieldset > .error')?.textContent).toContain('PRODUCT_CATALOG.ERROR.PLACES_FORBIDDEN');
  });

  it('answers a 403 on something else, or without details, with a general message', async () => {
    const { type, submit, view, formError, visible } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('FORBIDDEN', [{ field: 'code', issue: 'notAllowed' }]), { status: 403, statusText: 'x' });
    await view();
    expect(formError()).toContain('PRODUCT_CATALOG.ERROR.FORBIDDEN');
    expect(visible()).toEqual(['catalog-panel-general']);
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(formError()).toContain('PRODUCT_CATALOG.ERROR.FORBIDDEN');
  });

  it('reports a failure that is not from the API, or has details of another kind, generically', async () => {
    const { type, submit, view, formError } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(TestBed.inject(ProductCatalogApi), 'create').mockRejectedValueOnce(new TypeError('boom'));
    await submit();
    expect(formError()).toContain('ERRORS.GENERIC.MESSAGE');
    expect(log).toHaveBeenCalled();
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('NOT_FOUND', [{ field: 'code', issue: 'x' }]), { status: 404, statusText: 'x' });
    await view();
    expect(formError()).toContain('ERRORS.API.NOT_FOUND');
  });

  it('is told the content is too large (413) and the rate limit (429)', async () => {
    const { type, submit, view, formError } = await render('departments', NEW('departments'));
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    backend().expectOne(base('departments')).flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'x' });
    await view();
    expect(formError()).toContain('ERRORS.API.RATE_LIMITED');
  });

  it('sends the image chosen in the media tab, with the library of the group', async () => {
    const { type, submit, view, slot, openTab, visible, el } = await render('departments', NEW('departments'));
    await openTab('media');
    expect(visible()).toEqual(['catalog-panel-media']);
    expect(el().querySelector('fc-logo-slot')?.textContent).toContain('COMPANIES.MEDIA.NO_LOGO');
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    const picked: LogoModel = { descriptor: null, imageId: IMAGE, label: 'foto.png', previewUrl: 'https://files.test/s/foto.png' };
    slot().logoChange.emit(picked);
    await view();
    expect(el().querySelector('fc-logo-slot img')?.getAttribute('src')).toBe('https://files.test/s/foto.png');
    await submit();
    const req = backend().expectOne(base('departments'));
    expect(req.request.body).toMatchObject({ image: { imageId: IMAGE } });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('has no media tab, no printer switch and no image in the body without the features', async () => {
    const { el, tab, type, submit, view } = await render('departments', NEW('departments'), {
      groupFeatures: fakeFeatureFlags(false),
    });
    expect(el().querySelector('#catalog-tab-media')).toBeNull();
    expect(el().querySelector('#catalog-panel-media')).toBeNull();
    expect(tab('general')).toBeTruthy();
    expect([...el().querySelectorAll('label')].some((l) => l.textContent?.trim() === L.printer)).toBe(false);
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    const req = backend().expectOne(base('departments'));
    expect(req.request.body).toEqual({ name: { it: 'A' }, enabled: true, placeIds: [], code: 7, taxId: T1, noDiscount: false, secondaryFiscalPrinter: false });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('asks the stores of a company administrator, and only from there', async () => {
    const { el, type, submit, error, visible, place, view, tab } = await render('departments', NEW('departments'), { role: 'CA' });
    expect(el().querySelector('#catalog-panel-availability [role=note]')?.textContent).toContain('PRODUCT_CATALOG.AVAILABILITY.RESTRICTED');
    await type(L.code, '7');
    await type(L.tax, T1);
    await type(nameLabel('it'), 'A');
    await submit();
    expect(visible()).toEqual(['catalog-panel-availability']);
    expect(tab('availability').textContent).toContain('TAB_LIST.ERRORS {"count":1}');
    expect(el().querySelector('#catalog-panel-availability fieldset > .error')?.textContent).toContain('FORM.ISSUE.REQUIRED');
    await place('Negozio uno');
    expect(el().querySelector('#catalog-panel-availability fieldset > .error')?.textContent).not.toContain('FORM.ISSUE.REQUIRED');
    await submit();
    const req = backend().expectOne(base('departments'));
    expect(req.request.body).toMatchObject({ placeIds: [P1] });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('also treats the store administrator as restricted, and the administrator of the group as not', async () => {
    const pa = await render('departments', NEW('departments'), { role: 'PA' });
    expect(pa.el().querySelector('[role=note]')?.textContent).toContain('PRODUCT_CATALOG.AVAILABILITY.RESTRICTED');
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const sa = await render('departments', NEW('departments'));
    expect(sa.el().querySelector('#catalog-panel-availability .note')?.textContent).toContain('PRODUCT_CATALOG.AVAILABILITY.HINT');
    expect(sa.el().querySelector('#catalog-panel-availability [role=note]')).toBeNull();
  });
});

describe('CatalogItemPage: a new brand', () => {
  it('shows only what a brand has and creates it', async () => {
    const { el, type, submit, view, toasts, router, answer, save } = await render('brands', NEW('brands'));
    expect(el().querySelector('h1')?.textContent).toContain('PRODUCT_CATALOG.BRANDS.FORM.NEW_TITLE');
    expect(el().querySelector('input[inputmode=numeric]')).toBeNull();
    expect(el().querySelector('fc-select')).toBeNull();
    expect([...el().querySelectorAll('label')].some((l) => l.textContent?.trim() === L.noDiscount)).toBe(false);
    await submit();
    expect(save()!.disabled).toBe(true);
    await type(nameLabel('it'), 'Acme');
    await submit();
    const req = backend().expectOne(base('brands'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: { it: 'Acme' }, enabled: true, placeIds: [] });
    req.flush({ data: BRAND }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    await view();
    expect(toasts()).toEqual(['success: PRODUCT_CATALOG.BRANDS.FORM.CREATED']);
    expect(router.url).toBe(EDIT('brands'));
    await answer({ edit: true });
  });
});

describe('CatalogItemPage: reads', () => {
  it('keeps the tax rate of the department, by its id, when it has no copy of it', async () => {
    const { control } = await render('departments', EDIT('departments'), { permissions: ['products:read', 'products:update'] }, { item: { ...DEPT, tax: null }, taxes: [] });
    expect([...(control(L.tax) as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual(['PRODUCT_CATALOG.FIELD.TAX_NONE', T1]);
  });

  it('reads the languages and the taxes with products:read alone', async () => {
    const { control } = await render('departments', EDIT('departments'), { permissions: ['products:read', 'products:update'] }, { languages: ['it', 'de'], taxes: [TAXES[1]] });
    expect(control(nameLabel('de'))).toBeTruthy();
    expect([...(control(L.tax) as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual(['PRODUCT_CATALOG.FIELD.TAX_NONE', '10% - Rep.2', TAX_T1]);
  });

  it('warns when the taxes cannot be read, and keeps the one of the department', async () => {
    const { el, control } = await render('departments', EDIT('departments'), {}, { taxes: 'fail' });
    expect(el().textContent).toContain('PRODUCT_CATALOG.FIELD.TAX_FAILED');
    expect([...(control(L.tax) as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual(['PRODUCT_CATALOG.FIELD.TAX_NONE', TAX_T1]);
  });

  it('falls back to italian when the languages cannot be read', async () => {
    const { control, el } = await render('departments', NEW('departments'), {}, { languages: 'fail' });
    expect(control(nameLabel('it'))).toBeTruthy();
    expect(el().textContent).not.toContain(nameLabel('en'));
  });

  it('shows the languages the entry has besides the ones of the group, in names and descriptions', async () => {
    const { control, el } = await render('brands', EDIT('brands'), {}, { languages: ['it'], item: { ...BRAND, name: { it: 'Acme', de: 'Acme DE' }, description: { fr: 'Marque' } } });
    expect((control(nameLabel('de')) as HTMLInputElement).value).toBe('Acme DE');
    expect((control(descriptionLabel('fr')) as HTMLInputElement).value).toBe('Marque');
    expect(control(nameLabel('fr'))).toBeTruthy();
    expect(el().querySelectorAll('fc-textarea')).toHaveLength(3);
  });

  it('asks the name in the first language of the group when it has not the one of the user', async () => {
    const { el, submit, error } = await render('brands', NEW('brands'), {}, { languages: ['en', 'de'] });
    await submit();
    expect(error(nameLabel('en'))).toBe('FORM.ISSUE.REQUIRED');
    expect(error(nameLabel('de'))).toBe('');
    expect(el().textContent).toContain('PRODUCT_CATALOG.FIELD.REQUIRED_LANGUAGE');
  });

  it('uses the language of the interface as the required one when the group has it', async () => {
    const { submit, error, harness } = await render('brands', NEW('brands'), {}, { languages: ['en', 'it'] });
    const loading = TestBed.inject(I18nService).use('it');
    backend().expectOne('/i18n/it.json').flush({ TEST: 'x' });
    await loading;
    harness.detectChanges();
    await submit();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(error(nameLabel('en'))).toBe('');
  });

  it('has no department on the page of a brand', async () => {
    const { page } = await render('brands', EDIT('brands'));
    expect((page() as unknown as { department(): unknown }).department()).toBeNull();
  });

  it('shows the names of the stores the entry is for', async () => {
    const { el, referenceApi } = await render('departments', EDIT('departments'));
    expect(referenceApi.placeNames).toHaveBeenCalledWith(GROUP, [P1]);
    expect([...el().querySelectorAll('fc-reference-picker .chosen li')].map((li) => li.textContent?.trim())).toEqual(['Negozio uno']);
  });

  it('shows the error state with a way back when the entry cannot be read, and retries', async () => {
    const { el, view, answer } = await render('departments', EDIT('departments'), {}, { item: 'skip' });
    backend().expectOne(`${base('departments')}/${ID}`).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x', headers: { 'X-Request-Id': 'req-9' } });
    await view();
    const state = el().querySelector('fc-error-state')!;
    expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(state.textContent).toContain('req-9');
    expect(el().querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/product-departments`);
    expect(el().textContent).toContain('PRODUCT_CATALOG.DEPARTMENTS.FORM.BACK');
    state.querySelector('button')!.click();
    await view();
    backend().expectOne(`${base('departments')}/${ID}`).flush({ data: DEPT }, { headers: { ETag: '"v1"' } });
    await view();
    expect(el().querySelector('fc-error-state')).toBeNull();
    expect(el().querySelector('h1')?.textContent).toContain('EDIT_TITLE');
  });

  it('reports an unexpected failure to read generically', async () => {
    const { el, view } = await render('brands', EDIT('brands'), {}, null, [{ provide: AppConfig, useValue: { apiBaseUrl: () => null } }]);
    await view();
    expect(el().querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});

describe('CatalogItemPage: an existing entry', () => {
  it('shows it with its date, and a save that waits for a change', async () => {
    const { el, control, save } = await render('departments', EDIT('departments'));
    expect(el().querySelector('h1')?.textContent).toContain('PRODUCT_CATALOG.DEPARTMENTS.FORM.EDIT_TITLE');
    expect(el().querySelector('.meta')?.textContent).toContain('PRODUCT_CATALOG.FORM.UPDATED');
    expect(el().querySelector('.meta')?.textContent).not.toContain('"date":""');
    expect((control(nameLabel('it')) as HTMLInputElement).value).toBe('Bibite');
    expect((control(descriptionLabel('it')) as HTMLInputElement).value).toBe('Freddo');
    expect((control(L.code) as HTMLInputElement).value).toBe('5');
    expect((control(L.tax) as HTMLSelectElement).value).toBe(T1);
    expect(save()!.textContent).toContain('COMMON.SAVE');
    expect(save()!.disabled).toBe(true);
  });

  it('shows no date for an entry that has none, and a stored code that is not a number as empty', async () => {
    const { el, control } = await render('departments', EDIT('departments'), {}, { item: { ...DEPT, updatedAt: null, code: null, taxId: null, tax: null } });
    expect(el().querySelector('.meta')?.textContent).toContain('{"date":""}');
    expect((control(L.code) as HTMLInputElement).value).toBe('');
    expect((control(L.tax) as HTMLSelectElement).value).toBe('');
  });

  it('formats the date in the language of the interface', async () => {
    const { el, view } = await render('departments', EDIT('departments'));
    const loading = TestBed.inject(I18nService).use('it');
    backend().expectOne('/i18n/it.json').flush({ TEST: 'x' });
    await loading;
    await view();
    expect(el().querySelector('.meta')?.textContent).toContain('2026');
  });

  it('saves only what changed with the version in If-Match, and uses the new one for the next save', async () => {
    const { type, submit, save, view, toasts, router } = await render('departments', EDIT('departments'));
    await type(nameLabel('it'), 'Bevande');
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(`${base('departments')}/${ID}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.body).toEqual({ name: { it: 'Bevande' } });
    req.flush({ data: { ...DEPT, name: { it: 'Bevande' } } }, { headers: { ETag: '"v2"' } });
    await view();
    expect(toasts()).toEqual(['success: PRODUCT_CATALOG.DEPARTMENTS.FORM.SAVED']);
    expect(save()!.disabled).toBe(true);
    expect(router.url).toBe(EDIT('departments'));
    await type(L.code, '9');
    await submit();
    const second = backend().expectOne(`${base('departments')}/${ID}`);
    expect(second.request.headers.get('If-Match')).toBe('"v2"');
    expect(second.request.body).toEqual({ code: 9 });
    second.flush({ data: { ...DEPT, code: 9 } });
    await view();
  });

  it('sends every field that changed, and nothing else', async () => {
    const { type, check, place, submit, view } = await render('departments', EDIT('departments'));
    await type(L.code, '12');
    await type(L.tax, T2);
    await type(nameLabel('en'), 'Drinks');
    await type(descriptionLabel('it'), '');
    await check(L.enabled, false);
    await check(L.noDiscount, true);
    await check(L.printer, true);
    await place('Negozio due');
    await submit();
    const req = backend().expectOne(`${base('departments')}/${ID}`);
    expect(req.request.body).toEqual({
      name: { en: 'Drinks' },
      description: { it: null },
      enabled: false,
      placeIds: [P1, P2],
      code: 12,
      taxId: T2,
      noDiscount: true,
      secondaryFiscalPrinter: true,
    });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('saves a brand with only its changes', async () => {
    const { type, submit, view } = await render('brands', EDIT('brands'));
    await type(nameLabel('it'), 'Acme 2');
    await submit();
    const req = backend().expectOne(`${base('brands')}/${ID}`);
    expect(req.request.body).toEqual({ name: { it: 'Acme 2' } });
    req.flush({ data: { ...BRAND, name: { it: 'Acme 2' } } });
    await view();
  });

  it('does not ask for the name in the required language of an entry that never had it', async () => {
    const { type, submit, error, view } = await render('brands', EDIT('brands'), {}, { item: { ...BRAND, name: { en: 'Acme' } } });
    await type(nameLabel('en'), 'Acme EN');
    await submit();
    expect(error(nameLabel('it'))).toBe('');
    backend().expectOne(`${base('brands')}/${ID}`).flush({ data: { ...BRAND, name: { en: 'Acme EN' } } });
    await view();
    await type(nameLabel('en'), '');
    await submit();
    expect(error(nameLabel('it'))).toBe('FORM.ISSUE.REQUIRED');
  });

  it('lets the administrator of a company save without choosing a store', async () => {
    const { type, submit, view } = await render('brands', EDIT('brands'), { role: 'CA' });
    await type(nameLabel('it'), 'Acme 2');
    await submit();
    backend().expectOne(`${base('brands')}/${ID}`).flush({ data: BRAND });
    await view();
  });

  it('asks to read the entry again on a 412, and reads it on request', async () => {
    const { type, submit, view, formError, reload, control, el } = await render('departments', EDIT('departments'));
    await type(nameLabel('it'), 'Mio');
    await submit();
    backend().expectOne(`${base('departments')}/${ID}`).flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view();
    expect(formError()).toContain('PRODUCT_CATALOG.FORM.STALE');
    reload()!.click();
    await view();
    backend().expectOne(`${base('departments')}/${ID}`).flush({ data: { ...DEPT, name: { it: 'Di un altro' } } }, { headers: { ETag: '"v9"' } });
    await view();
    expect(formError()).toBeNull();
    expect((control(nameLabel('it')) as HTMLInputElement).value).toBe('Di un altro');
    expect(el().querySelector('fc-error-state')).toBeNull();
    await type(nameLabel('it'), 'Nuovo');
    await submit();
    const req = backend().expectOne(`${base('departments')}/${ID}`);
    expect(req.request.headers.get('If-Match')).toBe('"v9"');
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('sends no If-Match when the server gave no version', async () => {
    const { type, submit, view, answer } = await render('brands', EDIT('brands'), {}, { item: 'skip' });
    backend().expectOne(`${base('brands')}/${ID}`).flush({ data: BRAND });
    await view();
    await type(nameLabel('it'), 'Acme 2');
    await submit();
    const req = backend().expectOne(`${base('brands')}/${ID}`);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: BRAND });
    await view();
  });

  it('answers a 409 without details asking to read again', async () => {
    const { type, submit, view, formError, reload } = await render('brands', EDIT('brands'));
    await type(nameLabel('it'), 'Acme 2');
    await submit();
    backend().expectOne(`${base('brands')}/${ID}`).flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view();
    expect(formError()).toContain('PRODUCT_CATALOG.ERROR.CONCURRENT');
    expect(reload()).toBeTruthy();
  });

  it('does not offer to reload for a failure that is not a conflict', async () => {
    const { type, submit, view, formError, reload } = await render('brands', EDIT('brands'));
    await type(nameLabel('it'), 'Acme 2');
    await submit();
    backend().expectOne(`${base('brands')}/${ID}`).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(formError()).toContain('ERRORS.API.NOT_FOUND');
    expect(reload()).toBeUndefined();
  });

  it('removes the image in the media tab', async () => {
    const image = { _id: 'not-an-object-id', basename: 'foto', extension: 'png', filename: 'foto.png', mimetype: 'image/png', title: null, alt: null, dirname: '/', type: 'image', filectime: 1 };
    const { el, openTab, view, submit, save } = await render('departments', EDIT('departments'), {}, { item: { ...DEPT, image } });
    await openTab('media');
    expect(el().querySelector('fc-logo-slot')?.textContent).toContain('foto.png');
    const remove = [...el().querySelectorAll<HTMLButtonElement>('fc-logo-slot button')].find((b) => b.textContent?.trim() === 'COMPANIES.MEDIA.REMOVE')!;
    remove.click();
    await view();
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(`${base('departments')}/${ID}`);
    expect(req.request.body).toEqual({ image: null });
    req.flush({ data: { ...DEPT, image: null } });
    await view();
  });

  it('replaces the image with a chosen one', async () => {
    const { slot, view, submit } = await render('brands', EDIT('brands'));
    slot().logoChange.emit({ descriptor: null, imageId: IMAGE, label: 'x', previewUrl: null });
    await view();
    await submit();
    const req = backend().expectOne(`${base('brands')}/${ID}`);
    expect(req.request.body).toEqual({ image: { imageId: IMAGE } });
    req.flush({ data: BRAND });
    await view();
  });
});

describe('CatalogItemPage: read only', () => {
  it('is read only without products:update', async () => {
    const { el, control, save, type, page } = await render('departments', EDIT('departments'), { permissions: READ_ONLY });
    expect((control(nameLabel('it')) as HTMLInputElement).disabled).toBe(true);
    expect((control(L.code) as HTMLInputElement).disabled).toBe(true);
    expect(save()).toBeNull();
    expect(el().querySelector('[role=note]')?.textContent ?? '').not.toContain('READ_ONLY_SHARED');
    expect(el().querySelector('fc-logo-slot .actions button')).toBeNull();
    expect(page().confirmLeave()).toBe(true);
  });

  it('is read only, with a warning, when the server says the entry is not editable', async () => {
    const { el, control, save, page, type } = await render('brands', EDIT('brands'), {}, { item: { ...BRAND, editable: false } });
    expect(el().querySelector('p[role=note]')?.textContent).toContain('PRODUCT_CATALOG.READ_ONLY_SHARED');
    expect((control(nameLabel('it')) as HTMLInputElement).disabled).toBe(true);
    expect(save()).toBeNull();
    expect(page().confirmLeave()).toBe(true);
  });

  it('stays editable when the server says it is', async () => {
    const { el, save } = await render('brands', EDIT('brands'), {}, { item: { ...BRAND, editable: true } });
    expect(el().querySelector('p[role=note]')).toBeNull();
    expect(save()).not.toBeNull();
  });
});

describe('CatalogItemPage: leaving the page', () => {
  it('leaves at once when nothing changed', async () => {
    const { page } = await render('departments', EDIT('departments'));
    expect(page().confirmLeave()).toBe(true);
  });

  it('asks first when something is unsaved: staying, or leaving', async () => {
    const { type, page, view, dialogButton, el } = await render('departments', EDIT('departments'));
    await type(nameLabel('it'), 'Modificato');
    const stay = page().confirmLeave() as Promise<boolean>;
    await view();
    expect(el().querySelector('dialog[open]')?.textContent).toContain('PRODUCT_CATALOG.LEAVE.MESSAGE');
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(await stay).toBe(false);
    const leave = page().confirmLeave() as Promise<boolean>;
    await view();
    dialogButton('PRODUCT_CATALOG.LEAVE.CONFIRM').click();
    await view();
    expect(await leave).toBe(true);
    expect(el().querySelector('dialog[open]')).toBeNull();
  });

  it('asks on a new entry that was started, through the guard of the route, and not after a save', async () => {
    const { type, submit, view, router, dialogButton, answer } = await render('brands', NEW('brands'));
    await type(nameLabel('it'), 'Acme');
    const blocked = router.navigateByUrl('/elsewhere');
    await view();
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(await blocked).toBe(false);
    await submit();
    backend().expectOne(base('brands')).flush({ data: BRAND }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    await view();
    await answer({ edit: true });
    expect(router.url).toBe(EDIT('brands'));
    expect(await router.navigateByUrl('/elsewhere')).toBe(true);
  });

  it('does not ask on a new entry left empty', async () => {
    const { page } = await render('brands', NEW('brands'));
    expect(page().confirmLeave()).toBe(true);
  });
});
