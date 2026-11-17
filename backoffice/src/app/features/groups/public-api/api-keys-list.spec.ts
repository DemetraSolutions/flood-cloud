import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { apiBaseUrlInterceptor } from '../../../core/api/api-base-url.interceptor';
import { AppConfig } from '../../../core/config/app-config';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../../testing/api';
import { fakeApiKey, fakeUsage } from '../../../../testing/api-keys';
import { emulateNativeDialog } from '../../../../testing/dialog';
import { signIn } from '../../../../testing/session';
import { I18nService } from '../../../core/i18n/i18n.service';
import { ApiPage } from '../../../core/api/api.types';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { Profile } from '../../../core/session/session.types';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { ApiKey, PLATFORM_DEFAULTS } from './api-key.types';
import { ApiKeySecret } from './api-key-secret';
import { ApiKeysApi } from './api-keys-api';
import { ApiKeysList } from './api-keys-list';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const URL = `${API}/v1/groups/${GROUP}/api-keys`;
const SECRET = 'fc_pk_AbCdEfFAKEFAKEFAKEFAKEFAKEFAKEFAKE'; // gitleaks:allow (fake test value)
const MANAGE = ['apiKeys:read', 'apiKeys:manage'];
const FUTURE = '2999-01-01T23:59:59.999Z';

const ACTIVE = fakeApiKey({
  id: 'k1',
  name: 'Webshop',
  permissions: ['places:read', 'catalog:read'],
  restrictions: { companyIds: ['c1'], placeIds: ['p1', 'p2'] },
  expiresAt: FUTURE,
  lastUsedAt: '2026-11-17T12:31:00.000Z',
});
const REVOKED = fakeApiKey({
  id: 'k2',
  name: 'Vecchia',
  status: 'revoked',
  revokedAt: '2026-11-01T00:00:00.000Z',
});
const EXPIRED = fakeApiKey({
  id: 'k3',
  name: 'Scaduta',
  restrictions: { companyIds: [], placeIds: null },
  expiresAt: '2020-01-01T00:00:00.000Z',
});

function page(data: ApiKey[], next: string | null = null): ApiPage<ApiKey> {
  return { data, page: { limit: 25, next } };
}

