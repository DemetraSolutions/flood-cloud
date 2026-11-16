import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { EmailTemplatesList } from './email-templates-list';
import { EmailTemplateSummary } from './email-template.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const LIST = `${API}/v1/groups/${GROUP}/email-templates`;
const ONE: EmailTemplateSummary = { id: '665f1c2e9b1d4a0012ab34c1', name: 'Conferma', updatedAt: '2026-11-10T09:30:00.000Z' };
const TWO: EmailTemplateSummary = { id: '665f1c2e9b1d4a0012ab34c2', name: 'Senza data', updatedAt: null };
const PLACE_A = '665f1c2e9b1d4a0012ab34d1';
const PLACE_B = '665f1c2e9b1d4a0012ab34d2';
const ALL = ['places:read', 'places:update', 'profile:read'];

const page = (data: EmailTemplateSummary[], next: string | null = null) => ({ data, page: { limit: 25, next } });

async function render(url = `/groups/${GROUP}/email-templates`, profile: Partial<Profile> = {}, extra: Provider[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter([{ path: 'groups/:groupId/email-templates', component: EmailTemplatesList }, { path: '**', children: [] }], withComponentInputBinding()),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`));
  signIn({ role: 'SA', permissions: ALL, ...profile });
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
  const flush = async (data: EmailTemplateSummary[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const cells = (row: number) => [...root.querySelectorAll('tbody tr')[row]!.querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  const dialogButton = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  return { root, view, request, flush, cells, search, dialogButton, toasts };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('EmailTemplatesList', () => {
  it('requests the first page of the group sorted by name and shows the name and the date, never a content', async () => {
    const { request, view, root, cells } = await render();
    const req = request();
    expect(req.request.params.get('limit')).toBe('25');
    expect(req.request.params.get('sort')).toBe('name');
    expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
    req.flush(page([ONE, TWO]));
    await view();
    expect(root.querySelector('h1')?.textContent).toBe('EMAIL_TEMPLATES.TITLE');
    expect(cells(0)[0]).toBe('Conferma');
    expect(cells(0)[1]).toMatch(/2026|10/);
    expect(cells(1)).toEqual(['Senza data', '', 'EMAIL_TEMPLATES.DELETE.ACTION']);
    const links = [...root.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([`/groups/${GROUP}/email-templates/${ONE.id}`, `/groups/${GROUP}/email-templates/${TWO.id}`]);
  });

  it('offers "new" and "delete" only with places:update', async () => {
    const allowed = await render();
    await allowed.flush([ONE]);
    expect(allowed.root.querySelector('a.new')?.getAttribute('href')).toBe(`/groups/${GROUP}/email-templates/new`);
    expect(allowed.root.querySelector('tbody button')).not.toBeNull();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const readOnly = await render(undefined, { permissions: ['places:read', 'profile:read'] });
    await readOnly.flush([ONE]);
    expect(readOnly.root.querySelector('a.new')).toBeNull();
    expect(readOnly.root.querySelector('tbody button')).toBeNull();
    expect(readOnly.root.querySelector('tbody a')).not.toBeNull();
  });

  it('offers to create the first template when there is none', async () => {
    const { flush, root } = await render();
    await flush([]);
    expect(root.querySelector('fc-empty-state')?.textContent).toContain('EMAIL_TEMPLATES.EMPTY');
    expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(`/groups/${GROUP}/email-templates/new`);
  });

  it('reads the search, sort, size and cursor from the URL and ignores invalid values', async () => {
    const { request } = await render(`/groups/${GROUP}/email-templates?q=%20conf%20&sort=-updatedAt&limit=50&cursor=abc`);
    const { params } = request().request;
    expect(Object.fromEntries(params.keys().map((k) => [k, params.get(k)]))).toEqual({ limit: '50', sort: '-updatedAt', q: 'conf', cursor: 'abc' });
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const bad = await render(`/groups/${GROUP}/email-templates?sort=x&limit=7`);
    const sent = bad.request().request.params;
    expect(sent.get('sort')).toBe('name');
    expect(sent.get('limit')).toBe('25');
  });

  it('puts the search in the URL once typing pauses, and clears it', async () => {
    const { flush, root, view, search } = await render();
    await flush([]);
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'conf ';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
    expect(search().get('q')).toBe('conf');
    await flush([]);
    input.value = ' ';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
    expect(search().has('q')).toBe(false);
    await flush([]);
    const event = new Event('submit', { cancelable: true });
    root.querySelector('form')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('sorts by each column both ways, changes the page size and walks the pages', async () => {
    const { flush, root, view, search } = await render();
    await flush([ONE], 'c1');
    const sorts = () => [...root.querySelectorAll<HTMLButtonElement>('th button.sort')];
    sorts()[0]!.click();
    await view();
    expect(search().get('sort')).toBe('-name');
    await flush([ONE], 'c1');
    sorts()[1]!.click();
    await view();
    expect(search().get('sort')).toBe('updatedAt');
    await flush([ONE], 'c1');
    const [previous, next] = [...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button')];
    expect(previous!.disabled).toBe(true);
    next!.click();
    await view();
    expect(search().get('cursor')).toBe('c1');
    await flush([TWO]);
    previous!.click();
    await view();
    expect(search().has('cursor')).toBe(false);
    await flush([ONE], 'c1');
    const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
    select.value = '50';
    select.dispatchEvent(new Event('change'));
    await view();
    expect(search().get('limit')).toBe('50');
    await flush([ONE]);
  });

  it('shows the error state with the request id and retries', async () => {
    const { request, view, root } = await render();
    request().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x', headers: { 'X-Request-Id': 'req-3' } });
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(state.textContent).toContain('req-3');
    state.querySelector('button')!.click();
    await view();
    request().flush(page([ONE]));
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  it('reports an unexpected failure generically', async () => {
    const { root, view } = await render(undefined, {}, [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  describe('deletion', () => {
    const askFor = async (row = 0) => {
      const view = await render();
      await view.flush([ONE, TWO]);
      view.root.querySelectorAll<HTMLButtonElement>('tbody button')[row]!.click();
      await view.view();
      return view;
    };

    it('asks for confirmation naming the template, deletes it and reads the list again', async () => {
      const { root, dialogButton, view, request, toasts } = await askFor();
      expect(root.querySelector('dialog')?.textContent).toContain('EMAIL_TEMPLATES.DELETE.CONFIRM {"name":"Conferma"}');
      expect(dialogButton('EMAIL_TEMPLATES.DELETE.ACTION').getAttribute('data-variant')).toBe('danger');
      dialogButton('EMAIL_TEMPLATES.DELETE.ACTION').click();
      await view();
      const req = backend().expectOne(`${LIST}/${ONE.id}`);
      expect(req.request.method).toBe('DELETE');
      req.flush(null, { status: 204, statusText: 'No Content' });
      await view();
      expect(toasts()).toEqual(['success: EMAIL_TEMPLATES.DELETE.DONE {"name":"Conferma"}']);
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      request().flush(page([TWO]));
      await view();
    });

    it('does nothing when the user cancels', async () => {
      const { root, dialogButton, view } = await askFor();
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    });

    it('lists the places that use the template when the server refuses with 409, by name when known', async () => {
      const page = vi.fn().mockResolvedValue({ data: [{ id: PLACE_A, name: 'Bar Roma' }], page: { limit: 100, next: null } });
      TestBed.configureTestingModule({ providers: [{ provide: ReferenceStore, useValue: { page } }] });
      const { root, dialogButton, view } = await askFor();
      dialogButton('EMAIL_TEMPLATES.DELETE.ACTION').click();
      await view();
      backend().expectOne(`${LIST}/${ONE.id}`).flush(
        errorBody('CONFLICT', [
          { field: `places.${PLACE_A}`, issue: 'referenced' },
          { field: `places.${PLACE_B}`, issue: 'referenced' },
        ]),
        { status: 409, statusText: 'x' },
      );
      await view();
      expect(page).toHaveBeenCalledWith(GROUP, 'places', { ids: [PLACE_A, PLACE_B] });
      const blocked = root.querySelector('.blocked')!;
      expect(blocked.getAttribute('role')).toBe('alert');
      expect(blocked.querySelector('h2')?.textContent).toContain('EMAIL_TEMPLATES.DELETE.BLOCKED_TITLE {"name":"Conferma"}');
      expect([...blocked.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Bar Roma', PLACE_B]);
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      // The next attempt clears the notice; closing it too.
      blocked.querySelector('button')!.click();
      await view();
      expect(root.querySelector('.blocked')).toBeNull();
    });

    it('falls back to the ids when the names cannot be read, and says so in the log', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      TestBed.configureTestingModule({ providers: [{ provide: ReferenceStore, useValue: { page: vi.fn().mockRejectedValue(new Error('down')) } }] });
      const { root, dialogButton, view } = await askFor();
      dialogButton('EMAIL_TEMPLATES.DELETE.ACTION').click();
      await view();
      backend().expectOne(`${LIST}/${ONE.id}`).flush(errorBody('CONFLICT', [{ field: `places.${PLACE_A}`, issue: 'referenced' }]), { status: 409, statusText: 'x' });
      await view();
      expect([...root.querySelectorAll('.blocked li')].map((li) => li.textContent)).toEqual([PLACE_A]);
      expect(warn).toHaveBeenCalled();
    });

    it('shows other failures in a toast and keeps the list', async () => {
      const { root, dialogButton, view, toasts } = await askFor(1);
      dialogButton('EMAIL_TEMPLATES.DELETE.ACTION').click();
      await view();
      backend().expectOne(`${LIST}/${TWO.id}`).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await view();
      expect(toasts()).toEqual(['error: ERRORS.API.NOT_FOUND']);
      expect(root.querySelector('.blocked')).toBeNull();
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    });
  });
});
