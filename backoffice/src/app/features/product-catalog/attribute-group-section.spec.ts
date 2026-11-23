import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AttributeGroupSection } from './attribute-group-section';
import { AttributeGroup } from './product-catalog.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34e1';
const ONE = '665f1c2e9b1d4a0012ab34f1';
const TWO = '665f1c2e9b1d4a0012ab34f2';
const URL = `${API}/v1/groups/${GROUP}/product-attribute-groups/${ID}`;
const PRODUCTS = `${API}/v1/groups/${GROUP}/lookup/products`;
const P1 = '665f1c2e9b1d4a0012ab3501';
const P2 = '665f1c2e9b1d4a0012ab3502';

const RECORD: AttributeGroup = {
  id: ID,
  name: { it: 'Taglie', en: 'Sizes' },
  attributes: [
    { id: ONE, name: { it: 'S', en: 'Small' } },
    { id: TWO, name: { it: 'M' } },
  ],
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: null,
};

const T = 'PRODUCT_CATALOG.ATTRIBUTES';

interface Options {
  group?: AttributeGroup;
  writable?: boolean;
  languages?: string[];
  required?: string;
  language?: 'it';
  extra?: { provide: unknown; useValue: unknown }[];
}

async function render(options: Options = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [...provideApiTesting(), ...((options.extra ?? []) as never[])],
  });
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  if (options.language !== undefined) {
    vi.spyOn(i18n, 'language').mockReturnValue(options.language);
  }
  const fixture: ComponentFixture<AttributeGroupSection> = TestBed.createComponent(AttributeGroupSection);
  fixture.componentRef.setInput('groupId', GROUP);
  fixture.componentRef.setInput('group', options.group ?? RECORD);
  fixture.componentRef.setInput('languages', options.languages ?? ['it']);
  fixture.componentRef.setInput('required', options.required ?? 'it');
  fixture.componentRef.setInput('writable', options.writable ?? true);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const deleted: string[] = [];
  fixture.componentInstance.deleted.subscribe((id) => deleted.push(id));
  const view = async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  const toggle = () => root.querySelector<HTMLButtonElement>('button.toggle')!;
  const open = async (record: AttributeGroup = options.group ?? RECORD, etag: string | null = '"v1"') => {
    toggle().click();
    await view();
    backend().expectOne(URL).flush({ data: record }, etag === null ? {} : { headers: { ETag: etag } });
    await view();
  };
  const fieldsets = () => [...root.querySelectorAll<HTMLFieldSetElement>('fieldset.attribute')];
  const inputs = (index: number) => [...fieldsets()[index]!.querySelectorAll<HTMLInputElement>('input')];
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const blur = async (input: HTMLInputElement) => {
    input.dispatchEvent(new Event('blur'));
    await view();
  };
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => root.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const press = async (button: HTMLButtonElement | null | undefined) => {
    button!.click();
    await view();
  };
  const addButton = () =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === `${T}.ADD_ACTION`)!;
  const removeButton = (index: number) => fieldsets()[index]!.querySelector<HTMLButtonElement>('button');
  const deleteTrigger = () => root.querySelector<HTMLButtonElement>('.actions button:not([type=submit])')!;
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const text = () => root.textContent ?? '';
  const failWith = async (status: number, code: string, details?: { field: string; issue: string }[]) => {
    backend().expectOne((r) => r.method === 'PATCH' && r.url === URL).flush(errorBody(code, details), { status, statusText: code });
    await view();
  };
  const errors = () => [...root.querySelectorAll('[id$="-error"]')].map((e) => e.textContent?.trim()).filter((t) => t !== '');
  return { fixture, root, deleted, view, toggle, open, fieldsets, inputs, type, blur, submit, save, press, addButton, removeButton, deleteTrigger, dialogButton, toasts, text, failWith, errors };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('AttributeGroupSection: collapsed', () => {
  it('shows the name and the count on a button that controls its panel, without reading the group', async () => {
    const { toggle, root } = await render();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    const panel = root.querySelector<HTMLElement>('[role=region]')!;
    expect(toggle().getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute('aria-label')).toBe('Taglie');
    expect(toggle().textContent).toContain('Taglie');
    expect(toggle().textContent).toContain(`${T}.COUNT {"count":2}`);
  });

  it('names the group in the language of the interface', async () => {
    const { toggle } = await render({ language: 'it', group: { ...RECORD, name: { en: 'Sizes' } } });
    expect(toggle().textContent).toContain('Sizes');
  });
});

