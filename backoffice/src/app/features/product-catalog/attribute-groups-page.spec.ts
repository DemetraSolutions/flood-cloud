import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AttributeGroupsPage } from './attribute-groups-page';
import { AttributeGroup } from './product-catalog.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const LIST = `${API}/v1/groups/${GROUP}/product-attribute-groups`;
const LANGUAGES = `${API}/v1/groups/${GROUP}/lookup/languages`;
const T = 'PRODUCT_CATALOG.ATTRIBUTES';
const WRITE = ['products:read', 'products:update', 'places:update', 'profile:read'];

const group = (n: number, name = `Gruppo ${n}`): AttributeGroup => ({
  id: `665f1c2e9b1d4a0012ab35${String(n).padStart(2, '0')}`,
  name: { it: name },
  attributes: [{ id: `665f1c2e9b1d4a0012ab36${String(n).padStart(2, '0')}`, name: { it: 'S' } }],
  createdAt: null,
  updatedAt: null,
});
const page = (data: AttributeGroup[], next: string | null = null) => ({ data, page: { limit: 100, next } });
const ONE = group(1);
const TWO = group(2);

interface Options {
  profile?: Partial<Profile> | null;
  languages?: string[] | 'fail' | 'empty';
  language?: 'it';
  extra?: { provide: unknown; useValue: unknown }[];
}

