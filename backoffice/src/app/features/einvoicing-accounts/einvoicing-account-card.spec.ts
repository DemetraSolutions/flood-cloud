import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { CONFIGURED, UNCONFIGURED } from '../../../testing/einvoicing';
import { errorOf, findControl, submitForm, typeInto } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { EInvoicingAccountCard } from './einvoicing-account-card';
import { EInvoicingAccount } from './einvoicing-account.types';

const DEALER = '665f1c2e9b1d4a0012ab34d1';
const DEALER_URL = `${API}/v1/dealers/${DEALER}/integrations/aruba`;
const PLATFORM_URL = `${API}/v1/settings/integrations/aruba`;
const USERNAME = 'EINVOICING.USERNAME';
const PASSWORD = 'EINVOICING.PASSWORD';
const PER_HOUR = 'EINVOICING.MAX_PER_HOUR';
const PER_YEAR = 'EINVOICING.MAX_PER_YEAR';

const removeButton = (root: HTMLElement) =>
  [...root.querySelectorAll('form button')].find(
    (b) => b.textContent?.trim() === 'EINVOICING.REMOVE',
  );

async function render(dealerId: string | null = null, withApi = true) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(withApi ? [] : [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', permissions: ['eInvoicingAccounts:manage'] });
  const url = dealerId === null ? PLATFORM_URL : DEALER_URL;
  const fixture = TestBed.createComponent(EInvoicingAccountCard);
  fixture.componentRef.setInput('dealerId', dealerId);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = fixture as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const load = async (account: EInvoicingAccount = UNCONFIGURED, etag = '"v1"') => {
    await view();
    backend()
      .expectOne(url)
      .flush({ data: account }, { headers: { ETag: etag } });
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  const value = (label: string) => findControl(scope, label).value;
  const type = (label: string, text: string) => typeInto(scope, label, text);
  const save = async () => {
    await submitForm(scope);
    await view();
  };
  const error = (label: string) => errorOf(scope, label);
  const dialog = () => root.querySelector<HTMLDialogElement>('dialog[open]');
  const failSave = async (
    status: number,
    code: string,
    details?: { field: string; issue: string }[],
  ) => {
    backend()
      .expectOne({ method: 'PUT', url })
      .flush(errorBody(code, details), { status, statusText: 'x' });
    await view();
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.message);
  return {
    fixture,
    root,
    view,
    load,
    button,
    value,
    type,
    save,
    error,
    dialog,
    failSave,
    toasts,
    url,
    scope,
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('EInvoicingAccountCard: reading', () => {
  it('shows the defaults of a new platform account, read only hub, password required', async () => {
    const { root, view, load, value } = await render();
    await view();
    expect(root.textContent).toContain('COMMON.LOADING');
    await load();
    expect(root.textContent).toContain('EINVOICING.OWNER.PLATFORM');
    expect(value('EINVOICING.HUB')).toBe('aruba');
    expect(
      findControl({ nativeElement: root } as ComponentFixture<unknown>, 'EINVOICING.HUB'),
    ).toHaveProperty('readOnly', true);
    expect(value(USERNAME)).toBe('');
    expect(value(PER_HOUR)).toBe('55');
    expect(value(PER_YEAR)).toBe('10000');
    expect(root.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
    const password = root.querySelector<HTMLInputElement>('input[type=password]')!;
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(password.required).toBe(true);
    expect(password.value).toBe('');
    expect(root.textContent).toContain('EINVOICING.PASSWORD_HINT');
    expect(removeButton(root)).toBeUndefined();
  });

  it('shows an account of a dealer, with the password optional and the remove action', async () => {
    const { root, load, value } = await render(DEALER);
    await load({ ...CONFIGURED, hub: `aruba__${DEALER}`, maxPerYear: null, enabled: false });
    expect(root.textContent).toContain('EINVOICING.OWNER.DEALER');
    expect(value('EINVOICING.HUB')).toBe(`aruba__${DEALER}`);
    expect(value(USERNAME)).toBe('flood.user');
    expect(value(PER_YEAR)).toBe('');
    expect(root.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>('input[type=password]')!.required).toBe(false);
    expect(root.textContent).toContain('EINVOICING.PASSWORD_SET_HINT');
    expect(removeButton(root)).toBeDefined();
  });

  it('shows the failure of the read, and reads again on retry', async () => {
    const { root, view, button, load, url } = await render(DEALER);
    await view();
    backend().expectOne(url).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.NOT_FOUND');
    button('COMMON.RETRY').click();
    await load();
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('reports an unexpected failure to read generically', async () => {
    const { root, view } = await render(null, false);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});

describe('EInvoicingAccountCard: validation', () => {
  it('refuses empty and wrong values without sending anything, and focuses the first problem', async () => {
    const { load, save, type, error } = await render();
    await load();
    await type(PER_HOUR, '0');
    await type(PER_YEAR, 'x');
    await save();
    backend().expectNone({ method: 'PUT', url: PLATFORM_URL });
    expect(error(USERNAME)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(PASSWORD)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(PER_HOUR)).toBe('FORM.ISSUE.MINIMUM');
    expect(error(PER_YEAR)).toBe('FORM.ISSUE.PATTERN');
    await type(USERNAME, 'has space');
    await type(PER_HOUR, '1001');
    await save();
    expect(error(USERNAME)).toBe('FORM.ISSUE.PATTERN');
    expect(error(PER_HOUR)).toBe('FORM.ISSUE.MAXIMUM');
  });
});

describe('EInvoicingAccountCard: touching', () => {
  it('shows the problems of a field once the user leaves it', async () => {
    const { load, value, error, view, scope } = await render();
    await load();
    for (const label of [USERNAME, PASSWORD, PER_HOUR, PER_YEAR]) {
      findControl(scope, label).dispatchEvent(new Event('blur'));
    }
    await view();
    expect(error(USERNAME)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(PASSWORD)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(PER_HOUR)).toBe('');
    expect(value(PER_YEAR)).toBe('10000');
  });
});

describe('EInvoicingAccountCard: saving', () => {
  it('creates the account with the password, clears the field and keeps the new version', async () => {
    const { root, load, save, type, view, toasts, value } = await render(DEALER);
    await load(UNCONFIGURED, '"v1"');
    await type(USERNAME, 'aruba.user');
    await type(PASSWORD, 's3cret pass');
    await type(PER_YEAR, '');
    await save();
    const put = backend().expectOne({ method: 'PUT', url: DEALER_URL });
    expect(put.request.headers.get('If-Match')).toBe('"v1"');
    expect(put.request.body).toEqual({
      enabled: true,
      username: 'aruba.user',
      password: 's3cret pass',
      maxPerHour: 55,
      maxPerYear: null,
    });
    put.flush(
      { data: { ...CONFIGURED, username: 'aruba.user', maxPerYear: null } },
      { headers: { ETag: '"v2"' } },
    );
    await view();
    expect(toasts()).toEqual(['EINVOICING.SAVED']);
    expect(value(PASSWORD)).toBe('');
    expect(root.textContent).toContain('EINVOICING.PASSWORD_SET_HINT');
    expect(removeButton(root)).toBeDefined();
    // The next save presents the new version and, without a new password, sends none.
    await save();
    const next = backend().expectOne({ method: 'PUT', url: DEALER_URL });
    expect(next.request.headers.get('If-Match')).toBe('"v2"');
    expect(next.request.body).not.toHaveProperty('password');
    next.flush({ data: CONFIGURED }, { headers: { ETag: '"v3"' } });
    await view();
  });

  it('shows the field message of a 422 and of a username taken (409)', async () => {
    const { load, save, type, view, error, failSave, root } = await render();
    await load(CONFIGURED);
    await save();
    await failSave(422, 'VALIDATION_ERROR', [
      { field: 'maxPerHour', issue: 'maximum' },
      { field: 'unknown', issue: 'unknown' },
    ]);
    expect(error(PER_HOUR)).toBe('FORM.ISSUE.MAXIMUM');
    expect(root.querySelector('fc-form-error')?.textContent).toContain(
      'ERRORS.API.VALIDATION_ERROR',
    );
    await type(PER_HOUR, '56');
    await type(USERNAME, 'other');
    await save();
    await failSave(409, 'CONFLICT', [{ field: 'username', issue: 'taken' }]);
    expect(error(USERNAME)).toBe('FORM.ISSUE.TAKEN');
    expect(root.querySelector('fc-form-error')).toBeNull();
    await view();
  });

  it('offers to reload after a stale version, and reads again', async () => {
    const { root, load, save, failSave, button } = await render();
    await load(CONFIGURED);
    await save();
    await failSave(412, 'PRECONDITION_FAILED');
    expect(root.querySelector('[role=alert]')?.textContent).toContain('EINVOICING.STALE');
    button('EINVOICING.RELOAD').click();
    await load({ ...CONFIGURED, username: 'changed' }, '"v9"');
    expect(root.querySelector('[role=alert]')).toBeNull();
  });

  it('says the server has no encryption key (503)', async () => {
    const { root, load, save, failSave } = await render();
    await load(CONFIGURED);
    await save();
    await failSave(503, 'SERVICE_UNAVAILABLE');
    expect(root.querySelector('fc-form-error')?.textContent).toContain(
      'EINVOICING.NO_ENCRYPTION_KEY',
    );
  });

  it('uses the central message for any other failure', async () => {
    const { root, load, save, failSave } = await render();
    await load(CONFIGURED);
    await save();
    await failSave(403, 'FORBIDDEN');
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.FORBIDDEN');
    await save();
    await failSave(422, 'VALIDATION_ERROR');
    expect(root.querySelector('fc-form-error')?.textContent).toContain(
      'ERRORS.API.VALIDATION_ERROR',
    );
  });
});

describe('EInvoicingAccountCard: removing', () => {
  async function ask() {
    const ctx = await render(DEALER);
    await ctx.load(CONFIGURED, '"v5"');
    ctx.button('EINVOICING.REMOVE').click();
    await ctx.view();
    return ctx;
  }
  const confirm = (ctx: Awaited<ReturnType<typeof ask>>) =>
    (ctx.dialog()!.querySelectorAll('footer button')[1] as HTMLButtonElement).click();

  it('asks first, and Cancel sends nothing', async () => {
    const ctx = await ask();
    expect(ctx.dialog()?.getAttribute('role')).toBe('alertdialog');
    expect(ctx.dialog()?.textContent).toContain('EINVOICING.REMOVE_CONFIRM');
    (ctx.dialog()!.querySelector('footer button') as HTMLButtonElement).click();
    await ctx.view();
    expect(ctx.dialog()).toBeNull();
    backend().expectNone({ method: 'DELETE', url: DEALER_URL });
  });

  it('deletes with the version and reads the account again', async () => {
    const ctx = await ask();
    confirm(ctx);
    await ctx.view();
    const request = backend().expectOne({ method: 'DELETE', url: DEALER_URL });
    expect(request.request.headers.get('If-Match')).toBe('"v5"');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await ctx.view();
    expect(ctx.toasts()).toEqual(['EINVOICING.REMOVED']);
    expect(ctx.dialog()).toBeNull();
    await ctx.load(UNCONFIGURED);
    expect(removeButton(ctx.root)).toBeUndefined();
  });

  it('offers to reload when the account changed meanwhile (412)', async () => {
    const ctx = await ask();
    confirm(ctx);
    await ctx.view();
    backend()
      .expectOne({ method: 'DELETE', url: DEALER_URL })
      .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await ctx.view();
    expect(ctx.dialog()).toBeNull();
    expect(ctx.root.querySelector('[role=alert]')?.textContent).toContain('EINVOICING.STALE');
  });

  it('shows the central message when the removal fails (404)', async () => {
    const ctx = await ask();
    confirm(ctx);
    await ctx.view();
    backend()
      .expectOne({ method: 'DELETE', url: DEALER_URL })
      .flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await ctx.view();
    expect(ctx.root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.NOT_FOUND');
  });
});