async function render(profile: Partial<Profile> = {}, raw = false) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: raw
      ? [
          provideHttpClient(withInterceptors([apiBaseUrlInterceptor])),
          provideHttpClientTesting(),
          { provide: AppConfig, useValue: { apiBaseUrl: signal(API).asReadonly() } },
        ]
      : provideApiTesting(),
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  vi.spyOn(ReferenceApi.prototype, 'companies').mockImplementation(async () => ({
    data: [{ id: 'c1', name: 'Alfa Srl' }],
    page: { limit: 25, next: null },
  }));
  vi.spyOn(ReferenceApi.prototype, 'places').mockImplementation(async () => ({
    data: [{ id: 'p1', name: 'Centro' }],
    page: { limit: 25, next: null },
  }));
  signIn({ role: 'PSA', groupId: null, permissions: MANAGE, ...profile });
  const fixture = TestBed.createComponent(ApiKeysList);
  fixture.componentRef.setInput('groupId', GROUP);
  fixture.componentRef.setInput('inherited', PLATFORM_DEFAULTS);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const reads = () => backend().match((r) => r.method === 'GET' && r.url === URL);
  const load = async (keys: ApiKey[], next: string | null = null) => {
    const [request] = reads();
    request.flush(page(keys, next));
    await view();
    return request;
  };
  const rows = () =>
    [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
    );
  const button = (name: string, scope: ParentNode = root) =>
    [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  const byLabel = (prefix: string, name: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label='${prefix} {"name":"${name}"}']`);
  const dialog = (heading: string) =>
    [...root.querySelectorAll('dialog')].find(
      (d) => d.querySelector('h2')?.textContent?.trim() === heading,
    )!;
  const click = async (element: Element | null | undefined) => {
    (element as HTMLElement).click();
    await view();
  };
  const field = (scope: ParentNode, label: string) => {
    const element = [...scope.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === label,
    ) as HTMLLabelElement;
    return scope.querySelector<HTMLInputElement>(`#${element.htmlFor}`)!;
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => [t.kind, t.message]);
  return { fixture, root, view, reads, load, rows, button, byLabel, dialog, click, field, toasts };
}

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ApiKeysList: reading', () => {
  it('lists the keys with their data and a status computed from the expiry', async () => {
    const { rows, load } = await render();
    const request = await load([ACTIVE, REVOKED, EXPIRED]);
    expect(request.request.params.get('limit')).toBe('25');
    expect(request.request.params.has('cursor')).toBe(false);
    const [active, revoked, expired] = rows();
    expect(active.slice(0, 5)).toEqual([
      'Webshop',
      'fc_pk_AbCdEf',
      'PUBLIC_API.PERMISSION.PLACES_READ.LABEL, PUBLIC_API.PERMISSION.CATALOG_READ.LABEL',
      'PUBLIC_API.LIST.COMPANIES_COUNT {"count":1} · PUBLIC_API.LIST.PLACES_COUNT {"count":2}',
      'PUBLIC_API.LIST.LIMITS_VALUE {"minute":60,"day":10000}',
    ]);
    expect(active[6]).toBe('PUBLIC_API.STATUS.ACTIVE');
    expect(active[7]).toContain('2026');
    expect(active[8]).toContain('2026');
    expect(revoked[5]).toBe('PUBLIC_API.LIST.NEVER_EXPIRES');
    expect(revoked[3]).toBe('PUBLIC_API.LIST.NO_RESTRICTIONS');
    expect(revoked[6]).toBe('PUBLIC_API.STATUS.REVOKED');
    expect(revoked[8]).toBe('PUBLIC_API.LIST.NEVER_USED');
    expect(expired[3]).toBe('PUBLIC_API.LIST.COMPANIES_COUNT {"count":0}');
    expect(expired[6]).toBe('PUBLIC_API.STATUS.EXPIRED');
  });

  it('shows the empty state', async () => {
    const { root, load } = await render();
    await load([]);
    expect(root.textContent).toContain('PUBLIC_API.LIST.EMPTY');
  });

  it('shows a failure and reads again on retry', async () => {
    const { root, view, reads, click, rows } = await render();
    reads()[0].flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.FORBIDDEN');
    await click(root.querySelector('fc-error-state button'));
    await view();
    reads()[0].flush(page([ACTIVE]));
    await view();
    expect(rows()).toHaveLength(1);
  });

  it('reports a failure that is not an API error generically', async () => {
    const { root, view, reads } = await render();
    reads()[0].error(new ProgressEvent('error'));
    await view();
    expect(root.querySelector('fc-error-state')).not.toBeNull();
  });

  it('shows a generic message when the failure is not from the API', async () => {
    const { root, view, reads } = await render({}, true);
    reads()[0].flush('x', { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('pages with the cursor, back and with another page size', async () => {
    const { root, load, reads, click, button, view, field } = await render();
    await load([ACTIVE], 'c2');
    expect(button('PUBLIC_API.LIST.NEW')).toBeDefined();
    await click(button('PAGINATION.NEXT'));
    let [request] = reads();
    expect(request.request.params.get('cursor')).toBe('c2');
    request.flush(page([REVOKED], 'c3'));
    await view();
    await click(button('PAGINATION.NEXT'));
    [request] = reads();
    expect(request.request.params.get('cursor')).toBe('c3');
    request.flush(page([EXPIRED]));
    await view();
    await click(button('PAGINATION.PREVIOUS'));
    [request] = reads();
    expect(request.request.params.get('cursor')).toBe('c2');
    request.flush(page([REVOKED], 'c3'));
    await view();
    await click(button('PAGINATION.PREVIOUS'));
    [request] = reads();
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush(page([ACTIVE], 'c2'));
    await view();
    const size = field(root, 'PAGINATION.PER_PAGE') as unknown as HTMLSelectElement;
    size.value = '50';
    size.dispatchEvent(new Event('change'));
    await view();
    [request] = reads();
    expect(request.request.params.get('limit')).toBe('50');
    request.flush(page([ACTIVE]));
    await view();
  });
});

describe('ApiKeysList: roles', () => {
  it.each(['PSA', 'D'] as const)(
    'lets %s with apiKeys:manage create, change and revoke',
    async (role) => {
      const { button, byLabel, load } = await render({ role });
      await load([ACTIVE]);
      expect(button('PUBLIC_API.LIST.NEW')).toBeDefined();
      expect(byLabel('PUBLIC_API.LIST.EDIT_LABEL', 'Webshop')).not.toBeNull();
      expect(byLabel('PUBLIC_API.LIST.REVOKE_LABEL', 'Webshop')).not.toBeNull();
      expect(byLabel('PUBLIC_API.LIST.USAGE_LABEL', 'Webshop')).not.toBeNull();
    },
  );

  it('only shows the usage to whoever can read but not manage', async () => {
    const { button, byLabel, load } = await render({ role: 'D', permissions: ['apiKeys:read'] });
    await load([ACTIVE]);
    expect(button('PUBLIC_API.LIST.NEW')).toBeUndefined();
    expect(byLabel('PUBLIC_API.LIST.EDIT_LABEL', 'Webshop')).toBeNull();
    expect(byLabel('PUBLIC_API.LIST.REVOKE_LABEL', 'Webshop')).toBeNull();
    expect(byLabel('PUBLIC_API.LIST.USAGE_LABEL', 'Webshop')).not.toBeNull();
  });

  it('offers only the usage on a revoked or expired key', async () => {
    const { byLabel, load } = await render();
    await load([REVOKED, EXPIRED]);
    for (const name of ['Vecchia', 'Scaduta']) {
      expect(byLabel('PUBLIC_API.LIST.EDIT_LABEL', name)).toBeNull();
      expect(byLabel('PUBLIC_API.LIST.REVOKE_LABEL', name)).toBeNull();
      expect(byLabel('PUBLIC_API.LIST.USAGE_LABEL', name)).not.toBeNull();
    }
  });
});

describe('ApiKeysList: creation', () => {
  async function open(profile: Partial<Profile> = {}) {
    const view = await render(profile);
    await view.load([ACTIVE]);
    await view.click(view.button('PUBLIC_API.LIST.NEW'));
    await view.view();
    const editor = view.dialog('PUBLIC_API.KEY.NEW_TITLE');
    const fill = async (label: string, value: string) => {
      const input = view.field(editor, label);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await view.view();
    };
    const check = async (label: string) => {
      const box = view.field(editor, label);
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view.view();
    };
    const submit = async () => {
      editor.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await view.view();
    };
    const secretState = () =>
      (
        view.fixture.debugElement.query(By.directive(ApiKeySecret))
          .componentInstance as unknown as {
          secret(): string | null;
        }
      ).secret();
    return { ...view, editor, fill, check, submit, secretState };
  }
  const posts = () => backend().match((r) => r.method === 'POST' && r.url === URL);

  it('creates the key and shows the secret once, only in its dialog', async () => {
    const {
      fill,
      check,
      submit,
      view,
      load,
      root,
      dialog,
      button,
      rows,
      editor,
      toasts,
      secretState,
    } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await submit();
    const [post] = posts();
    expect(post.request.body).toEqual({ name: 'Nuova', permissions: ['places:read'] });
    post.flush({ data: { ...fakeApiKey({ id: 'k9', name: 'Nuova' }), secret: SECRET } });
    await view();
    // The editor closes, the secret dialog opens with the secret.
    expect(editor.hasAttribute('open')).toBe(false);
    const secretDialog = dialog('PUBLIC_API.SECRET.TITLE');
    expect(secretDialog.hasAttribute('open')).toBe(true);
    expect(secretDialog.querySelector('code')?.textContent).toBe(SECRET);
    // The list was read again, and nothing outside the secret dialog has the secret.
    await load([ACTIVE, fakeApiKey({ id: 'k9', name: 'Nuova' })]);
    expect(rows()).toHaveLength(2);
    expect(root.querySelector('table')?.textContent).not.toContain(SECRET);
    expect(toasts()).toEqual([]);
    // Closing forgets it.
    expect(button('COMMON.CLOSE', secretDialog)!.disabled).toBe(true);
    // Esc is always available and clears the secret.
    secretDialog.close();
    await view();
    expect(secretState()).toBeNull();
    expect(root.textContent).not.toContain(SECRET);
  });

  it('shows the secret nowhere in the state of the list', async () => {
    const { fixture, fill, check, submit, view, dialog } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await submit();
    posts()[0].flush({ data: { ...fakeApiKey({ id: 'k9' }), secret: SECRET } });
    await view();
    const resource = (fixture.componentInstance as unknown as { resource: { value(): unknown } })
      .resource;
    expect(JSON.stringify(resource.value())).not.toContain(SECRET);
    expect(dialog('PUBLIC_API.SECRET.TITLE').querySelector('code')?.textContent).toBe(SECRET);
    const state = fixture.componentInstance as unknown as Record<string, unknown>;
    const seen: string[] = [];
    for (const [name, value] of Object.entries(state)) {
      if (typeof value === 'function' && 'set' in value) {
        seen.push(JSON.stringify([name, (value as unknown as () => unknown)()]));
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join(' ')).not.toContain(SECRET);
    backend().match(() => true);
  });

  it('drops the secret and says so when the component is gone before the 201', async () => {
    const { fixture, fill, check, submit, toasts, root } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await submit();
    const [post] = posts();
    fixture.destroy();
    post.flush({ data: { ...fakeApiKey({ id: 'k9', name: 'Nuova' }), secret: SECRET } });
    await settle();
    expect(toasts()).toEqual([['error', 'PUBLIC_API.SECRET.LOST {"name":"Nuova"}']]);
    expect(JSON.stringify(toasts())).not.toContain(SECRET);
    expect(root.textContent).not.toContain(SECRET);
    // Nothing was read again by a component that is gone.
    expect(backend().match((r) => r.method === 'GET' && r.url === URL)).toHaveLength(0);
  });

  it('lets the platform administrator send limits', async () => {
    const { fill, check, submit } = await open({ role: 'PSA' });
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await fill('PUBLIC_API.KEY.PER_MINUTE', '10');
    await submit();
    expect(posts()[0].request.body).toEqual({
      name: 'Nuova',
      permissions: ['places:read'],
      rateLimitPerMinute: 10,
    });
  });

  it('shows the limits read-only to a dealer and never sends them', async () => {
    const { fill, check, submit, field, editor } = await open({ role: 'D' });
    expect(field(editor, 'PUBLIC_API.KEY.PER_MINUTE').disabled).toBe(true);
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await submit();
    expect(posts()[0].request.body).toEqual({ name: 'Nuova', permissions: ['places:read'] });
  });

  it.each([
    [409, 'CONFLICT', undefined, 'PUBLIC_API.ERROR.TOO_MANY'],
    [403, 'FORBIDDEN', undefined, 'ERRORS.API.FORBIDDEN'],
    [404, 'NOT_FOUND', undefined, 'ERRORS.API.NOT_FOUND'],
    [429, 'RATE_LIMITED', undefined, 'ERRORS.API.RATE_LIMITED'],
  ])('keeps the editor open on a %s and says why', async (status, code, details, message) => {
    const { fill, check, submit, view, editor } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await submit();
    posts()[0].flush(errorBody(code, details), { status, statusText: 'x' });
    await view();
    expect(editor.hasAttribute('open')).toBe(true);
    expect(editor.querySelector('fc-form-error')?.textContent).toContain(message);
    // A creation that failed does not read the list again.
    expect(backend().match((r) => r.method === 'GET' && r.url === URL)).toHaveLength(0);
  });

  it('puts a 422 on the field', async () => {
    const { fill, check, submit, view, editor } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await submit();
    posts()[0].flush(errorBody('VALIDATION_ERROR', [{ field: 'name', issue: 'pattern' }]), {
      status: 422,
      statusText: 'x',
    });
    await view();
    expect(editor.textContent).toContain('FORM.ISSUE.PATTERN');
    expect(editor.querySelector('fc-form-error')).toBeNull();
  });

  it('reports a failure that is not an API error generically', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(ApiKeysApi.prototype, 'create').mockRejectedValue(new Error('boom'));
    const { fill, check, submit, view, editor } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Nuova');
    await check('PUBLIC_API.PERMISSION.PLACES_READ.LABEL');
    await submit();
    await view();
    expect(editor.querySelector('fc-form-error')?.textContent).toContain('ERRORS.');
  });

  it('closes the editor when its dialog is closed', async () => {
    const { editor, view } = await open();
    editor.close();
    await view();
    expect(editor.hasAttribute('open')).toBe(false);
  });

  it('closes the editor on cancel', async () => {
    const { button, click, editor } = await open();
    await click(button('COMMON.CANCEL', editor));
    expect(editor.hasAttribute('open')).toBe(false);
  });
});

describe('ApiKeysList: modification', () => {
  async function open(key: ApiKey = ACTIVE, profile: Partial<Profile> = {}) {
    const view = await render(profile);
    await view.load([key]);
    await view.click(view.byLabel('PUBLIC_API.LIST.EDIT_LABEL', key.name));
    await view.view();
    const editor = view.dialog('PUBLIC_API.KEY.EDIT_TITLE');
    const fill = async (label: string, value: string) => {
      const input = view.field(editor, label);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await view.view();
    };
    const submit = async () => {
      editor.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await view.view();
    };
    return { ...view, editor, fill, submit };
  }
  const patches = () => backend().match((r) => r.method === 'PATCH');

  it('opens on the key, sends only what changed and reads the list again', async () => {
    const { fill, submit, view, editor, field, reads, toasts } = await open();
    expect(field(editor, 'PUBLIC_API.KEY.NAME').value).toBe('Webshop');
    await fill('PUBLIC_API.KEY.NAME', 'Altro');
    await submit();
    const [patch] = patches();
    expect(patch.request.url).toBe(`${URL}/k1`);
    expect(patch.request.body).toEqual({ name: 'Altro' });
    patch.flush({ data: fakeApiKey({ id: 'k1', name: 'Altro' }) });
    await view();
    expect(editor.hasAttribute('open')).toBe(false);
    expect(toasts()).toEqual([['success', 'PUBLIC_API.SAVED']]);
    reads()[0].flush(page([fakeApiKey({ id: 'k1', name: 'Altro' })]));
    await view();
  });

  it.each([
    [409, 'CONFLICT', 'PUBLIC_API.ERROR.NOT_EDITABLE'],
    [404, 'NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
  ])('says why on a %s and reads the list again', async (status, code, message) => {
    const { fill, submit, view, editor, reads } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Altro');
    await submit();
    patches()[0].flush(errorBody(code), { status, statusText: 'x' });
    await view();
    expect(editor.hasAttribute('open')).toBe(true);
    expect(editor.querySelector('fc-form-error')?.textContent).toContain(message);
    reads()[0].flush(page([REVOKED]));
    await view();
  });

  it('does not read the list again on a validation error', async () => {
    const { fill, submit, view, editor } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Altro');
    await submit();
    patches()[0].flush(errorBody('VALIDATION_ERROR', [{ field: 'name', issue: 'pattern' }]), {
      status: 422,
      statusText: 'x',
    });
    await view();
    expect(editor.textContent).toContain('FORM.ISSUE.PATTERN');
    expect(backend().match((r) => r.method === 'GET' && r.url === URL)).toHaveLength(0);
  });

  it('does nothing more when the component is gone before the 200 of a modification', async () => {
    const { fixture, fill, submit, toasts } = await open();
    await fill('PUBLIC_API.KEY.NAME', 'Altro');
    await submit();
    const [patch] = patches();
    fixture.destroy();
    patch.flush({ data: fakeApiKey({ id: 'k1', name: 'Altro' }) });
    await settle();
    expect(toasts()).toEqual([]);
    expect(backend().match((r) => r.method === 'GET' && r.url === URL)).toHaveLength(0);
  });

  it('lets the platform administrator change limits', async () => {
    const { fill, submit } = await open(ACTIVE, { role: 'PSA' });
    await fill('PUBLIC_API.KEY.PER_DAY', '99');
    await submit();
    expect(patches()[0].request.body).toEqual({ dailyQuota: 99 });
  });

  it('shows the limits read-only to a dealer', async () => {
    const { field, editor } = await open(ACTIVE, { role: 'D' });
    expect(field(editor, 'PUBLIC_API.KEY.PER_DAY').disabled).toBe(true);
  });
});

describe('ApiKeysList: revocation', () => {
  async function ask() {
    const view = await render();
    await view.load([ACTIVE]);
    await view.click(view.byLabel('PUBLIC_API.LIST.REVOKE_LABEL', 'Webshop'));
    const confirm = view.dialog('PUBLIC_API.REVOKE.TITLE');
    return { ...view, confirm };
  }
  const revokes = () => backend().match((r) => r.method === 'POST' && r.url.endsWith('/revoke'));

  it('asks naming the key, revokes it and reads the list again', async () => {
    const { confirm, button, click, view, reads, toasts } = await ask();
    expect(confirm.hasAttribute('open')).toBe(true);
    expect(confirm.textContent).toContain('PUBLIC_API.REVOKE.MESSAGE {"name":"Webshop"}');
    await click(button('PUBLIC_API.LIST.REVOKE', confirm));
    const [request] = revokes();
    expect(request.request.url).toBe(`${URL}/k1/revoke`);
    request.flush({ data: fakeApiKey({ id: 'k1', status: 'revoked' }) });
    await view();
    expect(confirm.hasAttribute('open')).toBe(false);
    expect(toasts()).toEqual([['success', 'PUBLIC_API.REVOKED']]);
    reads()[0].flush(page([fakeApiKey({ id: 'k1', status: 'revoked' })]));
    await view();
  });

  it('does nothing when the user gives up', async () => {
    const { confirm, button, click } = await ask();
    await click(button('COMMON.CANCEL', confirm));
    expect(revokes()).toHaveLength(0);
    expect(confirm.hasAttribute('open')).toBe(false);
  });

  it('says why a revocation failed and still reads the list', async () => {
    const { confirm, button, click, view, reads, toasts } = await ask();
    await click(button('PUBLIC_API.LIST.REVOKE', confirm));
    revokes()[0].flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(toasts()).toEqual([['error', 'ERRORS.API.NOT_FOUND']]);
    expect(confirm.hasAttribute('open')).toBe(false);
    reads()[0].flush(page([]));
    await view();
  });

  it('opens the list again with the confirmation naming no key before one is chosen', async () => {
    const { root, load } = await render();
    await load([ACTIVE]);
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });
});

describe('ApiKeysList: usage', () => {
  it('shows the usage of the key in a dialog', async () => {
    const { byLabel, load, click, dialog, view } = await render();
    await load([ACTIVE]);
    await click(byLabel('PUBLIC_API.LIST.USAGE_LABEL', 'Webshop'));
    const usage = dialog('PUBLIC_API.USAGE.TITLE {"name":"Webshop"}');
    expect(usage.hasAttribute('open')).toBe(true);
    const request = backend().expectOne((r) => r.url === `${URL}/k1/usage`);
    request.flush({ data: fakeUsage() });
    await view();
    expect(usage.querySelectorAll('table')).toHaveLength(2);
  });

  it('closes the usage dialog and forgets the panel', async () => {
    const { byLabel, load, click, dialog, view } = await render();
    await load([ACTIVE]);
    await click(byLabel('PUBLIC_API.LIST.USAGE_LABEL', 'Webshop'));
    const usage = dialog('PUBLIC_API.USAGE.TITLE {"name":"Webshop"}');
    backend()
      .expectOne((r) => r.url === `${URL}/k1/usage`)
      .flush({ data: fakeUsage() });
    await view();
    usage.close();
    await view();
    expect(usage.hasAttribute('open')).toBe(false);
    expect(usage.querySelector('fc-api-key-usage')).toBeNull();
  });

  it('is also there for a key that cannot be changed', async () => {
    const { byLabel, load, click, dialog } = await render({
      role: 'D',
      permissions: ['apiKeys:read'],
    });
    await load([REVOKED]);
    await click(byLabel('PUBLIC_API.LIST.USAGE_LABEL', 'Vecchia'));
    expect(dialog('PUBLIC_API.USAGE.TITLE {"name":"Vecchia"}').hasAttribute('open')).toBe(true);
    backend().expectOne((r) => r.url === `${URL}/k2/usage`);
  });
});
