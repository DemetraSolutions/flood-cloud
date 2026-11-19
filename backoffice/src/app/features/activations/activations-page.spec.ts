import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ActivationsPage } from './activations-page';
import { ActivationRow, ActivationsSummary, currentMonth } from './activations.types';

const LIST = `${API}/v1/activations`;
const BASE = `${API}/v1/activations/renewal-bases/2026`;
const CLOSURE = `${API}/v1/activations/closures/2026-06`;
const NBSP = /\s/g;

function row(overrides: Partial<ActivationRow> = {}): ActivationRow {
  return {
    dealer: { id: '665f1c2e9b1d4a0012ab34d1', name: 'Dealer Nord' },
    status: 'open',
    activations: {
      activityMonth: '2026-05',
      places: 3,
      monthlyCents: 6000,
      amountCents: 42000,
      projection12Cents: 72000,
    },
    renewals: {
      year: 2026,
      places: 10,
      annualCents: 240000,
      instalmentCents: 20000,
      frozen: false,
    },
    totalCents: 62000,
    anomalies: 0,
    ...overrides,
  };
}

const NONE_ROW = row({
  dealer: { id: null, name: 'Senza rivenditore' },
  anomalies: 2,
  totalCents: 1000,
});

function summary(
  rows: ActivationRow[] = [row(), NONE_ROW],
  frozen = false,
  status: 'open' | 'closed' = 'open',
): ActivationsSummary {
  return {
    status,
    data: rows,
    totals: {
      activations: { places: 4, amountCents: 50000, projection12Cents: 80000 },
      renewals: { instalmentCents: 25000 },
      totalCents: 75000,
      anomalies: rows.some((r) => r.anomalies > 0) ? 2 : 0,
    },
    renewalBase: { year: 2026, frozen },
  };
}

const closedRows = () => [row({ status: 'closed' }), { ...NONE_ROW, status: 'closed' as const }];

