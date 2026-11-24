import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { emulateNativeDialog } from '../../../testing/dialog';
import { SecurityPolicyPage } from './security-policy-page';
import { POLICY } from '../../../testing/security-policy';
import { SecurityPolicy } from './security-policy.types';

const URL_ = `${API}/v1/settings/security-policy`;

async function render(withApi = true) {
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
  signIn({ role: 'PSA', permissions: ['securityPolicy:manage'] });
  const fixture = TestBed.createComponent(SecurityPolicyPage);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const load = async (policy: SecurityPolicy = POLICY, etag = '"v1"') => {
    await view();
    backend()
      .expectOne(URL_)
      .flush({ data: policy }, { headers: { ETag: etag } });
    await view();
  };
  const radio = (name: string, value: string) =>
    root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;
  const choose = async (name: string, value: string) => {
    radio(name, value).click();
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  const save = async () => {
    root
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await view();
  };
  const dialog = () => root.querySelector<HTMLDialogElement>('dialog[open]');
  return { fixture, root, view, load, radio, choose, button, save, dialog };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('SecurityPolicyPage: reading', () => {
  it('shows two legends, the choices, the sources and the thresholds read only', async () => {
    const { root, view, load, radio } = await render();
    await view();
    expect(root.textContent).toContain('COMMON.LOADING');
    await load({
      ...POLICY,
      sustainedLimits: 'enforce',
      sources: { nonBrowserRequests: 'default', sustainedLimits: 'database' },
    });
    const legends = [...root.querySelectorAll('fieldset > legend')].map((l) => l.textContent);
    expect(legends).toEqual(['SECURITY_POLICY.NON_BROWSER.TITLE', 'SECURITY_POLICY.LIMITS.TITLE']);
    expect(radio('nonBrowserRequests', 'report').checked).toBe(true);
    expect(radio('sustainedLimits', 'enforce').checked).toBe(true);
    const sources = [...root.querySelectorAll('.source')].map((p) => p.textContent?.trim());
    expect(sources).toEqual(['SECURITY_POLICY.SOURCE.DEFAULT', 'SECURITY_POLICY.SOURCE.DATABASE']);
    expect([...root.querySelectorAll('.thresholds dd')].map((d) => d.textContent)).toEqual([
      expect.stringMatching(/300/),
      expect.stringMatching(/2\D?000/),
      expect.stringMatching(/10\D?000/),
    ]);
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toBe(
      'non-browser-help',
    );
    expect(root.querySelector('#non-browser-help')).not.toBeNull();
    expect(root.querySelectorAll('.thresholds input').length).toBe(0);
  });

  it('shows the failure of the read, and reads again on retry', async () => {
    const { root, view, button, load } = await render();
    await view();
    backend().expectOne(URL_).flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.API.FORBIDDEN');
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

describe('SecurityPolicyPage: forced by the server', () => {
  it('warns at the top and says so under the choice, whichever field is forced', async () => {
    const { root, load } = await render();
    await load({
      ...POLICY,
      sources: { nonBrowserRequests: 'default', sustainedLimits: 'forced' },
    });
    expect(root.querySelector('.forced')?.textContent).toContain('SECURITY_POLICY.FORCED_NOTICE');
    expect(root.querySelectorAll('.source')[1].textContent).toContain('SOURCE.FORCED');
    expect(root.querySelector<HTMLButtonElement>('button[type=submit]')).not.toBeNull();
  });

  it('warns for the other field too, and not when nothing is forced', async () => {
    const forced = await render();
    await forced.load({
      ...POLICY,
      sources: { nonBrowserRequests: 'forced', sustainedLimits: 'database' },
    });
    expect(forced.root.querySelector('.forced')).not.toBeNull();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const plain = await render();
    await plain.load();
    expect(plain.root.querySelector('.forced')).toBeNull();
  });
});

describe('SecurityPolicyPage: saving', () => {
  it('keeps Save disabled until something changes, and does nothing on submit', async () => {
    const { root, load, save, choose } = await render();
    await load();
    const submit = root.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.disabled).toBe(true);
    await save();
    backend().expectNone({ method: 'PUT', url: URL_ });
    await choose('sustainedLimits', 'enforce');
    expect(submit.disabled).toBe(false);
    await choose('sustainedLimits', 'report');
    expect(submit.disabled).toBe(true);
  });

  it('asks for confirmation to turn on a block, naming it, with Cancel sending nothing', async () => {
    const { load, save, choose, dialog, view } = await render();
    await load();
    await choose('nonBrowserRequests', 'block');
    await save();
    const open = dialog()!;
    expect(open.getAttribute('role')).toBe('alertdialog');
    expect(open.textContent).toContain('SECURITY_POLICY.CONFIRM.NON_BROWSER');
    expect(open.textContent).not.toContain('SECURITY_POLICY.CONFIRM.LIMITS');
    expect(open.textContent).toContain('SECURITY_POLICY.CONFIRM.LOGGED');
    (open.querySelector('footer button') as HTMLButtonElement).click();
    await view();
    expect(dialog()).toBeNull();
    backend().expectNone({ method: 'PUT', url: URL_ });
  });

  it('sends only what changed after the confirmation, and keeps the new version and sources', async () => {
    const { load, save, choose, dialog, view, root, radio } = await render();
    await load();
    await choose('nonBrowserRequests', 'block');
    await choose('sustainedLimits', 'enforce');
    await save();
    expect(dialog()?.textContent).toContain('SECURITY_POLICY.CONFIRM.LIMITS');
    (dialog()!.querySelectorAll('footer button')[1] as HTMLButtonElement).click();
    await view();
    const put = backend().expectOne({ method: 'PUT', url: URL_ });
    expect(put.request.headers.get('If-Match')).toBe('"v1"');
    expect(put.request.body).toEqual({ nonBrowserRequests: 'block', sustainedLimits: 'enforce' });
    put.flush(
      {
        data: {
          ...POLICY,
          nonBrowserRequests: 'block',
          sustainedLimits: 'enforce',
          sources: { nonBrowserRequests: 'database', sustainedLimits: 'database' },
        },
      },
      { headers: { ETag: '"v2"' } },
    );
    await view();
    expect(dialog()).toBeNull();
    expect(radio('nonBrowserRequests', 'block').checked).toBe(true);
    expect(root.querySelectorAll('.source')[0].textContent).toContain('SOURCE.DATABASE');
    expect(root.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true);
  });

  it('goes back to report only without asking', async () => {
    const { load, save, choose, view, dialog } = await render();
    await load({ ...POLICY, nonBrowserRequests: 'block' });
    await choose('nonBrowserRequests', 'report');
    await save();
    expect(dialog()).toBeNull();
    const put = backend().expectOne({ method: 'PUT', url: URL_ });
    expect(put.request.body).toEqual({ nonBrowserRequests: 'report' });
    put.flush({ data: POLICY }, { headers: { ETag: '"v2"' } });
    await view();
  });

  async function failSave(
    status: number,
    code: string,
    details?: { field: string; issue: string }[],
  ) {
    const ctx = await render();
    await ctx.load();
    await ctx.choose('nonBrowserRequests', 'block');
    await ctx.save();
    (ctx.dialog()!.querySelectorAll('footer button')[1] as HTMLButtonElement).click();
    await ctx.view();
    backend()
      .expectOne({ method: 'PUT', url: URL_ })
      .flush(errorBody(code, details), { status, statusText: 'x' });
    await ctx.view();
    return ctx;
  }

  it('explains that this browser did not pass the check, and closes the question', async () => {
    const { root, dialog } = await failSave(409, 'CONFLICT', [
      { field: 'nonBrowserRequests', issue: 'browserRequired' },
    ]);
    expect(dialog()).toBeNull();
    expect(root.querySelector('fc-form-error')?.textContent).toContain(
      'SECURITY_POLICY.BROWSER_REQUIRED',
    );
  });

  it('offers to reload after a stale version, and reads again', async () => {
    const { root, button, load } = await failSave(412, 'PRECONDITION_FAILED');
    expect(root.querySelector('[role=alert]')?.textContent).toContain('SECURITY_POLICY.STALE');
    button('SECURITY_POLICY.RELOAD').click();
    await load({ ...POLICY, sustainedLimits: 'enforce' });
    expect(root.querySelector('[role=alert]')).toBeNull();
  });

  it('shows the central message for any other failure (403, any other 409)', async () => {
    const forbidden = await failSave(403, 'FORBIDDEN');
    expect(forbidden.root.querySelector('fc-form-error')?.textContent).toContain(
      'ERRORS.API.FORBIDDEN',
    );
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const other = await failSave(409, 'CONFLICT', [{ field: 'x', issue: 'y' }]);
    expect(other.root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.CONFLICT');
  });
});