async function render(options: Options = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...((options.extra ?? []) as never[]),
      provideRouter([]),
    ],
  });
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`));
  if (options.language !== undefined) {
    vi.spyOn(i18n, 'language').mockReturnValue(options.language);
  }
  if (options.profile !== null) {
    signIn({ role: 'SA', permissions: WRITE, ...options.profile });
  }
  const fixture = TestBed.createComponent(AttributeGroupsPage);
  fixture.componentRef.setInput('groupId', GROUP);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const scope = { nativeElement: root } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const list = (cursor?: string) =>
    backend().expectOne((r) => r.method === 'GET' && r.url === LIST && (r.params.get('cursor') ?? undefined) === cursor);
  /** Answers the list and, when the user may read them, the languages of the group. */
  const boot = async (groups: AttributeGroup[] = [ONE, TWO], next: string | null = null) => {
    await view();
    // A platform or dealer administrator without working group also reads the group of the record.
    for (const request of backend().match(`${API}/v1/groups/${GROUP}`)) {
      request.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    }
    list().flush(page(groups, next));
    for (const request of backend().match((r) => r.url === LANGUAGES)) {
      if (options.languages === 'fail') {
        request.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      } else {
        const codes = options.languages === 'empty' ? [] : (options.languages ?? ['it']);
        request.flush({ data: codes.map((code) => ({ code })) });
      }
    }
    await view();
  };
  const sections = () => [...root.querySelectorAll<HTMLElement>('fc-attribute-group-section')];
  const titles = () => sections().map((s) => s.querySelector('button.toggle span')?.textContent);
  const createForm = () => root.querySelector<HTMLFormElement>('section.create form');
  const type = async (label: string, value: string) => {
    const field = findControl(scope, label);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await view();
  };
  const submit = async () => {
    createForm()!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  const label = (code: string) => `${T}.GROUP_NAME_IN {"language":"${new Intl.DisplayNames(['it'], { type: 'language' }).of(code)}"}`;
  const posts = () => backend().expectOne((r) => r.method === 'POST' && r.url === LIST);
  const component = fixture.componentInstance as unknown as { groups(): unknown[]; next(): string | null };
  return { component, root, view, boot, list, sections, titles, createForm, type, submit, toasts, button, label, posts, error: (l: string) => errorOf(scope, l), control: (l: string) => findControl(scope, l) };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('AttributeGroupsPage: the list', () => {
  it('has no groups and no next page before the first read arrives', async () => {
    const { boot, component } = await render();
    expect(component.groups()).toEqual([]);
    expect(component.next()).toBeNull();
    await boot([]);
  });

  it('reads the first 100 groups sorted by name and shows each as a collapsed section', async () => {
    const { root, view, list, titles, sections } = await render();
    await view();
    expect(root.querySelector('h1')?.textContent).toBe(`${T}.TITLE`);
    expect(root.querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    const req = list();
    expect(req.request.params.get('limit')).toBe('100');
    expect(req.request.params.get('sort')).toBe('name');
    expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
    req.flush(page([ONE, TWO]));
    backend().match((r) => r.url === LANGUAGES).forEach((r) => r.flush({ data: [{ code: 'it' }] }));
    await view();
    expect(root.querySelector('[role=status]')).toBeNull();
    expect(titles()).toEqual(['Gruppo 1', 'Gruppo 2']);
    expect(sections()[0]!.querySelector('button.toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('button.toggle')?.textContent).toContain(`${T}.COUNT {"count":1}`);
  });

  it('says there are no groups', async () => {
    const { root, boot } = await render();
    await boot([]);
    expect(root.textContent).toContain(`${T}.EMPTY_GROUPS`);
    expect(root.querySelector('fc-attribute-group-section')).toBeNull();
  });

  it('reports a failed read with its request id and reads again on retry', async () => {
    const { root, view, list, titles } = await render();
    await view();
    list().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x', headers: { 'X-Request-Id': 'req-9' } });
    backend().match((r) => r.url === LANGUAGES).forEach((r) => r.flush({ data: [{ code: 'it' }] }));
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('PRODUCT_CATALOG.LOAD_ERROR');
    expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    state.querySelector('button')!.click();
    await view();
    list().flush(page([ONE]));
    await view();
    expect(root.querySelector('fc-error-state')).toBeNull();
    expect(titles()).toEqual(['Gruppo 1']);
  });

  it('reports an unexpected failure generically', async () => {
    const { root, view } = await render({ extra: [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }] });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('shows more groups with the cursor, then stops offering them', async () => {
    const { root, boot, view, list, button, titles } = await render();
    await boot([ONE], 'c1');
    const more = button(`${T}.MORE`)!;
    more.click();
    await view();
    expect(more.getAttribute('aria-busy')).toBe('true');
    const req = list('c1');
    expect(req.request.params.get('limit')).toBe('100');
    expect(req.request.params.get('sort')).toBe('name');
    req.flush(page([TWO], 'c2'));
    await view();
    expect(titles()).toEqual(['Gruppo 1', 'Gruppo 2']);
    expect(more.hasAttribute('aria-busy')).toBe(false);
    button(`${T}.MORE`)!.click();
    await view();
    list('c2').flush(page([group(3)], null));
    await view();
    expect(titles()).toEqual(['Gruppo 1', 'Gruppo 2', 'Gruppo 3']);
    expect(button(`${T}.MORE`)).toBeUndefined();
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('reports a failure to show more, keeps what was read, and clears the message on the next try', async () => {
    const { root, boot, view, list, button, titles } = await render();
    await boot([ONE], 'c1');
    button(`${T}.MORE`)!.click();
    await view();
    list('c1').flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(titles()).toEqual(['Gruppo 1']);
    button(`${T}.MORE`)!.click();
    await view();
    expect(root.querySelector('fc-form-error')).toBeNull();
    list('c1').flush(page([TWO]));
    await view();
    expect(titles()).toEqual(['Gruppo 1', 'Gruppo 2']);
  });

  it('starts from the first page again when the list is read after a creation', async () => {
    const { boot, view, list, button, titles, type, submit, posts, label } = await render();
    await boot([ONE], 'c1');
    button(`${T}.MORE`)!.click();
    await view();
    list('c1').flush(page([TWO]));
    await view();
    expect(button(`${T}.MORE`)).toBeUndefined();
    await type(label('it'), 'Nuovo');
    await submit();
    posts().flush({ data: group(3) }, { status: 201, statusText: 'Created' });
    await view();
    list().flush(page([ONE], 'c1'));
    await view();
    expect(titles()).toEqual(['Gruppo 1']);
    expect(button(`${T}.MORE`)).toBeDefined();
  });

  it('removes a group from the list once its section reports it deleted, and shows the empty state after the last one', async () => {
    const { root, boot, view, titles, toasts } = await render();
    await boot([ONE, TWO]);
    for (const [index, id] of [ONE.id, TWO.id].entries()) {
      const section = root.querySelector('fc-attribute-group-section')!;
      section.querySelector<HTMLButtonElement>('button.toggle')!.click();
      await view();
      backend().expectOne(`${LIST}/${id}`).flush({ data: [ONE, TWO][index] }, { headers: { ETag: '"v1"' } });
      await view();
      section.querySelector<HTMLButtonElement>('.actions button:not([type=submit])')!.click();
      await view();
      const confirm = [...section.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === `${T}.DELETE.ACTION`)!;
      confirm.click();
      await view();
      backend().expectOne((r) => r.method === 'DELETE' && r.url === `${LIST}/${id}`).flush(null, { status: 204, statusText: 'No Content' });
      await view();
      expect(titles()).toEqual(index === 0 ? ['Gruppo 2'] : []);
    }
    expect(root.textContent).toContain(`${T}.EMPTY_GROUPS`);
    expect(toasts()).toEqual([`success: ${T}.DELETE.DONE {"name":"Gruppo 1"}`, `success: ${T}.DELETE.DONE {"name":"Gruppo 2"}`]);
  });
});

describe('AttributeGroupsPage: languages', () => {
  it('reads the languages of the group for who may update places, and shows a name field for each', async () => {
    const { boot, label, control } = await render({ languages: ['it', 'en'] });
    await boot();
    expect(control(label('it'))).toBeTruthy();
    expect(control(label('en'))).toBeTruthy();
  });

  it('reads them with products permissions alone', async () => {
    const { boot, control, label } = await render({ profile: { permissions: ['products:read', 'products:update'] }, languages: ['it', 'en'] });
    await boot();
    expect(control(label('en'))).toBeTruthy();
  });

  it.each(['fail', 'empty'] as const)('falls back on Italian when the read gives %s', async (languages) => {
    const { boot, root } = await render({ languages });
    await boot();
    expect(root.querySelectorAll('section.create fc-text-field')).toHaveLength(1);
  });

  const hints = (root: HTMLElement) =>
    [...root.querySelectorAll('section.create fc-text-field')].map((f) => f.textContent?.includes('PRODUCT_CATALOG.FIELD.REQUIRED_LANGUAGE'));

  it('asks for the name in the language of the user when the group has it', async () => {
    const { boot, root } = await render({ language: 'it', languages: ['en', 'it'] });
    await boot();
    expect(hints(root)).toEqual([false, true]);
  });

  it('asks for the name in the first language of the group when it does not have the one of the user', async () => {
    const { boot, root } = await render({ languages: ['fr', 'en'] });
    await boot();
    expect(hints(root)).toEqual([true, false]);
  });
});

describe('AttributeGroupsPage: who may write', () => {
  it.each(['PSA', 'D', 'SA'])('shows the form of a new group to a %s with products:update', async (role) => {
    const { root, boot, createForm } = await render({ profile: { role: role as Profile['role'] } });
    await boot();
    expect(createForm()).not.toBeNull();
    expect(root.querySelector('section.create h2')?.textContent).toBe(`${T}.NEW`);
    expect(root.querySelector('[role=note]')).toBeNull();
    expect(root.querySelector('button.toggle')).not.toBeNull();
  });

  it.each(['CA', 'PA'])('shows %s the groups read only, with a note and no form', async (role) => {
    const { root, boot, createForm, view } = await render({ profile: { role: role as Profile['role'] } });
    await boot();
    expect(createForm()).toBeNull();
    expect(root.querySelector('[role=note]')?.textContent).toBe(`${T}.READ_ONLY`);
    root.querySelector<HTMLButtonElement>('button.toggle')!.click();
    await view();
    backend().expectOne(`${LIST}/${ONE.id}`).flush({ data: ONE }, { headers: { ETag: '"v1"' } });
    await view();
    expect(root.querySelector('fc-attribute-group-section .actions')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('fc-attribute-group-section input')!.disabled).toBe(true);
  });

  it('shows no form without products:update', async () => {
    const { boot, createForm, root } = await render({ profile: { permissions: ['products:read', 'places:update'] } });
    await boot();
    expect(createForm()).toBeNull();
    expect(root.querySelector('[role=note]')).not.toBeNull();
  });

  it('shows no form when there is no profile', async () => {
    const { boot, createForm, root } = await render({ profile: null });
    await boot();
    expect(createForm()).toBeNull();
    expect(root.querySelector('[role=note]')).not.toBeNull();
  });
});

describe('AttributeGroupsPage: creating a group', () => {
  it('requires a name in the required language and sends nothing without it', async () => {
    const { boot, submit, error, type, label } = await render();
    await boot();
    await submit();
    expect(error(label('it'))).toBe('FORM.ISSUE.REQUIRED');
    await type(label('it'), '   ');
    await submit();
    expect(error(label('it'))).toBe('FORM.ISSUE.REQUIRED');
    expect(document.activeElement).toBe(findControlOf(label('it')));
  });

  it('shows the error of a field once the user leaves it', async () => {
    const { boot, root, view, error, type, label } = await render();
    await boot();
    await type(label('it'), 'a\u0001b');
    expect(error(label('it'))).toBe('');
    root.querySelector('section.create input')!.dispatchEvent(new Event('blur'));
    await view();
    expect(error(label('it'))).toBe('FORM.ISSUE.PATTERN');
  });

  it('creates the group with an Idempotency-Key, reads the list again and leaves a clean form', async () => {
    const { root, boot, view, submit, type, label, posts, list, toasts, titles, control } = await render({ languages: ['it', 'en'] });
    await boot();
    await type(label('it'), '  Taglie ');
    await submit();
    const req = posts();
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.body).toEqual({ name: { it: 'Taglie' } });
    expect(root.querySelector('section.create button[type=submit]')?.getAttribute('aria-busy')).toBe('true');
    req.flush({ data: group(3, 'Taglie') }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual([`success: ${T}.CREATED`]);
    list().flush(page([ONE, group(3, 'Taglie')]));
    await view();
    expect(titles()).toEqual(['Gruppo 1', 'Taglie']);
    expect((control(label('it')) as HTMLInputElement).value).toBe('');
    expect(root.querySelector('section.create button[type=submit]')?.hasAttribute('aria-busy')).toBe(false);
    await submit();
    expect(backend().match((r) => r.method === 'POST')).toHaveLength(0);
    await type(label('it'), 'Taglie');
    await submit();
    expect(posts().request.headers.get('Idempotency-Key')).not.toBe(req.request.headers.get('Idempotency-Key'));
  });

  it('keeps the same Idempotency-Key when the same body is sent again after a failure', async () => {
    const { root, boot, view, submit, type, label, posts } = await render();
    await boot();
    await type(label('it'), 'Taglie');
    await submit();
    const first = posts();
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('section.create fc-form-error')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    await submit();
    const second = posts();
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view();
    expect(root.querySelector('section.create fc-form-error')?.textContent).toContain('ERRORS.API.FORBIDDEN');
  });

  it('puts a 422 on the name field', async () => {
    const { root, boot, view, submit, type, label, posts, error } = await render();
    await boot();
    await type(label('it'), 'Taglie');
    await submit();
    posts().flush(errorBody('VALIDATION_ERROR', [{ field: 'name.it', issue: 'maxLength' }]), { status: 422, statusText: 'x' });
    await view();
    expect(error(label('it'))).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(root.querySelector('section.create fc-form-error')).toBeNull();
  });

  it('shows a message for the form when the 422 names something else, and clears it on the next try', async () => {
    const { root, boot, view, submit, type, label, posts } = await render();
    await boot();
    await type(label('it'), 'Taglie');
    await submit();
    posts().flush(errorBody('VALIDATION_ERROR', [{ field: 'other', issue: 'unknown' }]), { status: 422, statusText: 'x' });
    await view();
    expect(root.querySelector('section.create fc-form-error')?.textContent).toContain('ERRORS.API.VALIDATION_ERROR');
    await submit();
    expect(root.querySelector('section.create fc-form-error')).toBeNull();
    posts().flush(errorBody('VALIDATION_ERROR'), { status: 422, statusText: 'x' });
    await view();
    expect(root.querySelector('section.create fc-form-error')?.textContent).toContain('ERRORS.API.VALIDATION_ERROR');
  });
});

function findControlOf(labelText: string): HTMLInputElement {
  const labelElement = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === labelText)!;
  return document.querySelector<HTMLInputElement>(`#${labelElement.htmlFor}`)!;
}