async function render(
  url = '/activations?month=2026-06',
  profile: Partial<Profile> = {},
  withApi = true,
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(withApi ? [] : [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]),
      provideRouter(
        [
          { path: 'activations', component: ActivationsPage },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    role: 'PSA',
    groupId: null,
    group: null,
    permissions: ['activations:read', 'activations:manage'],
    ...profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST);
  const flush = async (body: ActivationsSummary = summary()) => {
    request().flush(body);
    await view();
  };
  const rows = () =>
    [...root.querySelectorAll('tbody tr, tfoot tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((c) => c.textContent?.trim().replace(NBSP, ' ')),
    );
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  const monthField = () => root.querySelector<HTMLInputElement>('input[type=month]')!;
  return {
    root,
    view,
    request,
    flush,
    rows,
    button,
    dialogButton,
    toasts,
    monthField,
    router: TestBed.inject(Router),
  };
}

describe('ActivationsPage', () => {
  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  describe('reading', () => {
    it('asks for the month of the URL and explains what it contains', async () => {
      const { root, request, view } = await render();
      const req = request();
      expect(req.request.params.get('month')).toBe('2026-06');
      req.flush(summary());
      await view();
      expect(root.querySelector('.explanation')?.textContent).toBe(
        'ACTIVATIONS.EXPLANATION {"invoice":"giugno 2026","activity":"maggio 2026","month":"giugno","year":2026}',
      );
      expect(root.querySelector<HTMLInputElement>('input[type=month]')?.value).toBe('2026-06');
    });

    it('explains January as the invoice of the December activations', async () => {
      const { root, flush } = await render('/activations?month=2027-01');
      await flush();
      expect(root.querySelector('.explanation')?.textContent).toContain(
        '"activity":"dicembre 2026","month":"gennaio","year":2027',
      );
    });

    it.each(['/activations', '/activations?month=garbage'])(
      'starts from the current month when the URL has none or a wrong one (%s)',
      async (url) => {
        const { request, view } = await render(url);
        const req = request();
        expect(req.request.params.get('month')).toBe(currentMonth());
        req.flush(summary());
        await view();
      },
    );

    it('shows a row per dealer and the totals, in euro', async () => {
      const { rows, flush, root } = await render();
      expect(root.textContent).toContain('COMMON.LOADING');
      await flush();
      expect(rows()).toEqual([
        [
          'Dealer Nord',
          '3',
          '420,00 €',
          '200,00 €',
          '620,00 €',
          '720,00 €',
          'ACTIVATIONS.STATUS.OPEN',
          '—',
        ],
        [
          'Senza rivenditore',
          '3',
          '420,00 €',
          '200,00 €',
          '10,00 €',
          '720,00 €',
          'ACTIVATIONS.STATUS.OPEN',
          'ACTIVATIONS.ANOMALIES {"count":2}',
        ],
        [
          'ACTIVATIONS.TOTALS',
          '4',
          '500,00 €',
          '250,00 €',
          '750,00 €',
          '800,00 €',
          '',
          'ACTIVATIONS.ANOMALIES {"count":2}',
        ],
      ]);
    });

    it('shows a closed month and no anomalies in the totals', async () => {
      const { rows, flush } = await render();
      await flush(summary([row({ status: 'closed' })]));
      expect(rows()[0][6]).toBe('ACTIVATIONS.STATUS.CLOSED');
      expect(rows()[1][7]).toBe('—');
    });

    it('opens the statement of a dealer from its row, and of the groups without one', async () => {
      const { root, flush } = await render();
      await flush();
      const links = [...root.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'));
      expect(links).toEqual([
        '/activations/665f1c2e9b1d4a0012ab34d1?month=2026-06',
        '/activations/none?month=2026-06',
      ]);
    });

    it('shows an empty month', async () => {
      const { root, flush } = await render();
      await flush(summary([]));
      expect(root.querySelector('fc-empty-state')).not.toBeNull();
      expect(root.querySelector('table')).toBeNull();
    });

    it('shows the failure of the read, and reads again on retry', async () => {
      const { root, request, view, button, flush } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain(
        'ERRORS.API.INTERNAL_ERROR',
      );
      button('COMMON.RETRY').click();
      await view();
      await flush();
      expect(root.querySelector('table')).not.toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render('/activations?month=2026-06', {}, false);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('tabs', () => {
    it('shows the invoices by default and the detail on the tab of the URL', async () => {
      const { root, view, flush, request, router } = await render();
      await flush();
      expect(root.querySelector('#activations-panel-invoices')).not.toBeNull();
      root.querySelector<HTMLElement>('#activations-tab-detail')!.click();
      await view();
      expect(router.url).toContain('tab=detail');
      expect(root.querySelector('#activations-panel-detail fc-activations-detail')).not.toBeNull();
      expect(root.querySelector('table')).toBeNull();
      const lines = backend().expectOne((r) => r.url === `${API}/v1/activations/lines`);
      expect(lines.request.params.get('from')).toBe(currentMonth());
      lines.flush({
        data: [],
        page: { limit: 50, next: null },
        totals: { places: 0, monthlyCents: 0, amountCents: 0, projection12Cents: 0, anomalies: 0 },
        from: '',
        to: '',
      });
      backend()
        .match((r) => r.url === `${API}/v1/dealers`)
        .forEach((r) => r.flush({ data: [], page: { limit: 100, next: null } }));
      await view();
      root.querySelector<HTMLElement>('#activations-tab-invoices')!.click();
      await view();
      const again = request();
      expect(again.request.params.get('month')).toBe('2026-06');
      again.flush(summary());
      await view();
    });

    it('falls back to the invoices on a wrong tab', async () => {
      const { root, flush } = await render('/activations?month=2026-06&tab=bad');
      await flush();
      expect(root.querySelector('#activations-panel-invoices')).not.toBeNull();
    });
  });

  describe('month', () => {
    it('reads another month when a valid one is chosen, and ignores a partial one', async () => {
      const { monthField, view, flush, request, router } = await render();
      await flush();
      monthField().value = '2026-7';
      monthField().dispatchEvent(new Event('input'));
      await view();
      expect(router.url).toBe('/activations?month=2026-06');
      monthField().value = '2026-07';
      monthField().dispatchEvent(new Event('input'));
      await view();
      expect(router.url).toBe('/activations?month=2026-07');
      const req = request();
      expect(req.request.params.get('month')).toBe('2026-07');
      req.flush(summary());
      await view();
    });
  });

  describe('a dealer', () => {
    it('sees the page without the actions of the platform administrator', async () => {
      const { root, flush } = await render('/activations?month=2026-06', {
        role: 'D',
        permissions: ['activations:read'],
      });
      await flush(summary([row()]));
      expect(root.querySelector('table')).not.toBeNull();
      expect(root.querySelector('.actions')).toBeNull();
    });
  });

  describe('actions', () => {
    it('freezes the renewal base after a confirmation, and reads the month again', async () => {
      const { view, flush, button, dialogButton, root, toasts } = await render();
      await flush();
      expect(button('ACTIVATIONS.ACTION.CLOSE.LABEL').disabled).toBe(true);
      expect(root.querySelector('.actions .note')?.textContent).toContain(
        'ACTIVATIONS.BASE_NOT_FROZEN {"year":2026}',
      );
      button('ACTIVATIONS.ACTION.FREEZE.LABEL {"year":2026}').click();
      await view();
      expect(root.querySelector('dialog[open]')?.textContent).toContain(
        'ACTIVATIONS.ACTION.FREEZE.TITLE',
      );
      expect(root.querySelector('dialog[open]')?.textContent).toContain(
        'ACTIVATIONS.ACTION.FREEZE.MESSAGE {"year":2026,"month":"giugno 2026"}',
      );
      dialogButton('ACTIVATIONS.ACTION.FREEZE.CONFIRM').click();
      await view();
      backend().expectOne({ method: 'PUT', url: BASE }).flush({ data: {} });
      await view();
      expect(toasts()).toEqual([
        'success: ACTIVATIONS.ACTION.FREEZE.DONE {"year":2026,"month":"giugno 2026"}',
      ]);
      expect(root.querySelector('dialog[open]')).toBeNull();
      await flush(summary([row()], true));
      expect(button('ACTIVATIONS.ACTION.UNFREEZE.LABEL {"year":2026}')).toBeDefined();
      expect(button('ACTIVATIONS.ACTION.CLOSE.LABEL').disabled).toBe(false);
      expect(root.querySelector('.actions .note')).toBeNull();
    });

    it('unfreezes the base', async () => {
      const { view, flush, button, dialogButton } = await render();
      await flush(summary([row()], true));
      button('ACTIVATIONS.ACTION.UNFREEZE.LABEL {"year":2026}').click();
      await view();
      dialogButton('ACTIVATIONS.ACTION.UNFREEZE.CONFIRM').click();
      await view();
      backend()
        .expectOne({ method: 'DELETE', url: BASE })
        .flush(null, { status: 204, statusText: 'x' });
      await view();
      await flush(summary([row()], false));
    });

    it('closes the month, then offers to reopen it', async () => {
      const { view, flush, button, dialogButton, root } = await render();
      await flush(summary([row()], true));
      button('ACTIVATIONS.ACTION.CLOSE.LABEL').click();
      await view();
      expect(root.querySelector('dialog[open]')?.textContent).toContain(
        'ACTIVATIONS.ACTION.CLOSE.MESSAGE {"year":2026,"month":"giugno 2026"}',
      );
      dialogButton('ACTIVATIONS.ACTION.CLOSE.CONFIRM').click();
      await view();
      backend().expectOne({ method: 'PUT', url: CLOSURE }).flush({ data: {} });
      await view();
      await flush(summary(closedRows(), true, 'closed'));
      expect(root.querySelector('.actions .note')).toBeNull();
      button('ACTIVATIONS.ACTION.REOPEN.LABEL').click();
      await view();
      dialogButton('ACTIVATIONS.ACTION.REOPEN.CONFIRM').click();
      await view();
      backend()
        .expectOne({ method: 'DELETE', url: CLOSURE })
        .flush(null, { status: 204, statusText: 'x' });
      await view();
      await flush(summary([row()], true));
      expect(button('ACTIVATIONS.ACTION.CLOSE.LABEL')).toBeDefined();
    });

    it('does nothing when the confirmation is cancelled', async () => {
      const { view, flush, button, dialogButton, root } = await render();
      await flush(summary([row()], true));
      button('ACTIVATIONS.ACTION.CLOSE.LABEL').click();
      await view();
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(root.querySelector('dialog[open]')).toBeNull();
    });

    it.each([
      ['baseNotFrozen', 'ACTIVATIONS.CONFLICT.BASE_NOT_FROZEN'],
      ['somethingNew', 'ACTIVATIONS.CONFLICT.GENERIC'],
    ])('tells a refusal (%s) in words', async (issue, message) => {
      const { view, flush, button, dialogButton, root } = await render();
      await flush(summary([row()], true));
      button('ACTIVATIONS.ACTION.CLOSE.LABEL').click();
      await view();
      dialogButton('ACTIVATIONS.ACTION.CLOSE.CONFIRM').click();
      await view();
      backend()
        .expectOne({ method: 'PUT', url: CLOSURE })
        .flush(errorBody('CONFLICT', [{ field: 'month', issue }]), {
          status: 409,
          statusText: 'x',
        });
      await view();
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(message);
      expect(root.querySelector('dialog[open]')).toBeNull();
      // Starting another action clears the notice.
      button('ACTIVATIONS.ACTION.CLOSE.LABEL').click();
      await view();
      expect(root.querySelector('[role="alert"]')).toBeNull();
    });

    it('reports any other failure with the central message', async () => {
      const { view, flush, button, dialogButton, root } = await render();
      await flush(summary([row()], false));
      button('ACTIVATIONS.ACTION.FREEZE.LABEL {"year":2026}').click();
      await view();
      dialogButton('ACTIVATIONS.ACTION.FREEZE.CONFIRM').click();
      await view();
      backend()
        .expectOne({ method: 'PUT', url: BASE })
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(
        'ERRORS.API.INTERNAL_ERROR',
      );
    });

    it('takes the year of the base from the summary', async () => {
      const { view, flush, button, dialogButton } = await render('/activations?month=2027-01');
      await flush({ ...summary([row()], false), renewalBase: { year: 2027, frozen: false } });
      button('ACTIVATIONS.ACTION.FREEZE.LABEL {"year":2027}').click();
      await view();
      dialogButton('ACTIVATIONS.ACTION.FREEZE.CONFIRM').click();
      await view();
      backend()
        .expectOne({ method: 'PUT', url: `${API}/v1/activations/renewal-bases/2027` })
        .flush({ data: {} });
      await view();
      await flush(summary([row()], true));
    });
  });
});
