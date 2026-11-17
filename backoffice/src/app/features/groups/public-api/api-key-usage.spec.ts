import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { apiBaseUrlInterceptor } from '../../../core/api/api-base-url.interceptor';
import { AppConfig } from '../../../core/config/app-config';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../../testing/api';
import { fakeUsage } from '../../../../testing/api-keys';
import { I18nService } from '../../../core/i18n/i18n.service';
import { addUtcDays, utcDay } from './api-key.types';
import { ApiKeyUsagePanel } from './api-key-usage';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const KEY = '6650c0a1b2c3d4e5f6a7b8c9'; // gitleaks:allow (fake test value)
const PATH = `${API}/v1/groups/${GROUP}/api-keys/${KEY}/usage`;

const TODAY = utcDay(new Date());
const THIRTY = utcDay(addUtcDays(new Date(), -29));

async function render(raw = false) {
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
  const fixture = TestBed.createComponent(ApiKeyUsagePanel);
  fixture.componentRef.setInput('groupId', GROUP);
  fixture.componentRef.setInput('keyId', KEY);
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  fixture.detectChanges();
  const requests = () => backend().match((r) => r.url === PATH);
  const field = (label: string) => {
    const element = [...root.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === label,
    )!;
    return root.querySelector<HTMLInputElement>(`#${element.htmlFor}`)!;
  };
  const type = async (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  return { fixture, root, view, requests, type, submit, field };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ApiKeyUsagePanel', () => {
  it('asks for the last 30 days and shows totals, daily totals and rows per route', async () => {
    const { root, view, requests } = await render();
    await view();
    const [request] = requests();
    expect(request.request.params.get('from')).toBe(THIRTY);
    expect(request.request.params.get('to')).toBe(TODAY);
    request.flush({ data: fakeUsage() });
    await view();
    const tables = root.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    const dayRows = [...tables[0].querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td, th')].map((c) => c.textContent?.trim()),
    );
    expect(dayRows).toEqual([
      ['2026-11-16', '8', '0', '1', '0', '0'],
      ['2026-11-17', '10', '2', '0', '1', '0'],
    ]);
    const routeRows = tables[1].querySelectorAll('tbody tr');
    expect(routeRows).toHaveLength(3);
    expect(routeRows[1].textContent).toContain('GET /public/v1/places');
    expect(root.querySelector('.totals')?.textContent).toContain('18');
    expect(root.querySelector('h3')?.textContent).toContain('"from":"2026-10-19"');
  });

  it('shows the empty state for a key without requests', async () => {
    const { root, view, requests } = await render();
    await view();
    requests()[0].flush({
      data: fakeUsage({
        totals: { calls: 0, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0 },
        rows: [],
      }),
    });
    await view();
    expect(root.textContent).toContain('PUBLIC_API.USAGE.EMPTY');
  });

  it('asks again for the chosen range', async () => {
    const { view, requests, type, submit } = await render();
    await view();
    requests()[0].flush({ data: fakeUsage() });
    await view();
    await type('PUBLIC_API.USAGE.FROM', '2026-09-01');
    await type('PUBLIC_API.USAGE.TO', '2026-09-30');
    // Nothing is asked until the user confirms.
    expect(requests()).toHaveLength(0);
    await submit();
    const [request] = requests();
    expect(request.request.params.get('from')).toBe('2026-09-01');
    expect(request.request.params.get('to')).toBe('2026-09-30');
    request.flush({ data: fakeUsage({ from: '2026-09-01', to: '2026-09-30' }) });
    await view();
  });

  it.each([
    ['2026-02-30', TODAY, 'PUBLIC_API.USAGE.RANGE_FORMAT', 'PUBLIC_API.USAGE.FROM'],
    [THIRTY, 'ieri', 'PUBLIC_API.USAGE.RANGE_FORMAT', 'PUBLIC_API.USAGE.TO'],
    ['2999-01-02', '2999-01-01', 'PUBLIC_API.USAGE.RANGE_ORDER', 'PUBLIC_API.USAGE.FROM'],
    ['2026-01-01', '2026-11-17', 'PUBLIC_API.USAGE.RANGE_TOO_LONG', 'PUBLIC_API.USAGE.FROM'],
  ])('refuses the range %s to %s without asking', async (from, to, message, label) => {
    const { root, view, requests, type, submit, field } = await render();
    await view();
    requests()[0].flush({ data: fakeUsage() });
    await view();
    await type('PUBLIC_API.USAGE.FROM', from);
    await type('PUBLIC_API.USAGE.TO', to);
    // No message before the first attempt.
    expect(root.querySelector('.error:not(:empty)')).toBeNull();
    await submit();
    expect(requests()).toHaveLength(0);
    expect(field(label).getAttribute('aria-invalid')).toBe('true');
    expect(root.textContent).toContain(message);
  });

  it('shows a failure with its request id and retries', async () => {
    const { root, view, requests } = await render();
    await view();
    requests()[0].flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.FORBIDDEN');
    expect(root.querySelector('table')).toBeNull();
    root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
    await view();
    requests()[0].flush({ data: fakeUsage() });
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  it('reports a failure that is not an API error generically', async () => {
    const { root, view, requests } = await render();
    await view();
    requests()[0].error(new ProgressEvent('error'));
    await view();
    expect(root.querySelector('fc-error-state')).not.toBeNull();
  });

  it('shows a generic message when the failure is not from the API', async () => {
    const { root, view, requests } = await render(true);
    await view();
    requests()[0].flush('x', { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });
});
