import { Provider, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { UsersApi } from '../users/users-api';
import { DealerRecord } from './dealer.types';
import { DealerForm } from './dealer-form';

const ID = '665f1c2e9b1d4a0012ab34d1';
const URL = `${API}/v1/dealers`;
const ALL = ['dealers:read', 'dealers:create', 'dealers:update', 'users:create', 'profile:read'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function render(url: string, profile: Partial<Profile> = {}, extra: Provider[] = []) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'dealers/new', component: DealerForm },
          { path: 'dealers/:dealerId', component: DealerForm },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  vi.spyOn(UsersApi.prototype, 'isUsernameAvailable').mockResolvedValue(true);
  signIn({ role: 'PSA', permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const loadDealer = async (dealer: DealerRecord | null = fakeDealer()) => {
    const request = backend().expectOne(`${URL}/${ID}`);
    if (dealer === null) {
      request.flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    } else {
      request.flush({ data: dealer });
    }
    await view();
  };
  const control = (label: string) => findControl(scope, label);
  const type = async (label: string, value: string) => {
    const field = control(label);
    field.value = value;
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const error = (label: string) => errorOf(scope, label);
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => root.querySelector<HTMLButtonElement>('button[type=submit]');
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.message);
  return {
    root,
    view,
    loadDealer,
    control,
    type,
    error,
    submit,
    save,
    toasts,
    router: TestBed.inject(Router),
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const L = {
  name: 'DEALERS.FIELD.BUSINESS_NAME',
  vat: 'DEALERS.FIELD.VAT',
  cf: 'DEALERS.FIELD.FISCAL_CODE',
  street: 'DEALERS.FIELD.STREET',
  postcode: 'DEALERS.FIELD.POSTCODE',
  city: 'DEALERS.FIELD.CITY',
  province: 'DEALERS.FIELD.PROVINCE',
  country: 'DEALERS.FIELD.COUNTRY',
  pec: 'DEALERS.FIELD.PEC',
  sdi: 'DEALERS.FIELD.SDI',
  username: 'USERS.FORM.USERNAME',
  password: 'USERS.FORM.PASSWORD',
};

describe('DealerForm: creation', () => {
  const NEW = '/dealers/new';

  it('has a company section and an access user section', async () => {
    const { root, control } = await render(NEW);
    expect(root.querySelector('h1')?.textContent).toBe('DEALERS.FORM.NEW_TITLE');
    expect([...root.querySelectorAll('legend')].map((l) => l.textContent)).toEqual([
      'DEALERS.FORM.COMPANY',
      'DEALERS.FORM.ACCESS_USER',
    ]);
    expect((control(L.country) as HTMLInputElement).value).toBe('IT');
    expect(root.querySelector('fc-password-generator')).not.toBeNull();
    expect(root.querySelector('.summary')).toBeNull();
  });

  it('shows the required errors on submit', async () => {
    const { submit, error } = await render(NEW);
    await submit();
    expect(error(L.name)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(L.username)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(L.password)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('applies the Italian rules of the backend', async () => {
    const { type, error, submit } = await render(NEW);
    await submit();
    await type(L.vat, '123');
    expect(error(L.vat)).toBe('FORM.ISSUE.PATTERN');
    await type(L.vat, '01234567890');
    expect(error(L.vat)).toBe('');
    await type(L.cf, 'ABC');
    expect(error(L.cf)).toBe('FORM.ISSUE.PATTERN');
    await type(L.sdi, 'ABC');
    expect(error(L.sdi)).toBe('FORM.ISSUE.PATTERN');
    await type(L.street, 'Via Roma 1');
    expect(error(L.postcode)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(L.city)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(L.province)).toBe('FORM.ISSUE.REQUIRED');
    await type(L.province, 'M1');
    expect(error(L.province)).toBe('FORM.ISSUE.PATTERN');
    await type(L.province, 'MI');
    expect(error(L.province)).toBe('');
  });

  it('relaxes the rules for another country', async () => {
    const { type, error, control, view } = await render(NEW);
    await type(L.street, 'Hauptstr 1');
    await type(L.postcode, '10115');
    await type(L.city, 'Berlin');
    await type(L.country, 'DE');
    await type(L.vat, 'DE123456');
    expect(error(L.vat)).toBe('');
    expect(error(L.province)).toBe('');
    await type(L.country, 'D');
    control(L.country).dispatchEvent(new Event('blur'));
    await view();
    expect(error(L.country)).toBe('FORM.ISSUE.PATTERN');
  });

  it('validates the user fields like the user form', async () => {
    const { type, error, submit } = await render(NEW);
    await submit();
    await type(L.username, 'a b');
    expect(error(L.username)).toBe('FORM.ISSUE.PATTERN');
    await type(L.username, 'dealer.new');
    await type(L.password, 'short');
    expect(error(L.password)).toBe('FORM.ISSUE.TOO_SHORT');
    await type(L.password, 'x'.repeat(129));
    expect(error(L.password)).toBe('FORM.ISSUE.TOO_LONG');
    await type(L.username, 'long.enough.name');
    await type(L.password, 'long.enough.name');
    expect(error(L.password)).toBe('FORM.ISSUE.SAME_AS_USERNAME');
    await type(L.password, 'Another-Pass-1');
    expect(error(L.password)).toBe('');
  });

  it('fills the password with a generated one', async () => {
    const { root, control, view } = await render(NEW);
    root.querySelector<HTMLButtonElement>('fc-password-generator button')!.click();
    await view();
    expect((control(L.password) as HTMLInputElement).value).toHaveLength(16);
  });

  describe('username availability', () => {
    it('checks a valid username once typing pauses', async () => {
      const { type, root, view } = await render(NEW);
      const spy = vi.mocked(UsersApi.prototype.isUsernameAvailable);
      await type(L.username, 'a b');
      await sleep(350);
      expect(spy).not.toHaveBeenCalled();
      await type(L.username, 'dealer.new');
      expect(root.textContent).toContain('USERS.FORM.USERNAME_CHECKING');
      await sleep(350);
      await view();
      expect(spy).toHaveBeenCalledWith('dealer.new');
      expect(root.textContent).toContain('USERS.FORM.USERNAME_AVAILABLE');
    });

    it('reports a taken username on the field', async () => {
      const { type, error, view } = await render(NEW);
      vi.mocked(UsersApi.prototype.isUsernameAvailable).mockResolvedValue(false);
      await type(L.username, 'dealer.new');
      await sleep(350);
      await view();
      expect(error(L.username)).toBe('FORM.ISSUE.TAKEN');
    });

    it('says so when it cannot be checked, logging without the username', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { type, root, view } = await render(NEW);
      vi.mocked(UsersApi.prototype.isUsernameAvailable).mockRejectedValue(new Error('x'));
      await type(L.username, 'dealer.new');
      await sleep(350);
      await view();
      expect(root.textContent).toContain('USERS.FORM.USERNAME_ERROR');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('dealer.new');
    });
  });

  describe('submission', () => {
    async function fill(ctx: Awaited<ReturnType<typeof render>>) {
      await ctx.type(L.name, 'Acme Srl');
      await ctx.type(L.vat, '01234567890');
      await ctx.type(L.street, 'Via Roma 1');
      await ctx.type(L.postcode, '20100');
      await ctx.type(L.city, 'Milano');
      await ctx.type(L.province, 'mi');
      await ctx.type(L.username, 'acme');
      await ctx.type(L.password, 'Temp-Password-9');
      await ctx.type('PROFILE.FIRST_NAME', 'Anna');
      await ctx.type('PROFILE.LAST_NAME', 'Rossi');
      await ctx.type('DEALERS.FIELD.USER_EMAIL', 'anna@example.com');
      await ctx.type('DEALERS.FIELD.USER_PHONE', '333 1');
    }

    it('sends company and user in one request, then opens the new dealer', async () => {
      const ctx = await render(NEW);
      await fill(ctx);
      await ctx.submit();
      await settle();
      const request = backend().expectOne(URL);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        company: {
          businessName: 'Acme Srl',
          vatNumber: '01234567890',
          address: {
            street: 'Via Roma 1',
            postcode: '20100',
            city: 'Milano',
            countryCode: 'IT',
            province: 'MI',
          },
        },
        user: {
          username: 'acme',
          password: 'Temp-Password-9',
          language: 'it',
          firstName: 'Anna',
          lastName: 'Rossi',
          email: 'anna@example.com',
          phone: '333 1',
        },
      });
      request.flush({ data: fakeDealer() }, { status: 201, statusText: 'Created' });
      await ctx.view();
      await settle();
      expect(ctx.toasts()).toEqual(['DEALERS.FORM.CREATED']);
      expect(ctx.router.url).toBe(`/dealers/${ID}`);
      backend().match(`${URL}/${ID}`);
    });

    it('sends only the mandatory fields when the rest is empty', async () => {
      const ctx = await render(NEW);
      await ctx.type(L.name, 'Acme');
      await ctx.type(L.username, 'acme');
      await ctx.type(L.password, 'Temp-Password-9');
      await ctx.submit();
      await settle();
      const request = backend().expectOne(URL);
      expect(request.request.body).toEqual({
        company: { businessName: 'Acme' },
        user: { username: 'acme', password: 'Temp-Password-9', language: 'it' },
      });
      request.flush({ data: fakeDealer() }, { status: 201, statusText: 'Created' });
      await ctx.view();
      backend().match(`${URL}/${ID}`);
    });

    async function failWith(
      status: number,
      code: string,
      details?: { field: string; issue: string }[],
    ) {
      const ctx = await render(NEW);
      await fill(ctx);
      await ctx.submit();
      await settle();
      backend().expectOne(URL).flush(errorBody(code, details), { status, statusText: 'x' });
      await ctx.view();
      return ctx;
    }

    it('puts 409 errors of both sections on their fields', async () => {
      const { error } = await failWith(409, 'CONFLICT', [
        { field: 'company.vatNumber', issue: 'taken' },
        { field: 'user.username', issue: 'taken' },
      ]);
      expect(error(L.vat)).toBe('FORM.ISSUE.TAKEN');
      expect(error(L.username)).toBe('FORM.ISSUE.TAKEN');
    });

    it('puts 422 errors of both sections on their fields, and the rest on the form', async () => {
      const { error, root } = await failWith(422, 'VALIDATION_ERROR', [
        { field: 'company.address.province', issue: 'required' },
        { field: 'company.pec', issue: 'format' },
        { field: 'user.password', issue: 'invalidCharacters' },
        { field: 'user.firstName', issue: 'maxLength' },
        { field: 'something.else', issue: 'unknown' },
      ]);
      expect(error(L.province)).toBe('FORM.ISSUE.REQUIRED');
      expect(error(L.pec)).toBe('FORM.ISSUE.FORMAT');
      expect(error(L.password)).toBe('FORM.ISSUE.INVALID_CHARACTERS');
      expect(error('PROFILE.FIRST_NAME')).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(root.querySelector('fc-form-error')?.textContent).toContain(
        'ERRORS.API.VALIDATION_ERROR',
      );
    });

    it('maps other failures centrally', async () => {
      const { root } = await failWith(429, 'RATE_LIMITED');
      expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.RATE_LIMITED');
    });

    it('shows a conflict without details as a form message', async () => {
      const { root } = await failWith(409, 'CONFLICT');
      expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.CONFLICT');
    });
  });

  it('reports blur on every field', async () => {
    const { control, root } = await render(NEW);
    for (const label of [
      L.name,
      L.vat,
      L.cf,
      L.street,
      L.postcode,
      L.city,
      L.province,
      L.country,
      L.pec,
      L.sdi,
      'DEALERS.FIELD.EMAIL',
      'DEALERS.FIELD.PHONE',
      L.username,
      L.password,
      'PROFILE.FIRST_NAME',
      'PROFILE.LAST_NAME',
      'DEALERS.FIELD.USER_EMAIL',
      'DEALERS.FIELD.USER_PHONE',
      'PROFILE.LANGUAGE',
    ]) {
      control(label).dispatchEvent(new Event('blur'));
    }
    expect(root.querySelector('fc-form-error')).toBeNull();
  });
});

describe('DealerForm: detail', () => {
  const EDIT = `/dealers/${ID}`;

  it('shows a loading state, then the data and a summary of the linked user', async () => {
    const { root, loadDealer, control } = await render(EDIT);
    expect(root.textContent).toContain('COMMON.LOADING');
    await loadDealer();
    expect(root.querySelector('h1')?.textContent).toBe('DEALERS.FORM.EDIT_TITLE');
    expect((control(L.name) as HTMLInputElement).value).toBe('Dealer Nord Srl');
    expect((control(L.province) as HTMLInputElement).value).toBe('MI');
    expect(root.querySelector('fieldset + fieldset')).toBeNull();
    const summary = root.querySelector('.summary')!;
    expect(summary.querySelector('a')?.getAttribute('href')).toBe(`/platform/users/${ID}`);
    expect(summary.textContent).toContain('USERS.STATUS.ACTIVE');
    expect(summary.textContent).toContain('DEALERS.SOURCE.manual');
    expect(summary.textContent).toContain('2026');
    expect(summary.textContent).toContain('DEALERS.FORM.DELETE_NOTE');
  });

  it('shows a disabled linked user, or none', async () => {
    const disabled = await render(EDIT);
    await disabled.loadDealer(
      fakeDealer({ user: { id: ID, username: 'd', status: 'disabled' }, source: 'migration' }),
    );
    expect(disabled.root.querySelector('.summary')?.textContent).toContain('USERS.STATUS.DISABLED');
    expect(disabled.root.querySelector('.summary')?.textContent).toContain(
      'DEALERS.SOURCE.migration',
    );
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const none = await render(EDIT);
    await none.loadDealer(fakeDealer({ user: null, createdAt: null }));
    expect(none.root.querySelector('.summary')?.textContent).toContain('DEALERS.NO_USER');
  });

  it('keeps save disabled until a field changes, then sends only the change', async () => {
    const { loadDealer, save, type, submit, toasts, view, root } = await render(EDIT);
    await loadDealer();
    expect(save()!.disabled).toBe(true);
    await type(L.city, 'Torino');
    await type(L.province, 'to');
    expect(save()!.disabled).toBe(false);
    await submit();
    await settle();
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ address: { city: 'Torino', province: 'TO' } });
    request.flush({
      data: fakeDealer({
        address: {
          street: 'Via Roma 1',
          postcode: '20100',
          city: 'Torino',
          province: 'TO',
          countryCode: 'IT',
        },
      }),
    });
    await view();
    expect(toasts()).toEqual(['DEALERS.FORM.SAVED']);
    expect(save()!.disabled).toBe(true);
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('puts errors of the modification on the fields', async () => {
    const { loadDealer, type, submit, view, error } = await render(EDIT);
    await loadDealer();
    await type(L.vat, '98765432109');
    await submit();
    await settle();
    backend()
      .expectOne(`${URL}/${ID}`)
      .flush(errorBody('CONFLICT', [{ field: 'vatNumber', issue: 'taken' }]), {
        status: 409,
        statusText: 'x',
      });
    await view();
    expect(error(L.vat)).toBe('FORM.ISSUE.TAKEN');
  });

  it('is read-only without the update permission', async () => {
    const { loadDealer, root, save } = await render(EDIT, { permissions: ['dealers:read'] });
    await loadDealer();
    expect(root.querySelector('.note')).not.toBeNull();
    expect(root.textContent).toContain('DEALERS.FORM.READ_ONLY');
    expect(save()).toBeNull();
    expect(root.querySelector<HTMLInputElement>('form input')!.disabled).toBe(true);
    expect(root.querySelector('.page-actions a')?.textContent).toBe('DEALERS.FORM.BACK');
  });

  it('shows the load error with a link back, and retries', async () => {
    const { loadDealer, root, view } = await render(EDIT);
    await loadDealer(null);
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(root.querySelector('p a')?.getAttribute('href')).toBe('/dealers');
    root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
    await view();
    backend().expectOne(`${URL}/${ID}`).flush({ data: fakeDealer() });
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  it('reports an unexpected failure generically', async () => {
    const { root, view } = await render(EDIT, {}, [
      { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
    ]);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});

describe('DealerForm: custom prices', () => {
  it('shows the section to who manages the activations, and only then', async () => {
    const { loadDealer, root, view } = await render(`/dealers/${ID}`, {
      permissions: [...ALL, 'activations:manage'],
    });
    await loadDealer();
    expect(root.querySelector('fc-dealer-price-overrides')).not.toBeNull();
    // The section reads the price list and the overrides of this dealer.
    const reads = backend().match(() => true);
    expect(reads.map((request) => request.request.url).sort()).toEqual([
      `${URL}/${ID}/price-overrides`,
      `${API}/v1/settings/price-list`,
    ]);
    await view();
  });

  it('does not show it, nor read the prices, without the permission', async () => {
    const { loadDealer, root } = await render(`/dealers/${ID}`);
    await loadDealer();
    expect(root.querySelector('fc-dealer-price-overrides')).toBeNull();
  });
});

describe('DealerForm: e-invoicing account', () => {
  it('shows the section "Integrazioni" with the account of the dealer to who manages the accounts', async () => {
    const { loadDealer, root, view } = await render(`/dealers/${ID}`, {
      permissions: [...ALL, 'eInvoicingAccounts:manage'],
    });
    await loadDealer();
    expect(root.querySelector('#integrations-heading')?.textContent).toContain(
      'DEALERS.INTEGRATIONS',
    );
    expect(root.querySelector('fc-einvoicing-account-card')).not.toBeNull();
    expect(
      root.querySelector('fc-einvoicing-account-card [role=heading]')?.getAttribute('aria-level'),
    ).toBe('3');
    backend()
      .expectOne(`${URL}/${ID}/integrations/aruba`)
      .flush({ data: { hub: `aruba__${ID}`, configured: false } }, { headers: { ETag: '"v1"' } });
    await view();
  });

  it('does not show it, nor read the account, without the permission', async () => {
    const { loadDealer, root } = await render(`/dealers/${ID}`);
    await loadDealer();
    expect(root.querySelector('fc-einvoicing-account-card')).toBeNull();
    expect(root.querySelector('#integrations-heading')).toBeNull();
  });
});
