import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { fakeEntry } from '../../../testing/activity';
import { fakeSecurityAlerts } from '../../../testing/alerts';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext, LAST_GROUP_ID_KEY } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ActivityLogPage, MAX_PERIOD_DAYS } from './activity-log';
import { ActivityEntry } from './activity-log.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ACTOR = '665f1c2e9b1d4a0012ab34ce';
const LIST = `${API}/v1/activity-log`;

const ONE = fakeEntry();
const TWO = fakeEntry({
  id: '665f1c2e9b1d4a0012ab3502',
  category: 'security',
  action: 'auth.loginFailed',
  outcome: 'denied',
  actor: { kind: 'anonymous', id: null, role: null, username: null },
  groupId: null,
  resource: null,
  requestId: null,
});
const THREE = fakeEntry({
  id: '665f1c2e9b1d4a0012ab3503',
  category: 'error',
  action: 'client.error',
  outcome: 'failure',
  actor: { kind: 'user', id: ACTOR, role: 'PA', username: null },
  error: { name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x\n  at a' },
  changes: [{ field: 'status', before: 'a', after: 'b' }],
});
const KEY_ENTRY = fakeEntry({
  id: '665f1c2e9b1d4a0012ab3505',
  category: 'security',
  action: 'apiKey.created',
  outcome: 'success',
  actor: { kind: 'apiKey', id: '6650c0a1b2c3d4e5f6a7b8c9', role: null, username: null },
  resource: { type: 'apiKey', id: '6650c0a1b2c3d4e5f6a7b8c9' },
  metadata: { name: 'Webshop', keyHint: 'AbCdEf' },
});
const FOUR = fakeEntry({
  id: '665f1c2e9b1d4a0012ab3504',
  category: 'data',
  action: 'future.action',
  outcome: 'success',
  actor: { kind: 'system', id: null, role: null, username: null },
});

function page(data: ActivityEntry[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

async function render(
  url = '/activity-log',
  profile: Partial<Profile> = {},
  extra = false,
  alertCount = 0,
) {
  emulateNativeDialog();
  const alerts = fakeSecurityAlerts(alertCount);
  TestBed.configureTestingModule({
    providers: [
      alerts.provider,
      ...provideApiTesting(),
      ...(extra ? [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }] : []),
      provideRouter(
        [{ path: 'activity-log', component: ActivityLogPage }],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ permissions: ['activityLog:read'], ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const router = TestBed.inject(Router);
  const request = () => backend().expectOne((r) => r.url === LIST);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const flush = async (data: ActivityEntry[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index].querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const control = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!;
  const field = (label: string) =>
    root.querySelector<HTMLInputElement | HTMLSelectElement>(
      `#${(control(label) as HTMLLabelElement).htmlFor}`,
    )!;
  const search = () => new URL(router.url, 'http://x').searchParams;
  const params = (req: {
    request: { params: { keys(): string[]; get(k: string): string | null } };
  }) => Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
  return {
    harness,
    root,
    router,
    request,
    flush,
    view,
    rows,
    cells,
    field,
    search,
    params,
    alerts,
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  sessionStorage.clear();
});

async function select(
  ctx: Awaited<ReturnType<typeof render>>,
  label: string,
  value: string,
  type: 'change' | 'input' = 'change',
) {
  const element = ctx.field(label);
  element.value = value;
  element.dispatchEvent(new Event(type));
  await ctx.view();
}

describe('ActivityLogPage', () => {
  describe('content', () => {
    it('requests the first page with the defaults and shows the loading state', async () => {
      const { request, root } = await render();
      const req = request();
      expect(req.request.params.keys()).toEqual(['limit']);
      expect(req.request.params.get('limit')).toBe('25');
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      expect(root.querySelector('h1')?.textContent).toBe('ACTIVITY.TITLE');
      req.flush(page([]));
    });

    it('shows one row per entry with badges, action label, actor, group and resource', async () => {
      const { flush, cells, root } = await render();
      await flush([ONE, TWO, THREE, FOUR]);
      expect(cells(0).slice(0, 8)).toEqual([
        expect.stringMatching(/26/),
        'ACTIVITY.CATEGORY.DATA',
        'ACTIVITY.ACTION.USER_UPDATED',
        'ACTIVITY.OUTCOME.SUCCESS',
        'mario',
        '…ab34a1',
        'user',
        'req-1',
      ]);
      expect(cells(1).slice(1, 8)).toEqual([
        'ACTIVITY.CATEGORY.SECURITY',
        'ACTIVITY.ACTION.AUTH_LOGIN_FAILED',
        'ACTIVITY.OUTCOME.DENIED',
        'ACTIVITY.ACTOR.ANONYMOUS',
        '',
        '',
        '',
      ]);
      expect(cells(2)[4]).toBe('…ab34ce');
      expect(cells(2)[1]).toBe('ACTIVITY.CATEGORY.ERROR');
      expect(cells(3).slice(2, 5)).toEqual([
        'future.action',
        'ACTIVITY.OUTCOME.SUCCESS',
        'ACTIVITY.ACTOR.SYSTEM',
      ]);
      expect(root.querySelector('fc-status-badge[data-tone=danger]')).not.toBeNull();
    });

    it('names an API key as actor and labels its events', async () => {
      const { flush, cells, root } = await render();
      await flush([KEY_ENTRY]);
      expect(cells(0).slice(2, 5)).toEqual([
        'ACTIVITY.ACTION.API_KEY_CREATED',
        'ACTIVITY.OUTCOME.SUCCESS',
        'ACTIVITY.ACTOR.API_KEY {"id":"…a7b8c9"}',
      ]);
      // An actor that is not a user cannot be used as a filter.
      expect(
        root.querySelector('tbody button[aria-label^="ACTIVITY.FILTER_ACTOR_LABEL"]'),
      ).toBeNull();
    });

    it('shows an unnamed user without id as empty', async () => {
      const { flush, cells } = await render();
      await flush([fakeEntry({ actor: { kind: 'user', id: null, role: null, username: null } })]);
      expect(cells(0)[4]).toBe('');
    });

    it('explains an empty list', async () => {
      const { flush, root } = await render();
      await flush([]);
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('ACTIVITY.EMPTY_MESSAGE');
    });

    it('does not show the error category to anybody but the platform admin', async () => {
      const other = await render();
      await other.flush([]);
      expect([...other.field('ACTIVITY.FILTER.CATEGORY').querySelectorAll('option')]).toHaveLength(
        3,
      );
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const admin = await render(undefined, { role: 'PSA' });
      await admin.flush([]);
      expect([...admin.field('ACTIVITY.FILTER.CATEGORY').querySelectorAll('option')]).toHaveLength(
        4,
      );
    });

    it('does not ask for the error category when a non-admin has it in the URL', async () => {
      const { request } = await render('/activity-log?category=error');
      const req = request();
      expect(req.request.params.has('category')).toBe(false);
      req.flush(page([]));
    });
  });

  describe('hidden actors and error actions', () => {
    it('shows only the role of an actor the server hides, without the actor filter', async () => {
      const { flush, cells, root } = await render();
      await flush([
        fakeEntry({ actor: { kind: 'user', id: null, role: 'PSA', username: null }, ip: null }),
      ]);
      expect(cells(0)[4]).toBe('ROLE.PSA');
      expect(root.querySelectorAll('td.actions button')).toHaveLength(1);
    });

    it('offers the error actions only to the platform admin', async () => {
      const other = await render();
      await other.flush([]);
      const values = (ctx: typeof other) =>
        [...ctx.field('ACTIVITY.FILTER.ACTION').querySelectorAll('option')].map((o) => o.value);
      expect(values(other)).not.toContain('client.error');
      expect(values(other)).not.toContain('request.failed');
      expect(values(other)).toContain('user.created');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const admin = await render(undefined, { role: 'PSA' });
      await admin.flush([]);
      expect(values(admin)).toContain('client.error');
      expect(values(admin)).toContain('request.failed');
    });

    it('does not ask for an error action when a non-admin has it in the URL', async () => {
      const { request } = await render('/activity-log?action=client.error');
      const req = request();
      expect(req.request.params.has('action')).toBe(false);
      req.flush(page([]));
    });
  });

  describe('details', () => {
    it('opens the details of a row in a dialog and closes it', async () => {
      const { flush, root, view } = await render();
      await flush([THREE]);
      root.querySelector<HTMLButtonElement>('td.actions button')!.click();
      await view();
      const dialog = root.querySelector('dialog')!;
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.querySelector('pre')?.textContent).toContain('TypeError: x');
      expect(dialog.textContent).toContain('x is undefined');
      dialog.querySelector<HTMLButtonElement>('header button')!.click();
      await view();
      expect(dialog.hasAttribute('open')).toBe(false);
    });
  });

  describe('filters and URL', () => {
    it('reads every filter from the URL, converting the days to instants', async () => {
      sessionStorage.setItem(LAST_GROUP_ID_KEY, GROUP);
      const { request, params } = await render(
        `/activity-log?category=security&outcome=denied&action=auth.loginFailed&from=2026-10-01&to=2026-10-31&requestId=%20req-1%20&actorId=${ACTOR}&groupId=${GROUP}&limit=50&cursor=abc`,
        { role: 'PSA' },
      );
      const req = request();
      const sent = params(req);
      expect(new Date(sent['from']!).getTime()).toBe(new Date('2026-10-01T00:00:00').getTime());
      expect(new Date(sent['to']!).getTime()).toBe(new Date('2026-10-31T23:59:59.999').getTime());
      expect({ ...sent, from: 'f', to: 't' }).toEqual({
        limit: '50',
        category: 'security',
        outcome: 'denied',
        action: 'auth.loginFailed',
        from: 'f',
        to: 't',
        requestId: 'req-1',
        actorId: ACTOR,
        groupId: GROUP,
        cursor: 'abc',
      });
      req.flush(page([]));
    });

    it('ignores values that are not valid and the group of users who cannot choose one', async () => {
      const { request } = await render(
        `/activity-log?category=x&outcome=y&action=z&from=2026-13-45&to=soon&requestId=%20&actorId=nope&groupId=${GROUP}&limit=7`,
      );
      const req = request();
      expect(req.request.params.keys()).toEqual(['limit']);
      expect(req.request.params.get('limit')).toBe('25');
      req.flush(page([]));
    });

    it('cuts a very long request id', async () => {
      const { request } = await render(`/activity-log?requestId=${'a'.repeat(300)}`);
      const req = request();
      expect(req.request.params.get('requestId')).toHaveLength(128);
      req.flush(page([]));
    });

    it.each([
      ['ACTIVITY.FILTER.CATEGORY', 'category', 'security'],
      ['ACTIVITY.FILTER.OUTCOME', 'outcome', 'failure'],
      ['ACTIVITY.FILTER.ACTION', 'action', 'user.created'],
    ])('filters by %s through the URL and can clear it', async (label, name, value) => {
      const ctx = await render();
      await ctx.flush([]);
      await select(ctx, label, value);
      expect(ctx.search().get(name)).toBe(value);
      expect(ctx.field(label).value).toBe(value);
      await ctx.flush([]);
      await select(ctx, label, '');
      expect(ctx.search().has(name)).toBe(false);
      await ctx.flush([]);
    });

    it('filters by period through the URL and clears it', async () => {
      const ctx = await render();
      await ctx.flush([]);
      await select(ctx, 'ACTIVITY.FILTER.FROM', '2026-10-01', 'input');
      expect(ctx.search().get('from')).toBe('2026-10-01');
      const req = await ctx.flush([]);
      expect(req.request.params.has('from')).toBe(true);
      await select(ctx, 'ACTIVITY.FILTER.TO', '2026-10-05', 'input');
      expect(ctx.search().get('to')).toBe('2026-10-05');
      await ctx.flush([]);
      await select(ctx, 'ACTIVITY.FILTER.TO', '', 'input');
      expect(ctx.search().has('to')).toBe(false);
      await ctx.flush([]);
    });

    it('does not ask the server for a period that ends before it starts, and says why', async () => {
      const ctx = await render('/activity-log?from=2026-10-10&to=2026-10-01');
      ctx.harness.detectChanges();
      await ctx.view();
      backend().expectNone(LIST);
      expect(ctx.root.textContent).toContain('ACTIVITY.PERIOD.ORDER');
    });

    it('does not ask the server for a period longer than the limit, and says why', async () => {
      expect(MAX_PERIOD_DAYS).toBe(400);
      const ctx = await render('/activity-log?from=2025-01-01&to=2026-11-01');
      await ctx.view();
      backend().expectNone(LIST);
      expect(ctx.root.textContent).toContain('ACTIVITY.PERIOD.TOO_LONG');
    });

    it('accepts a period of exactly the maximum length', async () => {
      const { request } = await render('/activity-log?from=2025-01-01&to=2026-02-05');
      request().flush(page([]));
    });

    it('puts the request id in the URL once the typing pauses, and clears it', async () => {
      const ctx = await render();
      await ctx.flush([]);
      const input = ctx.field('ACTIVITY.FILTER.REQUEST_ID');
      input.value = 'req-2 ';
      input.dispatchEvent(new Event('input'));
      expect(ctx.search().has('requestId')).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await ctx.view();
      expect(ctx.search().get('requestId')).toBe('req-2');
      await ctx.flush([]);
      input.value = ' ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await ctx.view();
      expect(ctx.search().has('requestId')).toBe(false);
      await ctx.flush([]);
    });

    it('does not reload the page when the filter form is submitted', async () => {
      const { flush, root } = await render();
      await flush([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form.filters')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('filters by the actor of a row and removes the filter', async () => {
      const ctx = await render();
      await ctx.flush([ONE, TWO]);
      const buttons = ctx.rows().map((row) => row.querySelectorAll('td.actions button').length);
      expect(buttons).toEqual([2, 1]);
      ctx.root.querySelectorAll<HTMLButtonElement>('td.actions button')[1].click();
      await ctx.view();
      expect(ctx.search().get('actorId')).toBe(ACTOR);
      const req = await ctx.flush([ONE]);
      expect(req.request.params.get('actorId')).toBe(ACTOR);
      const clear = ctx.root.querySelector<HTMLButtonElement>('.active-filters button')!;
      expect(clear.textContent).toContain('"id":"…ab34ce"');
      clear.click();
      await ctx.view();
      expect(ctx.search().has('actorId')).toBe(false);
      await ctx.flush([ONE]);
      expect(ctx.root.querySelector('.active-filters')).toBeNull();
    });

    it('does not offer the group filter to users bound to a group', async () => {
      const ctx = await render();
      await ctx.flush([]);
      expect(ctx.root.querySelector('.active-filters')).toBeNull();
    });
  });

  describe('group filter of platform admins and dealers', () => {
    const psa = { role: 'PSA' as const, groupId: null, group: null };

    it('ignores a group in the URL and shows everything while "all groups" is selected', async () => {
      sessionStorage.clear();
      const ctx = await render(`/activity-log?groupId=${GROUP}`, psa);
      const req = await ctx.flush([]);
      expect(req.request.params.has('groupId')).toBe(false);
      expect(ctx.field('ACTIVITY.FILTER.CURRENT_GROUP').disabled).toBe(true);
    });

    it('is disabled until a working group is chosen', async () => {
      const ctx = await render('/activity-log', psa);
      await ctx.flush([]);
      expect(ctx.field('ACTIVITY.FILTER.CURRENT_GROUP').disabled).toBe(true);
    });

    it('filters by the working group and shows all groups again', async () => {
      sessionStorage.clear();
      const ctx = await render('/activity-log', { ...psa, role: 'D' });
      TestBed.inject(GroupContext).choose({ id: GROUP, name: 'Gruppo' });
      await ctx.flush([]);
      const box = ctx.field('ACTIVITY.FILTER.CURRENT_GROUP') as HTMLInputElement;
      expect(box.disabled).toBe(false);
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await ctx.view();
      expect(ctx.search().get('groupId')).toBe(GROUP);
      const req = await ctx.flush([]);
      expect(req.request.params.get('groupId')).toBe(GROUP);
      expect(box.checked).toBe(true);
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await ctx.view();
      expect(ctx.search().has('groupId')).toBe(false);
      await ctx.flush([]);
    });
  });

  describe('errors', () => {
    it('shows an error state with the request id and retries', async () => {
      const { request, view, root } = await render();
      request().flush(errorBody('FORBIDDEN'), {
        status: 403,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-9' },
      });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('ERRORS.API.FORBIDDEN');
      expect(state.textContent).toContain('req-9');
      expect(root.querySelector('table')).toBeNull();
      state.querySelector('button')!.click();
      await view();
      request().flush(page([ONE]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(undefined, {}, true);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('pagination', () => {
    it('walks forward and back with the stack of cursors and changes the page size', async () => {
      const { flush, root, search, view } = await render();
      await flush([ONE], 'c1');
      const [previous, next] = [
        ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator nav .buttons button'),
      ];
      expect(previous.disabled).toBe(true);
      next.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      const req = await flush([TWO], 'c2');
      expect(req.request.params.get('cursor')).toBe('c1');
      next.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      await flush([THREE]);
      previous.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([TWO], 'c2');
      previous.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([ONE], 'c1');
      const size = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      size.value = '50';
      size.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      await flush([ONE]);
    });
  });
});

describe('ActivityLogPage security alerts', () => {
  const METADATA = { bucket: 'api:user', window: 'hour', limit: 600, mode: 'report' };
  const ALERT = fakeEntry({
    id: '665f1c2e9b1d4a0012ab3510',
    category: 'security',
    action: 'rateLimit.sustainedExceeded',
    outcome: 'denied',
    metadata: METADATA,
  });

  it('shows no notice when there are no new alerts', async () => {
    const { flush, root } = await render();
    await flush([]);
    expect(root.querySelector('.alert-notice')).toBeNull();
  });

  it('announces one or more new alerts with the right wording', async () => {
    const ctx = await render('/activity-log', { role: 'SA' }, false, 1);
    await ctx.flush([]);
    expect(ctx.root.querySelector('.alert-notice p')?.textContent).toBe(
      'ACTIVITY.ALERTS.NOTICE_ONE {"count":"1"}',
    );
    ctx.alerts.count.set(4);
    ctx.alerts.capped.set(true);
    ctx.harness.detectChanges();
    expect(ctx.root.querySelector('.alert-notice p')?.textContent).toBe(
      'ACTIVITY.ALERTS.NOTICE_OTHER {"count":"99+"}',
    );
  });

  it('shows the alerts: filters by action and day in the URL, marks them as seen', async () => {
    const ctx = await render('/activity-log', { role: 'SA' }, false, 3);
    await ctx.flush([]);
    const show = ctx.root.querySelector<HTMLButtonElement>('.alert-actions button')!;
    show.click();
    await ctx.view();
    expect(ctx.alerts.markSeen).toHaveBeenCalledTimes(1);
    expect(ctx.search().get('alerts')).toBe('true');
    expect(ctx.search().has('action')).toBe(false);
    expect(ctx.search().get('from')).toBe('2026-11-20');
    expect(ctx.root.querySelector('.alert-notice')).toBeNull();
    expect(document.activeElement).toBe(ctx.root.querySelector('h1'));
    const req = ctx.request();
    expect(req.request.params.get('alerts')).toBe('true');
    expect(req.request.params.has('action')).toBe(false);
    expect(req.request.params.get('from')).toBe(new Date('2026-11-20T00:00:00').toISOString());
    req.flush(page([ALERT]));
    await ctx.view();
  });

  it('marks the alerts as seen without filtering', async () => {
    const ctx = await render('/activity-log', { role: 'SA' }, false, 2);
    await ctx.flush([]);
    ctx.root.querySelectorAll<HTMLButtonElement>('.alert-actions button')[1].click();
    await ctx.view();
    expect(ctx.alerts.markSeen).toHaveBeenCalledTimes(1);
    expect(ctx.search().has('action')).toBe(false);
    expect(ctx.root.querySelector('.alert-notice')).toBeNull();
    expect(document.activeElement).toBe(ctx.root.querySelector('h1'));
  });

  it('keeps the alerts filter in the URL, shows it as removable and drops an action filter on Show', async () => {
    const ctx = await render('/activity-log?alerts=true&action=user.created', { role: 'SA' });
    const req = ctx.request();
    expect(req.request.params.get('alerts')).toBe('true');
    expect(req.request.params.get('action')).toBe('user.created');
    req.flush(page([]));
    await ctx.view();
    const chip = [...ctx.root.querySelectorAll<HTMLButtonElement>('.active-filters button')].find(
      (b) => b.textContent?.includes('ACTIVITY.FILTER.ONLY_ALERTS'),
    )!;
    expect(chip.getAttribute('aria-label')).toBe('ACTIVITY.FILTER.CLEAR_ALERTS');
    chip.click();
    await ctx.view();
    expect(ctx.search().has('alerts')).toBe(false);
    const next = ctx.request();
    expect(next.request.params.has('alerts')).toBe(false);
    next.flush(page([]));
    await ctx.view();
    expect(ctx.root.querySelector('.active-filters')).toBeNull();
  });

  it('does not offer or send the alerts filter to CA and PA', async () => {
    const ctx = await render('/activity-log?alerts=true', { role: 'CA' });
    const req = ctx.request();
    expect(req.request.params.has('alerts')).toBe(false);
    req.flush(page([]));
    await ctx.view();
    expect(ctx.root.querySelector('.active-filters')).toBeNull();
  });

  it('labels the store key alerts and describes their key', async () => {
    const { flush, rows, cells } = await render();
    await flush([
      fakeEntry({
        id: '665f1c2e9b1d4a0012ab3520',
        action: 'store.activeKeyReplaced',
        metadata: { keyHint: 'fc_sk_AbC1', replacedKeyId: 'k1' },
      }),
    ]);
    expect(cells(0)[2]).toContain('ACTIVITY.ACTION.STORE_ACTIVE_KEY_REPLACED');
    expect(rows()[0].querySelector('.action-detail')?.textContent).toContain(
      'ACTIVITY.ALERTS.KEY_REPLACED',
    );
  });

  it('shows the program of a non-browser request as text, never as HTML', async () => {
    const { flush, rows } = await render();
    await flush([
      fakeEntry({
        id: '665f1c2e9b1d4a0012ab3530',
        action: 'request.nonBrowser',
        metadata: { reason: 'noOrigin', source: 'api', userAgent: '<img src=x onerror=alert(1)>' },
      }),
    ]);
    const detail = rows()[0].querySelector('.action-detail')!;
    expect(detail.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(detail.querySelector('img')).toBeNull();
    expect(rows()[0].textContent).toContain('ACTIVITY.ACTION.REQUEST_NON_BROWSER');
  });

  it('describes the exceeded limit under the action and in the details', async () => {
    const { flush, rows, root, view } = await render();
    await flush([
      ALERT,
      fakeEntry({
        id: '665f1c2e9b1d4a0012ab3511',
        action: 'rateLimit.sustainedExceeded',
        metadata: null,
      }),
    ]);
    expect(rows()[0].querySelector('.action-detail')?.textContent).toContain(
      'ACTIVITY.ALERTS.DETAIL',
    );
    expect(rows()[1].querySelector('.action-detail')).toBeNull();
    expect(rows()[0].textContent).toContain('ACTIVITY.ACTION.RATE_LIMIT_SUSTAINED_EXCEEDED');
    (rows()[0].querySelector('button') as HTMLButtonElement).click();
    await view();
    expect(root.querySelector('fc-activity-detail .summary-text')?.textContent).toContain(
      'ACTIVITY.ALERTS.DETAIL',
    );
  });
});
