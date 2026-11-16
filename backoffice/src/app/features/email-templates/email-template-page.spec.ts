import { Provider, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { EmailTemplatePage, PLACEHOLDERS } from './email-template-page';
import { leaveEmailTemplate } from './email-template-leave';
import { EmailTemplateRecord, TEMPLATE_LIMITS } from './email-template.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const BASE = `${API}/v1/groups/${GROUP}/email-templates`;
const RECORD: EmailTemplateRecord = {
  id: ID,
  name: 'Conferma',
  text: 'Ciao',
  html: '<p style="color:red">Ciao</p>',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
};
const ALL = ['places:read', 'places:update', 'profile:read'];
const L = { name: 'EMAIL_TEMPLATES.FIELD.NAME', text: 'EMAIL_TEMPLATES.FIELD.TEXT', html: 'EMAIL_TEMPLATES.FIELD.HTML', model: 'EMAIL_TEMPLATES.FORM.MODEL' };

async function render(url: string, profile: Partial<Profile> = {}, extra: Provider[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'groups/:groupId/email-templates/new', component: EmailTemplatePage, canDeactivate: [leaveEmailTemplate] },
          { path: 'groups/:groupId/email-templates/:templateId', component: EmailTemplatePage, canDeactivate: [leaveEmailTemplate] },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`));
  signIn({ role: 'SA', permissions: ALL, groupFeatures: fakeFeatureFlags(false, { rooms: true, email: true }), ...profile });
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
  const load = async (record: EmailTemplateRecord = RECORD, etag = '"v1"') => {
    backend().expectOne(`${BASE}/${ID}`).flush({ data: record }, { headers: { ETag: etag } });
    await view();
  };
  const type = async (label: string, value: string) => {
    const field = findControl(scope, label);
    field.value = value;
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => root.querySelector<HTMLButtonElement>('button[type=submit]');
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const frame = () => root.querySelector<HTMLIFrameElement>('fc-email-preview iframe')!;
  /** What the preview frame was sent: the frame loads, then every message posted to it. */
  const preview = async () => {
    const handed = vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => undefined);
    frame().dispatchEvent(new Event('load'));
    await view();
    const received: string[] = [];
    ((handed.mock.calls[0] as unknown as [unknown, unknown, MessagePort[]])[2][0] as MessagePort).onmessage = (event) => received.push((event.data as { html: string }).html);
    return async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return received;
    };
  };
  const dialogButton = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const page = () => harness.routeDebugElement!.componentInstance as EmailTemplatePage;
  return { root, view, load, type, submit, save, toasts, frame, preview, dialogButton, page, router: TestBed.inject(Router), error: (label: string) => errorOf(scope, label), control: (label: string) => findControl(scope, label) };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('EmailTemplatePage: a new template', () => {
  const NEW = `/groups/${GROUP}/email-templates/new`;

  it('shows empty fields, the placeholders and an isolated preview', async () => {
    const { root, frame, preview } = await render(NEW);
    expect(root.querySelector('h1')?.textContent).toContain('EMAIL_TEMPLATES.FORM.NEW_TITLE');
    expect(root.querySelector('.meta')).toBeNull();
    expect([...root.querySelectorAll('.placeholders code')].map((c) => c.textContent)).toEqual([...PLACEHOLDERS]);
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(await (await preview())()).toEqual(['']);
    expect(root.querySelector('button[type=submit]')?.hasAttribute('disabled')).toBe(false);
    expect(root.querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/email-templates`);
  });

  it('follows what is typed in the preview, as text of the frame and never as markup of the page', async () => {
    const { type, preview, root } = await render(NEW);
    const posted = await preview();
    await type(L.html, '<h1>Titolo</h1><script>alert(1)</script>');
    expect((await posted()).at(-1)).toBe('<h1>Titolo</h1><script>alert(1)</script>');
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(root.querySelector('script')).toBeNull();
  });

  it('shows the errors of a field once the user leaves it', async () => {
    const { root, view, error, type } = await render(NEW);
    for (const [index, label] of [L.text, L.html].entries()) {
      await type(label, 'a\u0001b');
      expect(error(label)).toBe('');
      root.querySelectorAll('textarea')[index]!.dispatchEvent(new Event('blur'));
      await view();
      expect(error(label)).toBe('FORM.ISSUE.PATTERN');
    }
    const name = root.querySelector('input')!;
    await type(L.name, '');
    name.dispatchEvent(new Event('blur'));
    await view();
    expect(error(L.name)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('requires a name before sending anything', async () => {
    const { submit, error, type } = await render(NEW);
    await type(L.html, '<p>x</p>');
    await submit();
    expect(error(L.name)).toBe('FORM.ISSUE.REQUIRED');
    await type(L.name, '   ');
    await submit();
    expect(error(L.name)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('checks the limits the server has: name length, control characters, text and HTML in bytes', async () => {
    const { submit, error, type } = await render(NEW);
    await type(L.name, 'x'.repeat(TEMPLATE_LIMITS.name + 1));
    await submit();
    expect(error(L.name)).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(L.name, 'a\u0001b');
    await submit();
    expect(error(L.name)).toBe('FORM.ISSUE.PATTERN');
    await type(L.name, 'Nome');
    await type(L.html, 'a\u0000b');
    await submit();
    expect(error(L.html)).toBe('FORM.ISSUE.PATTERN');
    await type(L.html, '€'.repeat(Math.floor(TEMPLATE_LIMITS.htmlBytes / 3) + 1));
    await submit();
    expect(error(L.html)).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(L.html, 'tab\there\r\nfine');
    expect(error(L.html)).toBe('');
    await type(L.text, 'a'.repeat(TEMPLATE_LIMITS.textBytes + 1));
    await submit();
    expect(error(L.text)).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(L.text, 'a\u001Fb');
    await submit();
    expect(error(L.text)).toBe('FORM.ISSUE.PATTERN');
  });

  it('creates the template with an Idempotency-Key, shows the toast and goes to its page', async () => {
    const { type, submit, toasts, router, view } = await render(NEW);
    await type(L.name, '  Nuovo  ');
    await type(L.html, '<p>ciao</p>');
    await submit();
    const req = backend().expectOne(BASE);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.body).toEqual({ name: 'Nuovo', text: '', html: '<p>ciao</p>' });
    req.flush({ data: { ...RECORD, id: ID, name: 'Nuovo' } }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    await view();
    expect(toasts()).toEqual(['success: EMAIL_TEMPLATES.FORM.CREATED']);
    expect(router.url).toBe(`/groups/${GROUP}/email-templates/${ID}`);
    backend().expectOne(`${BASE}/${ID}`).flush({ data: { ...RECORD, name: 'Nuovo' } });
    await view();
  });

  it('retries with the same key while the body is the same, and with another when it changed', async () => {
    const { type, submit, view, root } = await render(NEW);
    await type(L.name, 'Nuovo');
    await submit();
    const first = backend().expectOne(BASE);
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    await submit();
    const second = backend().expectOne(BASE);
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    await type(L.name, 'Altro');
    await submit();
    const third = backend().expectOne(BASE);
    expect(third.request.headers.get('Idempotency-Key')).not.toBe(key);
    third.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
  });

  it('puts the 422 issues on the fields, and a general message for the ones it cannot place', async () => {
    const { type, submit, view, error, root } = await render(NEW);
    await type(L.name, 'Nuovo');
    await submit();
    backend().expectOne(BASE).flush(
      errorBody('VALIDATION_ERROR', [
        { field: 'html', issue: 'maxLength' },
        { field: 'html', issue: 'pattern' },
        { field: 'name', issue: 'taken' },
      ]),
      { status: 422, statusText: 'x' },
    );
    await view();
    expect(error(L.html)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(error(L.name)).toBe('FORM.ISSUE.TAKEN');
    expect(root.querySelector('fc-form-error')).toBeNull();
    await type(L.name, 'Nuovo 2');
    await type(L.html, '<p>2</p>');
    await submit();
    backend().expectOne(BASE).flush(errorBody('VALIDATION_ERROR', [{ field: 'extra', issue: 'unknown' }]), { status: 422, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.VALIDATION_ERROR');
  });

  it('tells the user the content is too large when the server answers 413', async () => {
    const { type, submit, view, root } = await render(NEW);
    await type(L.name, 'Nuovo');
    await submit();
    backend().expectOne(BASE).flush(errorBody('PAYLOAD_TOO_LARGE'), { status: 413, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.PAYLOAD_TOO_LARGE');
  });

  describe('models', () => {
    it('offers the advanced report and, with the features of the group, the models of the tables and not those of the appointments', async () => {
      const { control } = await render(NEW);
      const options = [...(control(L.model) as HTMLSelectElement).options].map((o) => o.value);
      expect(options).toEqual(['', 'advanced-report', 'table-reservation-notification', 'table-reservation-received', 'table-reservation-confirmed-status', 'table-reservation-refused-status', 'table-reservation-change-status']);
    });

    it('offers only the report to a group without the modules, and the appointment with services', async () => {
      const plain = await render(NEW, { groupFeatures: fakeFeatureFlags(false, { email: true }) });
      expect([...(plain.control(L.model) as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'advanced-report']);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const services = await render(NEW, { groupFeatures: fakeFeatureFlags(false, { email: true, services: true }) });
      expect([...(services.control(L.model) as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'advanced-report', 'appointment-confirmed']);
    });

    it('fills name, text and HTML from the static files of the model', async () => {
      const { type, view, root, preview } = await render(NEW);
      const posted = await preview();
      await type(L.model, 'advanced-report');
      backend().expectOne('/email-templates/advanced-report.txt').flush('Testo del report');
      backend().expectOne('/email-templates/advanced-report.html').flush('<p>Report</p>');
      await view();
      expect((root.querySelector('input') as HTMLInputElement).value).toBe('EMAIL_TEMPLATES.MODEL.ADVANCED_REPORT');
      expect(root.querySelectorAll('textarea')[0]!.value).toBe('Testo del report');
      expect(root.querySelectorAll('textarea')[1]!.value).toBe('<p>Report</p>');
      expect((await posted()).at(-1)).toBe('<p>Report</p>');
    });

    it('asks before replacing what was typed, and keeps it when the user refuses', async () => {
      const { type, view, root, dialogButton } = await render(NEW);
      await type(L.name, 'Mio');
      await type(L.model, 'advanced-report');
      expect(root.querySelector('dialog[open]')?.textContent).toContain('EMAIL_TEMPLATES.MODEL_REPLACE.MESSAGE');
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect((root.querySelector('input') as HTMLInputElement).value).toBe('Mio');
      expect((root.querySelector('select') as HTMLSelectElement).value).toBe('');
      await type(L.model, 'advanced-report');
      dialogButton('EMAIL_TEMPLATES.MODEL_REPLACE.CONFIRM').click();
      await view();
      backend().expectOne('/email-templates/advanced-report.txt').flush('T');
      backend().expectOne('/email-templates/advanced-report.html').flush('<p>H</p>');
      await view();
      expect((root.querySelector('input') as HTMLInputElement).value).toBe('EMAIL_TEMPLATES.MODEL.ADVANCED_REPORT');
    });

    it('does nothing for the empty choice, and reports a model that cannot be read', async () => {
      const { type, view, root, page } = await render(NEW);
      (page() as unknown as { onModel(id: string): void }).onModel('');
      await type(L.model, 'advanced-report');
      backend().expectOne('/email-templates/advanced-report.txt').flush('', { status: 404, statusText: 'x' });
      backend().expectOne('/email-templates/advanced-report.html').flush('', { status: 404, statusText: 'x' });
      await view();
      expect(root.querySelector('fc-form-error')).not.toBeNull();
    });

    it('ignores a model that does not exist', async () => {
      const { page, view } = await render(NEW);
      await (page() as unknown as { applyModel(id: string): Promise<void> }).applyModel('nope');
      await view();
    });

    it('is not offered to a user who cannot write', async () => {
      const { root } = await render(NEW, { permissions: ['places:read', 'profile:read'] });
      expect(root.querySelector('fc-select')).toBeNull();
      expect(root.querySelector('button[type=submit]')).toBeNull();
    });
  });
});

describe('EmailTemplatePage: an existing template', () => {
  const EDIT = `/groups/${GROUP}/email-templates/${ID}`;

  it('shows the template, its date and the preview of its HTML', async () => {
    const { root, load, control, preview } = await render(EDIT);
    expect(root.querySelector('fc-select')).toBeNull();
    await load();
    expect(root.querySelector('h1')?.textContent).toContain('EMAIL_TEMPLATES.FORM.EDIT_TITLE');
    expect((control(L.name) as HTMLInputElement).value).toBe('Conferma');
    expect(root.querySelectorAll('textarea')[0]!.value).toBe('Ciao');
    expect(root.querySelectorAll('textarea')[1]!.value).toBe(RECORD.html);
    expect(root.querySelector('.meta')?.textContent).toContain('EMAIL_TEMPLATES.FORM.UPDATED');
    expect((await (await preview())()).at(-1)).toBe(RECORD.html);
  });

  it('shows no date for a template that has none', async () => {
    const { root, load } = await render(EDIT);
    await load({ ...RECORD, updatedAt: null });
    expect(root.querySelector('.meta')?.textContent).toContain('{"date":""}');
  });

  it('saves only what changed with the version in If-Match, and uses the new version for the next save', async () => {
    const { load, type, submit, save, view, toasts, router } = await render(EDIT);
    await load();
    expect(save()!.disabled).toBe(true);
    await type(L.html, '<p>nuovo</p>');
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.body).toEqual({ html: '<p>nuovo</p>' });
    req.flush({ data: { ...RECORD, html: '<p>nuovo</p>' } }, { headers: { ETag: '"v2"' } });
    await view();
    expect(toasts()).toEqual(['success: EMAIL_TEMPLATES.FORM.SAVED']);
    expect(save()!.disabled).toBe(true);
    expect(router.url).toBe(EDIT);
    await type(L.name, 'Rinominato');
    await submit();
    const second = backend().expectOne(`${BASE}/${ID}`);
    expect(second.request.headers.get('If-Match')).toBe('"v2"');
    expect(second.request.body).toEqual({ name: 'Rinominato' });
    second.flush({ data: { ...RECORD, name: 'Rinominato' } }, { headers: { ETag: '"v3"' } });
    await view();
  });

  it('sends the text on its own when only the text changed', async () => {
    const { load, type, submit, view } = await render(EDIT);
    await load();
    await type(L.text, 'Altro testo');
    await submit();
    const req = backend().expectOne(`${BASE}/${ID}`);
    expect(req.request.body).toEqual({ text: 'Altro testo' });
    req.flush({ data: { ...RECORD, text: 'Altro testo' } });
    await view();
  });

  it('answers a 412 asking to read the template again, and reloads it on request', async () => {
    const { load, type, submit, view, root } = await render(EDIT);
    await load();
    await type(L.name, 'Mio');
    await submit();
    backend().expectOne(`${BASE}/${ID}`).flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-form-error')?.textContent).toContain('EMAIL_TEMPLATES.FORM.STALE');
    const reload = [...root.querySelectorAll<HTMLButtonElement>('form button')].find((b) => b.textContent?.trim() === 'EMAIL_TEMPLATES.FORM.RELOAD')!;
    reload.click();
    await view();
    await load({ ...RECORD, name: 'Di un altro' }, '"v9"');
    expect(root.querySelector('fc-form-error')).toBeNull();
    expect((root.querySelector('input') as HTMLInputElement).value).toBe('Di un altro');
  });

  it('does not offer to reload for a failure that is not a 412', async () => {
    const { load, type, submit, view, root } = await render(EDIT);
    await load();
    await type(L.name, 'Mio');
    await submit();
    backend().expectOne(`${BASE}/${ID}`).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(root.querySelector('form button:not([type=submit])')).toBeNull();
  });

  it('is read only without places:update, with the preview', async () => {
    const { load, root, preview, control } = await render(EDIT, { permissions: ['places:read', 'profile:read'] });
    await load();
    expect((control(L.name) as HTMLInputElement).disabled).toBe(true);
    expect(root.querySelectorAll('textarea')[1]!.disabled).toBe(true);
    expect(root.querySelector('button[type=submit]')).toBeNull();
    expect((await (await preview())()).at(-1)).toBe(RECORD.html);
  });

  it('shows the error state with a way back when the template cannot be read, and retries', async () => {
    const { root, view, load } = await render(EDIT);
    backend().expectOne(`${BASE}/${ID}`).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x', headers: { 'X-Request-Id': 'req-9' } });
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(state.textContent).toContain('req-9');
    expect(root.querySelector('a[href]')?.getAttribute('href')).toBe(`/groups/${GROUP}/email-templates`);
    state.querySelector('button')!.click();
    await view();
    await load();
    expect(root.querySelector('fc-error-state')).toBeNull();
  });

  it('reports an unexpected failure to read generically', async () => {
    const { root, view } = await render(EDIT, {}, [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  describe('leaving the page', () => {
    it('leaves at once when nothing changed, or when the user cannot write', async () => {
      const { load, page } = await render(EDIT);
      await load();
      expect(page().confirmLeave()).toBe(true);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const readOnly = await render(EDIT, { permissions: ['places:read', 'profile:read'] });
      await readOnly.load();
      expect(readOnly.page().confirmLeave()).toBe(true);
    });

    it('asks first when something is unsaved: leaving, or staying', async () => {
      const { load, type, page, view, dialogButton, root } = await render(EDIT);
      await load();
      await type(L.name, 'Modificato');
      const stay = page().confirmLeave() as Promise<boolean>;
      await view();
      expect(root.querySelector('dialog[open]')?.textContent).toContain('EMAIL_TEMPLATES.LEAVE.MESSAGE');
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(await stay).toBe(false);
      const leave = page().confirmLeave() as Promise<boolean>;
      await view();
      dialogButton('EMAIL_TEMPLATES.LEAVE.CONFIRM').click();
      await view();
      expect(await leave).toBe(true);
      expect(root.querySelector('dialog[open]')).toBeNull();
    });

    it('is the guard of the routes, and does not ask after a save', async () => {
      const { load, type, submit, view, router, dialogButton } = await render(EDIT);
      await load();
      await type(L.name, 'Modificato');
      const blocked = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(await blocked).toBe(false);
      await submit();
      backend().expectOne(`${BASE}/${ID}`).flush({ data: { ...RECORD, name: 'Modificato' } });
      await view();
      expect(await router.navigateByUrl('/elsewhere')).toBe(true);
    });
  });
});