describe('AttributeGroupSection: opening', () => {
  it('reads the group when opened, then shows its attributes with a name for each language', async () => {
    const { toggle, view, root, inputs, fieldsets, save } = await render();
    toggle().click();
    await view();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('GET');
    req.flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    await view();
    expect(root.querySelector('[role=status]')).toBeNull();
    expect(root.querySelector<HTMLElement>('[role=region]')!.hidden).toBe(false);
    expect(fieldsets()).toHaveLength(3);
    expect(inputs(0).map((i) => i.value)).toEqual(['S', 'Small']);
    expect(inputs(1).map((i) => i.value)).toEqual(['M', '']);
    expect(inputs(2).map((i) => i.value)).toEqual(['', '']);
    expect(fieldsets()[0]!.querySelector('legend')?.textContent).toBe(`${T}.ROW {"number":1}`);
    expect(save().disabled).toBe(true);
    toggle().click();
    await view();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    toggle().click();
    await view();
    // Closing and reopening keeps the group and what was typed: nothing is read again.
    backend().expectNone(URL);
    expect(inputs(0)).toHaveLength(2);
  });

  it('reports a failure that is not an answer of the backend with the generic message', async () => {
    const { toggle, view, root } = await render();
    toggle().click();
    await view();
    backend().expectOne(URL).error(new ProgressEvent('error'));
    await view();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('ERRORS.');
  });

  it('says an empty group has no attributes', async () => {
    const { open, text } = await render({ group: { ...RECORD, attributes: [] } });
    await open({ ...RECORD, attributes: [] });
    expect(text()).toContain(`${T}.EMPTY`);
  });

  it('reports a failed read with the message of the backend and reads again on retry', async () => {
    const { toggle, view, root, press, inputs } = await render();
    toggle().click();
    await view();
    backend().expectOne(URL).flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    await press([...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'COMMON.RETRY'));
    backend().expectOne(URL).flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    await view();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(inputs(0)).toHaveLength(2);
  });
});

