import { TestBed } from '@angular/core/testing';
import { backend, errorBody, provideApiTesting } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { emulateNativeDialog } from '../../../testing/dialog';
import { GROUP, PLACE, PLACE_PERMISSIONS, PLACE_URL, renderPlace } from '../../../testing/places';
import { I18nService } from '../../core/i18n/i18n.service';
import { PlaceState } from './place-state';
import { PlaceStoreKey } from './place-store-key';
import { StoreKeyStatus } from './store-key.types';

const URL_KEY = `${PLACE_URL}/store-key`;
const MANAGE = [...PLACE_PERMISSIONS, 'storeKeys:read', 'storeKeys:manage'];
const outside = (view: { buttons: () => HTMLButtonElement[] }, text: string) =>
  view.buttons().find((b) => b.textContent?.trim() === text && b.closest('dialog') === null);
const CODE = '7KQ2-M9XD-4TPA-H3WN';

const NONE: StoreKeyStatus = {
  status: 'none',
  key: null,
  pendingActivation: null,
  lastRevoked: null,
};
const ACTIVE: StoreKeyStatus = {
  status: 'active',
  key: {
    id: 'k1',
    hint: 'fc_sk_AbC1…',
    activatedAt: '2026-11-13T10:00:00.000Z',
    activatedBy: { id: 'u1', role: 'D' },
    installation: { userAgent: 'x', appVersion: '2.0.1', platform: 'windows' },
    lastSeenAt: '2026-11-13T12:31:00.000Z',
    lastSeenIp: '203.0.113.7',
  },
  pendingActivation: {
    createdAt: '2026-11-13T11:00:00.000Z',
    expiresAt: '2026-11-14T11:00:00.000Z',
    createdBy: null,
  },
  lastRevoked: { revokedAt: '2026-11-01T08:00:00.000Z', reason: 'replaced' },
};

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function render(status: StoreKeyStatus | null = NONE, permissions = MANAGE) {
  emulateNativeDialog();
  const view = await renderPlace({ path: 'settings/dealer', permissions, lookups: false });
  if (status !== null) {
    backend().expectOne(URL_KEY).flush({ data: status });
    await view.view();
  }
  return view;
}

