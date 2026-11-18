import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { errorOf, findControl, submitForm, typeInto } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DealerPrices, PriceList } from '../price-list/price-list.types';
import { DealerPriceOverrides } from './dealer-price-overrides';

const ID = '665f1c2e9b1d4a0012ab34d1';
const LIST_URL = `${API}/v1/settings/price-list`;
const OVERRIDES_URL = `${API}/v1/dealers/${ID}/price-overrides`;
const SERVICES = {
  extraDesk: 500,
  kiosk: 1500,
  api: 500,
  tobaccos: 1300,
  reservationWidget: 1000,
  floodPay: 1500,
  arubaEInvoicing: 0,
  reserveWithGoogle: 0,
  bizerba: 0,
};
const LIST: PriceList = { plans: { basic: 2000, advanced: 3000 }, services: SERVICES };
const PRICES: DealerPrices = {
  overrides: { plans: { basic: 1800, professional: 4500 }, services: { kiosk: 1000 } },
  effective: LIST,
};
const PLAN = (key: string) => `DEALERS.PRICES.PLAN ${JSON.stringify({ plan: key })}`;
const RESTORE = (name: string) => `DEALERS.PRICES.RESTORE_LABEL ${JSON.stringify({ name })}`;

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
  const fixture = TestBed.createComponent(DealerPriceOverrides);
  fixture.componentRef.setInput('dealerId', ID);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = fixture as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const load = async (prices: DealerPrices = PRICES, list: PriceList = LIST, etag = '"o1"') => {
    await view();
    backend()
      .expectOne(LIST_URL)
      .flush({ data: list }, { headers: { ETag: '"l1"' } });
    backend()
      .expectOne(OVERRIDES_URL)
      .flush({ data: prices }, { headers: { ETag: etag } });
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
    ) as HTMLButtonElement;
  const value = (label: string) => findControl(scope, label).value;
  const type = (label: string, text: string) => typeInto(scope, label, text);
  const save = async () => {
    await submitForm(scope);
    await view();
  };
  const fail = async (
    status: number,
    code: string,
    details?: { field: string; issue: string }[],
  ) => {
    backend()
      .expectOne({ method: 'PUT', url: OVERRIDES_URL })
      .flush(errorBody(code, details), { status, statusText: 'x' });
    await view();
  };
  return { fixture, root, view, load, button, value, type, save, fail, scope };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('DealerPriceOverrides: reading', () => {
  it('shows the plans of the list and of the overrides, and the override of each service', async () => {
    const { root, view, load, value } = await render();
    await view();
    expect(root.textContent).toContain('COMMON.LOADING');
    await load();
    expect(value(PLAN('advanced'))).toBe('');
    expect(value(PLAN('basic'))).toBe('18,00');
    expect(value(PLAN('professional'))).toBe('45,00');
    expect(value('PRICE_SERVICE.KIOSK')).toBe('10,00');
    expect(value('PRICE_SERVICE.API')).toBe('');
    const hints = root.textContent as string;
    expect(hints).toContain('DEALERS.PRICES.DEFAULT');
    // A plan the list does not price has no default.
    expect(hints).toContain('DEALERS.PRICES.NO_DEFAULT');
  });

  it('keeps showing the loading while one of the two reads is still to come', async () => {
    const { root, view } = await render();
    await view();
    backend().expectOne(OVERRIDES_URL).flush({ data: PRICES });
    await view();
    expect(root.textContent).toContain('COMMON.LOADING');
    expect(root.querySelector('form')).toBeNull();
    backend().expectOne(LIST_URL).flush({ data: LIST });
    await view();
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('shows a dealer with no overrides and a list with no plans', async () => {
    const { root, load, value } = await render();
    await load({ overrides: {}, effective: LIST }, { plans: {}, services: SERVICES });
    expect(root.textContent).toContain('DEALERS.PRICES.NO_PLANS');
    expect(value('PRICE_SERVICE.KIOSK')).toBe('');
  });

  it('shows the failure of either read, and reads both again on retry', async () => {
    const { root, view, button, load } = await render();
    await view();
    backend()
      .expectOne(LIST_URL)
      .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    backend().expectOne(OVERRIDES_URL).flush({ data: PRICES });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain(
      'ERRORS.API.INTERNAL_ERROR',
    );
    button('COMMON.RETRY').click();
    await load();
    expect(root.querySelector('form')).not.toBeNull();
  });

  it('shows the failure of the overrides', async () => {
    const { root, view } = await render();
    await view();
    backend().expectOne(LIST_URL).flush({ data: LIST });
    backend()
      .expectOne(OVERRIDES_URL)
      .flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.NOT_FOUND');
  });

  it('reports an unexpected failure generically', async () => {
    const { root, view } = await render(false);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});

describe('DealerPriceOverrides: saving', () => {
  it('sends only the prices that are set, with the version', async () => {
    const { load, type, save, view } = await render();
    await load();
    await type(PLAN('advanced'), '29,9');
    await save();
    const request = backend().expectOne({ method: 'PUT', url: OVERRIDES_URL });
    expect(request.request.headers.get('If-Match')).toBe('"o1"');
    expect(request.request.body).toEqual({
      plans: { advanced: 2990, basic: 1800, professional: 4500 },
      services: { kiosk: 1000 },
    });
    request.flush({ data: PRICES }, { headers: { ETag: '"o2"' } });
    await view();
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .map((t) => `${t.kind}: ${t.message}`),
    ).toEqual(['success: DEALERS.PRICES.SAVED']);
  });

  it('restores the default of a price by emptying it, and leaves out what is empty', async () => {
    const { load, button, value, save, view } = await render();
    await load();
    expect(button(RESTORE(PLAN('advanced'))).disabled).toBe(true);
    button(RESTORE('PRICE_SERVICE.KIOSK')).click();
    await view();
    expect(value('PRICE_SERVICE.KIOSK')).toBe('');
    await save();
    const first = backend().expectOne({ method: 'PUT', url: OVERRIDES_URL });
    expect(first.request.body).toEqual({ plans: { basic: 1800, professional: 4500 } });
    first.flush({ data: { overrides: { plans: PRICES.overrides.plans }, effective: LIST } });
    await view();
    button(RESTORE(PLAN('basic'))).click();
    button(RESTORE(PLAN('professional'))).click();
    await view();
    await save();
    const second = backend().expectOne({ method: 'PUT', url: OVERRIDES_URL });
    expect(second.request.body).toEqual({});
    second.flush({ data: { overrides: {}, effective: LIST } });
    await view();
    expect(value(PLAN('basic'))).toBe('');
  });

  it('refuses a price that is not an amount, and shows the error when the user leaves the field', async () => {
    const { scope, load, type, save, view } = await render();
    await load();
    const plan = await type(PLAN('advanced'), 'abc');
    const service = await type('PRICE_SERVICE.API', '100001');
    expect(errorOf(scope, PLAN('advanced'))).toBe('');
    plan.dispatchEvent(new Event('blur'));
    service.dispatchEvent(new Event('blur'));
    await view();
    expect(errorOf(scope, PLAN('advanced'))).not.toBe('');
    expect(errorOf(scope, 'PRICE_SERVICE.API')).not.toBe('');
    await save();
    backend().expectNone({ method: 'PUT', url: OVERRIDES_URL });
  });

  it('asks to reload when the prices changed meanwhile, then reads both again', async () => {
    const { root, load, save, fail, button } = await render();
    await load();
    await save();
    await fail(412, 'PRECONDITION_FAILED');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('DEALERS.PRICES.STALE');
    button('DEALERS.PRICES.RELOAD').click();
    await load({ overrides: {}, effective: LIST }, LIST, '"o9"');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('puts a refused price on its field', async () => {
    const { scope, root, load, save, fail } = await render();
    await load();
    await save();
    await fail(422, 'VALIDATION_ERROR', [
      { field: 'plans.basic', issue: 'maximum' },
      { field: 'services.kiosk', issue: 'type' },
    ]);
    expect(errorOf(scope, PLAN('basic'))).not.toBe('');
    expect(errorOf(scope, 'PRICE_SERVICE.KIOSK')).not.toBe('');
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it.each([
    [422, 'VALIDATION_ERROR', 'ERRORS.API.VALIDATION_ERROR'],
    [500, 'INTERNAL_ERROR', 'ERRORS.API.INTERNAL_ERROR'],
  ])('shows a message for a %d that belongs to no field', async (status, code, message) => {
    const { root, load, save, fail } = await render();
    await load();
    await save();
    await fail(status, code, status === 422 ? [{ field: 'unknown', issue: 'unknown' }] : undefined);
    expect(root.querySelector('fc-form-error')?.textContent).toContain(message);
  });
});