describe('AttributeGroupSection: editing', () => {
  it('saves the whole list with the version read, ids only for the existing attributes, and uses the new version afterwards', async () => {
    const { open, inputs, type, save, submit, view, toasts } = await render();
    await open();
    await type(inputs(0)[0]!, '  Piccola ');
    expect(save().disabled).toBe(false);
    await submit();
    const req = backend().expectOne((r) => r.method === 'PATCH' && r.url === URL);
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.body).toEqual({
      attributes: [
        { id: ONE, name: { it: 'Piccola', en: 'Small' } },
        { id: TWO, name: { it: 'M' } },
      ],
    });
    req.flush(
      { data: { ...RECORD, attributes: [{ id: ONE, name: { it: 'Piccola', en: 'Small' } }, RECORD.attributes[1]] } },
      { headers: { ETag: '"v2"' } },
    );
    await view();
    expect(toasts()).toEqual([`success: ${T}.SAVED {"name":"Taglie"}`]);
    expect(save().disabled).toBe(true);
    await type(inputs(1)[1]!, 'Medium');
    await submit();
    const next = backend().expectOne((r) => r.method === 'PATCH' && r.url === URL);
    expect(next.request.headers.get('If-Match')).toBe('"v2"');
    next.flush({ data: RECORD }, {});
    await view();
  });

  it('sends no If-Match when the read had no version', async () => {
    const { open, inputs, type, submit, view } = await render();
    await open(RECORD, null);
    await type(inputs(0)[0]!, 'X');
    await submit();
    const req = backend().expectOne((r) => r.method === 'PATCH' && r.url === URL);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: RECORD }, {});
    await view();
  });

  it('refuses a row without a name in the required language before sending anything', async () => {
    const { open, inputs, type, blur, submit, errors, save } = await render();
    await open();
    await type(inputs(0)[1]!, '');
    await type(inputs(0)[0]!, '');
    await blur(inputs(0)[0]!);
    expect(errors()).toEqual(['FORM.ISSUE.REQUIRED']);
    await submit();
    expect(save().disabled).toBe(false);
    expect(document.activeElement).toBe(inputs(0)[0]);
  });

  it('adds an attribute through the row "Add", without id, and empties that row', async () => {
    const { open, inputs, type, addButton, press, submit, errors, view, fieldsets } = await render();
    await open();
    await press(addButton());
    expect(errors()).toEqual(['FORM.ISSUE.REQUIRED']);
    expect(fieldsets()).toHaveLength(3);
    await type(inputs(2)[1]!, 'Large');
    expect(errors()).toEqual([]);
    await press(addButton());
    expect(fieldsets()).toHaveLength(4);
    expect(inputs(2).map((i) => i.value)).toEqual(['', 'Large']);
    await type(inputs(3)[0]!, 'L');
    await press(addButton());
    expect(fieldsets()).toHaveLength(5);
    expect(inputs(3).map((i) => i.value)).toEqual(['L', '']);
    expect(inputs(4).map((i) => i.value)).toEqual(['', '']);
    await submit();
    const req = backend().expectOne((r) => r.method === 'PATCH' && r.url === URL);
    expect((req.request.body as { attributes: object[] }).attributes.slice(2)).toEqual([{ name: { en: 'Large' } }, { name: { it: 'L' } }]);
    req.flush({ data: { ...RECORD, attributes: [...RECORD.attributes, { id: '665f1c2e9b1d4a0012ab34f3', name: { it: 'L', en: 'Large' } }] } }, {});
    await view();
  });

  it('removes an attribute and says so when none is left', async () => {
    const { open, removeButton, press, submit, fieldsets, text, view } = await render();
    await open();
    expect(removeButton(0)?.getAttribute('aria-label')).toBe(`${T}.REMOVE_LABEL {"number":1}`);
    await press(removeButton(0));
    expect(fieldsets()).toHaveLength(2);
    await submit();
    const req = backend().expectOne((r) => r.method === 'PATCH' && r.url === URL);
    expect(req.request.body).toEqual({ attributes: [{ id: TWO, name: { it: 'M' } }] });
    req.flush({ data: { ...RECORD, attributes: [RECORD.attributes[1]] } }, {});
    await view();
    await press(removeButton(0));
    expect(text()).toContain(`${T}.EMPTY`);
  });

  it('stops adding at the limit of 200 attributes', async () => {
    const many = Array.from({ length: 199 }, (_, i) => ({ id: `665f1c2e9b1d4a0012ab${String(i).padStart(4, '0')}`, name: { it: `A${i}` } }));
    const { open, inputs, type, addButton, press, text, fieldsets } = await render({ group: { ...RECORD, attributes: many } });
    await open({ ...RECORD, attributes: many });
    expect(addButton().disabled).toBe(false);
    expect(text()).not.toContain(`${T}.LIMIT`);
    await type(inputs(199)[0]!, 'Last');
    await press(addButton());
    expect(fieldsets()).toHaveLength(201);
    expect(addButton().disabled).toBe(true);
    expect(text()).toContain(`${T}.LIMIT`);
  });
});

