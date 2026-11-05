import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  API,
  backend,
  errorBody,
  failRequest,
  provideApiTesting,
  settle,
} from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { ApiError } from '../../core/api/api-error';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { SessionService } from '../../core/session/session.service';
import { SessionInfo } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ProfileApi } from './profile-api';
import { abbreviateUserAgent, apiErrorOf, Sessions } from './sessions';

const LONG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0';

const CURRENT: SessionInfo = {
  id: '665f1c2e9b1d4a0012ab34cd',
  createdAt: '2026-11-04T09:00:00.000Z',
  lastUsedAt: '2026-11-04T09:12:30.000Z',
  userAgent: LONG_UA,
  ip: '203.0.113.10',
  current: true,
};
const OTHER: SessionInfo = {
  id: '665f1c2e9b1d4a0012ab34d0',
  createdAt: '2026-11-02T15:40:00.000Z',
  lastUsedAt: null,
  userAgent: null,
  ip: null,
  current: false,
};

describe('abbreviateUserAgent', () => {
  it('keeps short values and null', () => {
    expect(abbreviateUserAgent(null)).toBeNull();
    expect(abbreviateUserAgent('curl/8')).toBe('curl/8');
    expect(abbreviateUserAgent('a'.repeat(48))).toBe('a'.repeat(48));
  });

  it('shortens long values', () => {
    expect(abbreviateUserAgent('a'.repeat(49))).toBe(`${'a'.repeat(48)}…`);
  });
});

describe('apiErrorOf', () => {
  const error = new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'm' });

  it('finds an API error directly or as the cause of a wrapper', () => {
    expect(apiErrorOf(error)).toBe(error);
    expect(apiErrorOf(new Error('wrapper', { cause: error }))).toBe(error);
  });

  it.each([undefined, null, new Error('plain'), new Error('x', { cause: 'text' }), 'text'])(
    'returns null for %s',
    (value) => {
      expect(apiErrorOf(value)).toBeNull();
    },
  );
});

