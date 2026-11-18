import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { errorOf, findControl, submitForm, typeInto } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PriceListPage } from './price-list-page';
import { PriceList } from './price-list.types';

const URL_ = `${API}/v1/settings/price-list`;
const LIST: PriceList = {
  plans: { basic: 2000, advanced: 3000 },
  services: {
    extraDesk: 500,
    kiosk: 1500,
    api: 500,
    tobaccos: 1300,
    reservationWidget: 1000,
    floodPay: 1500,
    arubaEInvoicing: 0,
    reserveWithGoogle: 0,
    bizerba: 0,
  },
};
const KEY = (n: number) => `PRICE_LIST.PLAN_KEY ${JSON.stringify({ number: n })}`;
const PRICE = (n: number) => `PRICE_LIST.PLAN_PRICE ${JSON.stringify({ number: n })}`;

async function render(withApi = true) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(withApi ? [] : [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', permissions: ['activations:manage'] });
  const fixture = TestBed.createComponent(PriceListPage);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const load = async (list: PriceList = LIST, etag = '"v1"') => {
    await view();
    backend()
      .expectOne(URL_)
      .flush({ data: list }, { headers: { ETag: etag } });
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  const value = (label: string) => findControl(fixture as ComponentFixture<unknown>, label).value;
  const type = (label: string, text: string) =>
    typeInto(fixture as ComponentFixture<unknown>, label, text);
  const save = async () => {
    await submitForm(fixture as ComponentFixture<unknown>);
    await view();
  };
  const click = async (text: string) => {
    button(text).click();
    await view();
  };
  const fail = async (
    status: number,
    code: string,
    details?: { field: string; issue: string }[],
  ) => {
    backend()
      .expectOne({ method: 'PUT', url: URL_ })
      .flush(errorBody(code, details), { status, statusText: 'x' });
    await view();
  };
  return { fixture, root, view, load, button, value, type, save, click, fail };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('PriceListPage: reading', () => {
  it('shows the plans sorted by key and every service, in euro', async () => {
    const { root, view, load, value } = await render();
    await view();
    expect(root.textContent).toContain('COMMON.LOADING');
    await load();
    expect(value(KEY(1))).toBe('advanced');
    expect(value(PRICE(1))).toBe('30,00');
    expect(value(KEY(2))).toBe('basic');
    expect(value(PRICE(2))).toBe('20,00');
    expect(value('PRICE_SERVICE.EXTRA_DESK')).toBe('5,00');
    expect(value('PRICE_SERVICE.KIOSK')).toBe('15,00');
    expect(value('PRICE_SERVICE.BIZERBA')).toBe('0,00');
  });

  it('shows the failure of the read, and reads again on retry', async () => {
    const { root, view, button, load } = await render();
    await view();
    backend().expectOne(URL_).flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain(
      'ERRORS.API.INTERNAL_ERROR',
    );
    button('COMMON.RETRY').click();
    await load();
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('reports an unexpected failure to read generically', async () => {
    const { root, view } = await render(false);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});

describe('PriceListPage: saving', () => {
  it('sends the prices in cents with the version and keeps the new version', async () => {
    const { load, type, save, view } = await render();
    await load();
    await type(PRICE(2), '21,5');
    await type('PRICE_SERVICE.BIZERBA', '3');
    await save();
    const request = backend().expectOne({ method: 'PUT', url: URL_ });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual({
      plans: { advanced: 3000, basic: 2150 },
      services: { ...LIST.services, bizerba: 300 },
    });
    request.flush({ data: LIST }, { headers: { ETag: '"v2"' } });
    await view();
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .map((t) => `${t.kind}: ${t.message}`),
    ).toEqual(['success: PRICE_LIST.SAVED']);
    await save();
    const next = backend().expectOne({ method: 'PUT', url: URL_ });
    expect(next.request.headers.get('If-Match')).toBe('"v2"');
    next.flush({ data: LIST }, { headers: { ETag: '"v3"' } });
  });

  it('adds and removes plans', async () => {
    const { load, click, type, save, value, button } = await render();
    await load();
    await click('PRICE_LIST.ADD_PLAN');
    await type(KEY(3), 'professional');
    await type(PRICE(3), '40');
    await click(`PRICE_LIST.REMOVE`);
    expect(value(KEY(1))).toBe('basic');
    expect(button('PRICE_LIST.REMOVE')).toBeDefined();
    await save();
    const request = backend().expectOne({ method: 'PUT', url: URL_ });
    expect(request.request.body.plans).toEqual({ basic: 2000, professional: 4000 });
    request.flush({ data: LIST }, { headers: { ETag: '"v2"' } });
  });

  it('does not offer more plans than the backend takes', async () => {
    const plans = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, 100]));
    const { load, button } = await render();
    await load({ plans, services: LIST.services });
    expect(button('PRICE_LIST.ADD_PLAN').disabled).toBe(true);
  });

  it('refuses a plan without key, with a wrong key, a repeated key, or a wrong price', async () => {
    const { fixture, load, click, type, save } = await render();
    await load();
    await click('PRICE_LIST.ADD_PLAN');
    await click('PRICE_LIST.ADD_PLAN');
    await type(KEY(3), 'bad key!');
    await type(KEY(4), 'basic');
    await type(PRICE(3), '12,345');
    await type(PRICE(4), '');
    await type('PRICE_SERVICE.KIOSK', '100001');
    await save();
    backend().expectNone({ method: 'PUT', url: URL_ });
    const scope = fixture as ComponentFixture<unknown>;
    expect(errorOf(scope, KEY(3))).not.toBe('');
    expect(errorOf(scope, KEY(4))).not.toBe('');
    expect(errorOf(scope, KEY(2))).not.toBe('');
    expect(errorOf(scope, PRICE(3))).not.toBe('');
    expect(errorOf(scope, PRICE(4))).not.toBe('');
    expect(errorOf(scope, 'PRICE_SERVICE.KIOSK')).not.toBe('');
    await type(KEY(3), '');
    await save();
    expect(errorOf(scope, KEY(3))).not.toBe('');
  });

  it('shows the error of a field once the user leaves it', async () => {
    const { fixture, load, type, view } = await render();
    await load();
    const scope = fixture as ComponentFixture<unknown>;
    for (const [label, wrong] of [
      [KEY(1), ''],
      [PRICE(1), 'abc'],
      ['PRICE_SERVICE.KIOSK', 'abc'],
    ]) {
      const control = await type(label, wrong);
      expect(errorOf(scope, label)).toBe('');
      control.dispatchEvent(new Event('blur'));
      await view();
      expect(errorOf(scope, label)).not.toBe('');
    }
  });

  it('asks to reload when the list changed meanwhile, then reads it again', async () => {
    const { root, load, save, fail, button, view } = await render();
    await load();
    await save();
    await fail(412, 'PRECONDITION_FAILED');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('PRICE_LIST.STALE');
    button('PRICE_LIST.RELOAD').click();
    await load({ ...LIST, plans: { basic: 1 } }, '"v9"');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    await view();
  });

  it('puts a refused price on its field', async () => {
    const { fixture, load, save, fail } = await render();
    await load();
    await save();
    await fail(422, 'VALIDATION_ERROR', [
      { field: 'plans.basic', issue: 'maximum' },
      { field: 'services.kiosk', issue: 'type' },
    ]);
    const scope = fixture as ComponentFixture<unknown>;
    expect(errorOf(scope, PRICE(2))).not.toBe('');
    expect(errorOf(scope, 'PRICE_SERVICE.KIOSK')).not.toBe('');
    expect(fixture.nativeElement.querySelector('fc-form-error')).toBeNull();
  });

  it('shows a message for a refusal that belongs to no field, and for any other failure', async () => {
    const { root, load, save, fail } = await render();
    await load();
    await save();
    await fail(422, 'VALIDATION_ERROR', [{ field: 'plans', issue: 'tooMany' }]);
    expect(root.querySelector('fc-form-error')?.textContent).toContain(
      'ERRORS.API.VALIDATION_ERROR',
    );
    await save();
    await fail(500, 'INTERNAL_ERROR');
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
  });
});