describe('AttributeGroupSection: refused saves', () => {
  const edit = async (options: Options = {}) => {
    const page = await render(options);
    await page.open();
    await page.type(page.inputs(0)[0]!, 'Piccola');
    await page.submit();
    return page;
  };

  it('puts a 422 on the field it names', async () => {
    const page = await edit();
    await page.failWith(422, 'VALIDATION_ERROR', [{ field: 'attributes.0.name.it', issue: 'maxLength' }]);
    expect(page.errors()).toEqual(['FORM.ISSUE.MAX_LENGTH']);
    expect(page.text()).not.toContain('ERRORS.API.VALIDATION_ERROR');
  });

  it('shows a message for the form when the 422 names a field the form does not have', async () => {
    const page = await edit();
    await page.failWith(422, 'VALIDATION_ERROR', [{ field: 'other', issue: 'unknown' }]);
    expect(page.root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.VALIDATION_ERROR');
  });

  it('treats a 422 without details as a generic failure', async () => {
    const page = await edit();
    await page.failWith(422, 'VALIDATION_ERROR');
    expect(page.root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.VALIDATION_ERROR');
  });

  it('asks to read the group again after a 412 and does so', async () => {
    const page = await edit();
    await page.failWith(412, 'PRECONDITION_FAILED');
    expect(page.root.querySelector('fc-form-error')?.textContent).toContain(`${T}.STALE`);
    await page.press([...page.root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === `${T}.RELOAD`));
    backend().expectOne(URL).flush({ data: { ...RECORD, attributes: [RECORD.attributes[0]] } }, { headers: { ETag: '"v9"' } });
    await page.view();
    expect(page.root.querySelector('fc-form-error')).toBeNull();
    expect(page.fieldsets()).toHaveLength(2);
  });

  it('names the products that use a removed attribute, from their names', async () => {
    const page = await edit();
    await page.failWith(409, 'CONFLICT', [
      { field: `products.${P1}`, issue: 'referenced' },
      { field: `products.${P2}`, issue: 'referenced' },
    ]);
    const lookup = backend().expectOne((r) => r.url === PRODUCTS);
    expect(lookup.request.params.get('ids')).toBe(`${P1},${P2}`);
    lookup.flush({ data: [{ id: P1, name: 'Maglia' }], page: { limit: 100, next: null } });
    await page.view();
    const blocked = page.root.querySelector('section.blocked')!;
    expect(blocked.getAttribute('role')).toBe('alert');
    expect(blocked.querySelector('h4')?.textContent).toContain(`${T}.BLOCKED_TITLE {"name":"Taglie"}`);
    expect([...blocked.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Maglia', P2]);
    expect(page.root.querySelector('fc-form-error')).toBeNull();
    await page.type(page.inputs(0)[0]!, 'Altro');
    await page.submit();
    backend().expectOne((r) => r.method === 'PATCH' && r.url === URL).flush({ data: RECORD }, {});
    await page.view();
    expect(page.root.querySelector('section.blocked')).toBeNull();
  });

  it('falls back on the ids when the names of the products cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = await edit();
    await page.failWith(409, 'CONFLICT', [{ field: `products.${P1}`, issue: 'referenced' }]);
    backend().expectOne((r) => r.url === PRODUCTS).flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await page.view();
    expect([...page.root.querySelectorAll('section.blocked li')].map((li) => li.textContent)).toEqual([P1]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('asks to read the group again when a 409 gives no products', async () => {
    const page = await edit();
    await page.failWith(409, 'CONFLICT');
    expect(page.root.querySelector('fc-form-error')?.textContent).toContain('PRODUCT_CATALOG.ERROR.CONCURRENT');
    expect([...page.root.querySelectorAll('button')].some((b) => b.textContent?.trim() === `${T}.RELOAD`)).toBe(true);
  });

  it('treats a 409 whose details are not a list of products as a concurrent change', async () => {
    const page = await edit();
    await page.failWith(409, 'CONFLICT', [{ field: 'name', issue: 'taken' }]);
    expect(page.root.querySelector('fc-form-error')?.textContent).toContain('PRODUCT_CATALOG.ERROR.CONCURRENT');
  });

  it('explains a 403', async () => {
    const page = await edit();
    await page.failWith(403, 'FORBIDDEN');
    expect(page.root.querySelector('fc-form-error')?.textContent).toContain('PRODUCT_CATALOG.ERROR.ATTRIBUTES_FORBIDDEN');
    expect([...page.root.querySelectorAll('button')].some((b) => b.textContent?.trim() === `${T}.RELOAD`)).toBe(false);
  });

  it('reports any other failure with the central message', async () => {
    const page = await edit();
    await page.failWith(500, 'INTERNAL_ERROR');
    expect(page.root.querySelector('fc-form-error')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
  });
});

describe('AttributeGroupSection: deleting the group', () => {
  const ask = async () => {
    const page = await render();
    await page.open();
    await page.press(page.deleteTrigger());
    return page;
  };

  it('asks for confirmation naming the group and can be cancelled', async () => {
    const page = await ask();
    expect(page.root.querySelector('dialog')?.textContent).toContain(`${T}.DELETE.CONFIRM {"name":"Taglie"}`);
    await page.press(page.dialogButton('COMMON.CANCEL'));
    expect(page.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    expect(page.deleted).toEqual([]);
  });

  it('deletes the group, tells the page and thanks the user', async () => {
    const page = await ask();
    await page.press(page.dialogButton(`${T}.DELETE.ACTION`));
    const req = backend().expectOne((r) => r.method === 'DELETE' && r.url === URL);
    req.flush(null, { status: 204, statusText: 'No Content' });
    await page.view();
    expect(page.deleted).toEqual([ID]);
    expect(page.toasts()).toEqual([`success: ${T}.DELETE.DONE {"name":"Taglie"}`]);
    expect(page.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('lists the products that use its attributes when the server refuses', async () => {
    const page = await ask();
    await page.press(page.dialogButton(`${T}.DELETE.ACTION`));
    backend()
      .expectOne((r) => r.method === 'DELETE' && r.url === URL)
      .flush(errorBody('CONFLICT', [{ field: `products.${P1}`, issue: 'referenced' }]), { status: 409, statusText: 'x' });
    await page.view();
    backend().expectOne((r) => r.url === PRODUCTS).flush({ data: [{ id: P1, name: 'Maglia' }], page: { limit: 100, next: null } });
    await page.view();
    expect([...page.root.querySelectorAll('section.blocked li')].map((li) => li.textContent)).toEqual(['Maglia']);
    expect(page.deleted).toEqual([]);
    expect(page.toasts()).toEqual([]);
    expect(page.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('explains a 403 and any other failure with a toast', async () => {
    const page = await ask();
    await page.press(page.dialogButton(`${T}.DELETE.ACTION`));
    backend().expectOne((r) => r.method === 'DELETE').flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await page.view();
    await page.press(page.deleteTrigger());
    await page.press(page.dialogButton(`${T}.DELETE.ACTION`));
    backend().expectOne((r) => r.method === 'DELETE').flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await page.view();
    expect(page.toasts()).toEqual(['error: PRODUCT_CATALOG.ERROR.DELETE_FORBIDDEN', 'error: ERRORS.API.INTERNAL_ERROR']);
    expect(page.deleted).toEqual([]);
  });
});

describe('AttributeGroupSection: read only', () => {
  it('shows the attributes without any way to change them', async () => {
    const { open, root, inputs, fieldsets } = await render({ writable: false });
    await open();
    expect(fieldsets()).toHaveLength(2);
    expect(inputs(0).every((i) => i.disabled)).toBe(true);
    expect(root.querySelector('fieldset button')).toBeNull();
    expect(root.querySelector('button[type=submit]')).toBeNull();
    expect(root.querySelector('.actions')).toBeNull();
    expect(root.textContent).not.toContain(`${T}.ADD`);
  });
});