describe('PlaceStoreKey', () => {
  it('says there is no key and offers only to generate a code', async () => {
    const view = await render();
    expect(view.text()).toContain('PLACES.STORE_KEY.NONE');
    expect(view.button('PLACES.STORE_KEY.GENERATE')).toBeDefined();
    expect(view.button('PLACES.STORE_KEY.CANCEL_CODE')).toBeUndefined();
    expect(outside(view, 'PLACES.STORE_KEY.REVOKE')).toBeUndefined();
    expect(view.text()).not.toContain('PLACES.STORE_KEY.PENDING');
    expect(view.text()).not.toContain('PLACES.STORE_KEY.LAST_REVOKED');
  });

  it('shows the active key, the pending code and why the last key stopped', async () => {
    const view = await render(ACTIVE);
    const text = view.text();
    expect(text).toContain('PLACES.STORE_KEY.ACTIVE');
    expect(text).toContain('fc_sk_AbC1…');
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('2.0.1');
    expect(text).toContain('PLACES.STORE_KEY.PENDING');
    expect(text).toContain('PLACES.STORE_KEY.REASON.replaced');
    expect(view.button('PLACES.STORE_KEY.CANCEL_CODE')).toBeDefined();
    expect(view.button('PLACES.STORE_KEY.REVOKE')).toBeDefined();
  });

  it('copes with a key that was never seen and has no installation', async () => {
    const view = await render({
      ...ACTIVE,
      key: {
        ...(ACTIVE.key as NonNullable<StoreKeyStatus['key']>),
        lastSeenAt: null,
        lastSeenIp: null,
        installation: null,
      },
      pendingActivation: null,
      lastRevoked: null,
    });
    expect(view.text()).not.toContain('PLACES.STORE_KEY.LAST_SEEN');
    expect(view.text()).not.toContain('PLACES.STORE_KEY.LAST_IP');
    expect(view.text()).not.toContain('PLACES.STORE_KEY.APP_VERSION');
  });

  it('shows an installation that did not say its version', async () => {
    const key = ACTIVE.key as NonNullable<StoreKeyStatus['key']>;
    const view = await render({
      ...ACTIVE,
      key: { ...key, installation: { userAgent: null, appVersion: null, platform: null } },
    });
    expect(view.text()).not.toContain('PLACES.STORE_KEY.APP_VERSION');
  });

  it('writes dates in the language of the interface once it is loaded', async () => {
    const view = await render(ACTIVE);
    const loaded = TestBed.inject(I18nService).use('it');
    backend().expectOne('/i18n/it.json').flush({});
    await loaded;
    await view.view();
    expect(view.text()).toContain('2026');
  });

  it('shows the code once in a dialog, with its expiry and the warning, and forgets it on close', async () => {
    const view = await render();
    await view.click('PLACES.STORE_KEY.GENERATE');
    const post = backend().expectOne(`${URL_KEY}/activation-codes`);
    expect(post.request.method).toBe('POST');
    expect(post.request.headers.has('If-Match')).toBe(false);
    post.flush(
      { data: { code: CODE, expiresAt: '2026-11-14T10:00:00.000Z' } },
      { status: 201, statusText: 'Created' },
    );
    await view.view();
    backend().expectOne(URL_KEY).flush({ data: NONE });
    await view.view();
    const dialog = view.root.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain(CODE);
    expect(dialog.textContent).toContain('PLACES.STORE_KEY.EXPIRES');
    expect(dialog.textContent).toContain('PLACES.STORE_KEY.REPLACES');
    await view.click('COMMON.CLOSE');
    expect(view.text()).not.toContain(CODE);
    expect(JSON.stringify(sessionStorage)).not.toContain(CODE);
  });

  it('copies the code, and says so when the clipboard refuses', async () => {
    const view = await render();
    await view.click('PLACES.STORE_KEY.GENERATE');
    backend()
      .expectOne(`${URL_KEY}/activation-codes`)
      .flush(
        { data: { code: CODE, expiresAt: '2026-11-14T10:00:00.000Z' } },
        { status: 201, statusText: 'Created' },
      );
    await view.view();
    backend().expectOne(URL_KEY).flush({ data: NONE });
    await view.view();
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await view.click('PLACES.STORE_KEY.COPY');
    await view.click('PLACES.STORE_KEY.COPY');
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(view.toasts()).toEqual(['PLACES.STORE_KEY.COPIED', 'PLACES.STORE_KEY.COPY_FAILED']);
  });

  it('reports a code that could not be generated and shows no dialog', async () => {
    const view = await render();
    await view.click('PLACES.STORE_KEY.GENERATE');
    backend()
      .expectOne(`${URL_KEY}/activation-codes`)
      .flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view.view();
    expect(view.toasts()).toHaveLength(1);
    expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('cancels the pending code', async () => {
    const view = await render(ACTIVE);
    await view.click('PLACES.STORE_KEY.CANCEL_CODE');
    const del = backend().expectOne(`${URL_KEY}/activation-code`);
    expect(del.request.method).toBe('DELETE');
    del.flush(null, { status: 204, statusText: 'No Content' });
    await view.view();
    backend()
      .expectOne(URL_KEY)
      .flush({ data: { ...ACTIVE, pendingActivation: null } });
    await view.view();
    expect(view.toasts()).toEqual(['PLACES.STORE_KEY.CODE_CANCELLED']);
    expect(view.text()).not.toContain('PLACES.STORE_KEY.PENDING');
  });

  it('reports a code that could not be cancelled', async () => {
    const view = await render(ACTIVE);
    await view.click('PLACES.STORE_KEY.CANCEL_CODE');
    backend()
      .expectOne(`${URL_KEY}/activation-code`)
      .flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view.view();
    expect(view.toasts()).toHaveLength(1);
  });

  it('asks for confirmation before revoking, then revokes without If-Match', async () => {
    const view = await render(ACTIVE);
    await view.click('PLACES.STORE_KEY.REVOKE');
    expect(view.root.textContent).toContain('PLACES.STORE_KEY.REVOKE_TITLE');
    const confirm = [...view.root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === 'PLACES.STORE_KEY.REVOKE',
    ) as HTMLButtonElement;
    confirm.click();
    await view.view();
    const del = backend().expectOne(URL_KEY);
    expect(del.request.method).toBe('DELETE');
    expect(del.request.headers.has('If-Match')).toBe(false);
    del.flush(null, { status: 204, statusText: 'No Content' });
    await view.view();
    backend().expectOne(URL_KEY).flush({ data: NONE });
    await view.view();
    expect(view.toasts()).toEqual(['PLACES.STORE_KEY.REVOKED']);
  });

  it('closes the revocation dialog without revoking, and the code dialog with its close button', async () => {
    const view = await render(ACTIVE);
    await view.click('PLACES.STORE_KEY.REVOKE');
    (
      view.root.querySelector('dialog[open] button[aria-label="COMMON.CLOSE"]') as HTMLButtonElement
    ).click();
    await view.view();
    expect(view.root.querySelector('dialog[open]')).toBeNull();
    await view.click('PLACES.STORE_KEY.GENERATE');
    await view.click('PLACES.STORE_KEY.REPLACE_CONFIRM');
    backend()
      .expectOne(`${URL_KEY}/activation-codes`)
      .flush(
        { data: { code: CODE, expiresAt: '2026-11-14T10:00:00.000Z' } },
        { status: 201, statusText: 'Created' },
      );
    await view.view();
    backend().expectOne(URL_KEY).flush({ data: ACTIVE });
    await view.view();
    (
      view.root.querySelector('dialog[open] button[aria-label="COMMON.CLOSE"]') as HTMLButtonElement
    ).click();
    await view.view();
    expect(view.text()).not.toContain(CODE);
  });

  it('reports a revocation that failed', async () => {
    const view = await render(ACTIVE);
    await view.click('PLACES.STORE_KEY.REVOKE');
    (
      [...view.root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
        (b) => b.textContent?.trim() === 'PLACES.STORE_KEY.REVOKE',
      ) as HTMLButtonElement
    ).click();
    await view.view();
    backend().expectOne(URL_KEY).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view.view();
    expect(view.toasts()).toHaveLength(1);
  });

  it('only shows the state to a user who cannot manage the key', async () => {
    const view = await render(ACTIVE, [...PLACE_PERMISSIONS, 'storeKeys:read']);
    expect(view.text()).toContain('PLACES.STORE_KEY.ACTIVE');
    expect(view.button('PLACES.STORE_KEY.GENERATE')).toBeUndefined();
    expect(outside(view, 'PLACES.STORE_KEY.REVOKE')).toBeUndefined();
  });

  it('shows a loading text, then an error state that retries', async () => {
    const view = await render(null);
    expect(view.text()).toContain('COMMON.LOADING');
    backend()
      .expectOne(URL_KEY)
      .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view.view();
    expect(view.text()).toContain('PLACES.STORE_KEY.LOAD_ERROR');
    await view.click('COMMON.RETRY');
    backend().expectOne(URL_KEY).flush({ data: NONE });
    await view.view();
    expect(view.text()).toContain('PLACES.STORE_KEY.NONE');
  });

  it('does not offer the panel in the dealer settings without storeKeys:read', async () => {
    const view = await render(null, PLACE_PERMISSIONS);
    expect(view.text()).not.toContain('PLACES.STORE_KEY.NONE');
    expect(view.text()).not.toContain('PLACES.STORE_KEY.TITLE');
  });

  it('does not read the key when the user cannot, even when mounted', async () => {
    TestBed.configureTestingModule({
      providers: [
        ...provideApiTesting(),
        { provide: PlaceState, useValue: { groupId: () => GROUP, placeId: () => PLACE } },
      ],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    signIn({ role: 'PSA', groupId: null, permissions: ['places:read', 'profile:read'] });
    const fixture = TestBed.createComponent(PlaceStoreKey);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain('PLACES.STORE_KEY.TITLE');
    backend().expectNone(URL_KEY);
  });
  describe('replacing an active key', () => {
    const dialog = (view: Awaited<ReturnType<typeof render>>) =>
      view.root.querySelector('dialog[open]') as HTMLDialogElement | null;
    const created = { data: { code: CODE, expiresAt: '2026-11-14T10:00:00.000Z' } };

    it('asks first, with an alert dialog whose focus starts on Cancel, and sends nothing yet', async () => {
      const view = await render(ACTIVE);
      await view.click('PLACES.STORE_KEY.GENERATE');
      backend().expectNone(`${URL_KEY}/activation-codes`);
      const open = dialog(view)!;
      expect(open.getAttribute('role')).toBe('alertdialog');
      expect(open.getAttribute('aria-describedby')).toBeTruthy();
      expect(open.textContent).toContain('PLACES.STORE_KEY.REPLACE_MESSAGE');
      expect(open.querySelector('footer button')?.hasAttribute('autofocus')).toBe(true);
      expect(open.querySelector('footer button')?.textContent?.trim()).toBe('COMMON.CANCEL');
    });

    it('cancelling sends nothing', async () => {
      const view = await render(ACTIVE);
      await view.click('PLACES.STORE_KEY.GENERATE');
      (dialog(view)!.querySelector('footer button') as HTMLButtonElement).click();
      await view.view();
      expect(dialog(view)).toBeNull();
      backend().expectNone(`${URL_KEY}/activation-codes`);
    });

    it('sends the confirmation, then shows the code', async () => {
      const view = await render(ACTIVE);
      await view.click('PLACES.STORE_KEY.GENERATE');
      await view.click('PLACES.STORE_KEY.REPLACE_CONFIRM');
      const post = backend().expectOne(`${URL_KEY}/activation-codes`);
      expect(post.request.body).toEqual({ confirmReplaceActiveKey: true });
      post.flush(created, { status: 201, statusText: 'Created' });
      await view.view();
      backend().expectOne(URL_KEY).flush({ data: ACTIVE });
      await view.view();
      expect(dialog(view)?.textContent).toContain(CODE);
      expect(dialog(view)?.getAttribute('role')).toBeNull();
    });

    it('sends no body without an active key', async () => {
      const view = await render();
      await view.click('PLACES.STORE_KEY.GENERATE');
      expect(dialog(view)).toBeNull();
      const post = backend().expectOne(`${URL_KEY}/activation-codes`);
      expect(post.request.body).toBeNull();
      post.flush(created, { status: 201, statusText: 'Created' });
      await view.view();
      backend().expectOne(URL_KEY).flush({ data: NONE });
      await view.view();
    });

    it('asks and retries with the confirmation when the key became active meanwhile', async () => {
      const view = await render();
      await view.click('PLACES.STORE_KEY.GENERATE');
      backend()
        .expectOne(`${URL_KEY}/activation-codes`)
        .flush(errorBody('CONFLICT', [{ field: 'confirmReplaceActiveKey', issue: 'required' }]), {
          status: 409,
          statusText: 'x',
        });
      await view.view();
      backend().expectOne(URL_KEY).flush({ data: ACTIVE });
      await view.view();
      expect(view.toasts()).toHaveLength(0);
      expect(dialog(view)?.getAttribute('role')).toBe('alertdialog');
      await view.click('PLACES.STORE_KEY.REPLACE_CONFIRM');
      const retry = backend().expectOne(`${URL_KEY}/activation-codes`);
      expect(retry.request.body).toEqual({ confirmReplaceActiveKey: true });
      retry.flush(created, { status: 201, statusText: 'Created' });
      await view.view();
      backend().expectOne(URL_KEY).flush({ data: ACTIVE });
      await view.view();
      expect(dialog(view)?.textContent).toContain(CODE);
    });

    it('closes the question and reports a failure of the confirmed request', async () => {
      const view = await render(ACTIVE);
      await view.click('PLACES.STORE_KEY.GENERATE');
      await view.click('PLACES.STORE_KEY.REPLACE_CONFIRM');
      backend()
        .expectOne(`${URL_KEY}/activation-codes`)
        .flush(errorBody('CONFLICT', [{ field: 'confirmReplaceActiveKey', issue: 'required' }]), {
          status: 409,
          statusText: 'x',
        });
      await view.view();
      expect(dialog(view)).toBeNull();
      expect(view.toasts()).toHaveLength(1);
    });

    it('treats any other conflict as a plain failure', async () => {
      const view = await render();
      await view.click('PLACES.STORE_KEY.GENERATE');
      backend()
        .expectOne(`${URL_KEY}/activation-codes`)
        .flush(errorBody('CONFLICT', [{ field: 'other', issue: 'required' }]), {
          status: 409,
          statusText: 'x',
        });
      await view.view();
      expect(dialog(view)).toBeNull();
      expect(view.toasts()).toHaveLength(1);
    });
  });
});