describe('Sessions', () => {
  async function render(body: SessionInfo[] | 'pending' = [CURRENT, OTHER]) {
    emulateNativeDialog();
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`,
    );
    signIn();
    const fixture = TestBed.createComponent(Sessions);
    document.body.appendChild(fixture.nativeElement);
    // A pending request keeps the fixture unstable: only let the resource start its request.
    fixture.detectChanges();
    await settle();
    const list = backend().expectOne(`${API}/v1/me/sessions`);
    if (body !== 'pending') {
      list.flush({ data: body });
      await fixture.whenStable();
    }
    const root = fixture.nativeElement as HTMLElement;
    const cells = (row: number) =>
      [...root.querySelectorAll('tbody tr')[row].querySelectorAll('th, td')].map((c) =>
        c.textContent?.trim(),
      );
    const dialog = () => root.querySelector<HTMLDialogElement>('dialog')!;
    const dialogButtons = () => dialog().querySelectorAll<HTMLButtonElement>('footer button');
    return { fixture, root, list, cells, dialog, dialogButtons };
  }

  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('shows a loading state while the sessions are fetched', async () => {
    const { root, list } = await render('pending');
    expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('fc-skeleton')).not.toBeNull();
    list.flush({ data: [] });
  });

  it('lists the sessions with an abbreviated device and marks the current one', async () => {
    const { root, cells } = await render();
    expect(root.querySelector('h1')?.textContent).toBe('SESSIONS.TITLE');
    expect(root.querySelector('caption')?.textContent?.trim()).toBe('SESSIONS.TITLE');
    expect([...root.querySelectorAll('thead th')].map((h) => h.textContent?.trim())).toEqual([
      'SESSIONS.DEVICE',
      'SESSIONS.IP',
      'SESSIONS.CREATED',
      'SESSIONS.LAST_USED',
      'SESSIONS.STATE',
      'COMMON.ACTIONS',
    ]);
    const first = cells(0);
    expect(first[0]).toBe(`${LONG_UA.slice(0, 48)}…`);
    expect(first[1]).toBe('203.0.113.10');
    expect(first[2]).toMatch(/2026/);
    expect(first[3]).toMatch(/2026/);
    expect(first[4]).toBe('SESSIONS.THIS_SESSION');
    expect(cells(1).slice(0, 5)).toEqual([
      'SESSIONS.UNKNOWN',
      'SESSIONS.UNKNOWN',
      expect.stringMatching(/2026/),
      'SESSIONS.UNKNOWN',
      '',
    ]);
  });

  it('formats the dates in the active language once the dictionary is loaded', async () => {
    const { cells, fixture } = await render();
    const loading = TestBed.inject(I18nService).use('it');
    backend().expectOne('/i18n/it.json').flush({ A: 'b' });
    await loading;
    await fixture.whenStable();
    expect(cells(0)[2]).toMatch(/nov/i);
  });

  it('gives each revoke button a name that tells the sessions apart', async () => {
    const { root } = await render();
    const labels = [...root.querySelectorAll('tbody button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels[0]).toMatch(/^SESSIONS\.REVOKE_LABEL \{"created":".*2026.*"\}$/);
    expect(labels[1]).not.toBe(labels[0]);
  });

  it('shows an empty state when there are no sessions', async () => {
    const { root } = await render([]);
    expect(root.querySelector('fc-empty-state')?.textContent).toContain('SESSIONS.EMPTY');
  });

  describe('load failure', () => {
    it('shows the error with the request id and retries on demand', async () => {
      const { fixture, root, list } = await render('pending');
      list.flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-77' },
      });
      await fixture.whenStable();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('SESSIONS.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(state.textContent).toContain('ERRORS.REQUEST_ID {"requestId":"req-77"}');
      expect(root.querySelector('table')).toBeNull();

      state.querySelector('button')!.click();
      await settle();
      backend()
        .expectOne(`${API}/v1/me/sessions`)
        .flush({ data: [CURRENT] });
      await fixture.whenStable();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelectorAll('tbody tr').length).toBe(1);
    });

    it('explains an unreachable service', async () => {
      const { fixture, root, list } = await render('pending');
      list.error(new ProgressEvent('error'));
      await fixture.whenStable();
      expect(root.querySelector('fc-error-state')?.textContent).toContain(
        'ERRORS.API.NETWORK_ERROR',
      );
    });

    it('falls back to the generic message when the error is not an API error', async () => {
      emulateNativeDialog();
      TestBed.configureTestingModule({
        providers: [
          ...provideApiTesting(),
          provideRouter([]),
          // Not loaded: the base-URL interceptor throws a plain Error.
          { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
        ],
      });
      vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
      const fixture = TestBed.createComponent(Sessions);
      await fixture.whenStable();
      const state = (fixture.nativeElement as HTMLElement).querySelector('fc-error-state');
      expect(state?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
      expect(state?.textContent).not.toContain('ERRORS.REQUEST_ID');
    });
  });

  describe('revoking', () => {
    async function ask(row: number) {
      const ctx = await render();
      ctx.root.querySelectorAll<HTMLButtonElement>('tbody button')[row].click();
      await ctx.fixture.whenStable();
      return ctx;
    }

    it('asks before revoking another session, naming the consequence', async () => {
      const { dialog } = await ask(1);
      expect(dialog().hasAttribute('open')).toBe(true);
      expect(dialog().textContent).toContain('SESSIONS.CONFIRM_OTHER');
      expect(dialog().textContent).not.toContain('CONFIRM_CURRENT');
    });

    it('warns that revoking the current session means signing out', async () => {
      const { dialog } = await ask(0);
      expect(dialog().textContent).toContain('SESSIONS.CONFIRM_CURRENT');
    });

    it('does nothing when cancelled', async () => {
      const { fixture, dialog, dialogButtons } = await ask(1);
      dialogButtons()[0].click();
      await fixture.whenStable();
      expect(dialog().hasAttribute('open')).toBe(false);
      backend().expectNone(`${API}/v1/me/sessions/${OTHER.id}`);
    });

    it('revokes another session, reloads the list and thanks the user', async () => {
      const { fixture, root, dialog, dialogButtons } = await ask(1);
      dialogButtons()[1].click();
      await fixture.whenStable();
      expect(dialogButtons()[1].getAttribute('aria-busy')).toBe('true');
      const del = backend().expectOne(`${API}/v1/me/sessions/${OTHER.id}`);
      expect(del.request.method).toBe('DELETE');
      del.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      fixture.detectChanges();
      expect(dialog().hasAttribute('open')).toBe(false);
      expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
        kind: 'success',
        message: 'SESSIONS.REVOKED',
      });
      backend()
        .expectOne(`${API}/v1/me/sessions`)
        .flush({ data: [CURRENT] });
      await fixture.whenStable();
      expect(root.querySelectorAll('tbody tr').length).toBe(1);
      expect(TestBed.inject(SessionService).status()).toBe('authenticated');
    });

    it('revoking the current session is a logout', async () => {
      const { fixture, dialogButtons } = await ask(0);
      vi.spyOn(TestBed.inject(SessionService), 'logout').mockResolvedValue();
      dialogButtons()[1].click();
      await settle();
      await fixture.whenStable();
      expect(TestBed.inject(SessionService).logout).toHaveBeenCalledOnce();
      backend().expectNone(`${API}/v1/me/sessions/${CURRENT.id}`);
    });

    it('reports a failure of the server', async () => {
      const { fixture, dialog, dialogButtons } = await ask(1);
      dialogButtons()[1].click();
      await fixture.whenStable();
      failRequest(backend(), `/v1/me/sessions/${OTHER.id}`, 'NOT_FOUND');
      await settle();
      await fixture.whenStable();
      expect(dialog().hasAttribute('open')).toBe(false);
      expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
        kind: 'error',
        message: 'ERRORS.API.NOT_FOUND',
      });
      backend().expectNone(`${API}/v1/me/sessions`);
    });

    it('reports an unexpected failure generically and logs it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, dialogButtons } = await ask(1);
      vi.spyOn(TestBed.inject(ProfileApi), 'revokeSession').mockRejectedValue(new Error('boom'));
      dialogButtons()[1].click();
      await settle();
      await fixture.whenStable();
      expect(TestBed.inject(ToastService).toasts()[0].message).toBe('ERRORS.GENERIC.MESSAGE');
      expect(console.error).toHaveBeenCalledOnce();
    });
  });
});
