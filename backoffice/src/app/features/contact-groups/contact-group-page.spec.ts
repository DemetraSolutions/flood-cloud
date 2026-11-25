import { Provider } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { errorOf, findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { leaveContactGroup } from './contact-group-leave';
import { ContactGroupPage } from './contact-group-page';
import { CONTACT_GROUP_LIMITS, ContactGroup } from './contact-group.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const PL1 = '665f1c2e9b1d4a0012ab3501';
const PL2 = '665f1c2e9b1d4a0012ab3502';
const PL_OFF = '665f1c2e9b1d4a0012ab3503';
const FULL = ['contacts:read', 'contacts:write', 'profile:read'];
const READ_ONLY = ['contacts:read', 'profile:read'];

const LIST = `${API}/v1/groups/${GROUP}/contact-groups`;
const ITEM = `${LIST}/${ID}`;
const LOOKUP = `${API}/v1/groups/${GROUP}/lookup/price-lists`;
const NEW = `/groups/${GROUP}/contact-groups/new`;
const EDIT = `/groups/${GROUP}/contact-groups/${ID}`;

const LISTS = [
  { id: PL1, name: 'Wholesale', enabled: true },
  { id: PL2, name: 'Staff prices', enabled: true },
  { id: PL_OFF, name: 'Old prices', enabled: false },
];
const GROUP_OF_CONTACTS: ContactGroup = {
  id: ID,
  name: 'Regulars',
  priceListId: PL1,
  discountPercent: 7.5,
  contactsCount: 4,
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
};

const L = {
  name: 'CONTACT_GROUPS.FIELD.NAME',
  priceList: 'CONTACT_GROUPS.FIELD.PRICE_LIST',
  discount: 'CONTACT_GROUPS.FIELD.DISCOUNT',
};

interface Reads {
  /** The price lists; `'fail'` makes the read fail. */
  lists?: typeof LISTS | 'fail';
  /** The group of contacts the page reads; `'skip'` leaves the request pending. */
  item?: object | 'skip';
  etag?: string;
  /** The page shows an existing group whatever the URL it was opened with (after a creation). */
  edit?: boolean;
}

const fail = (code: string, status = 500) =>
  [errorBody(code), { status, statusText: 'x' }] as const;

async function render(
  url: string,
  profile: Partial<Profile> = {},
  reads: Reads | null = {},
  extra: Provider[] = [],
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          {
            path: 'groups/:groupId/contact-groups/new',
            component: ContactGroupPage,
            canDeactivate: [leaveContactGroup],
          },
          {
            path: 'groups/:groupId/contact-groups/:contactGroupId',
            component: ContactGroupPage,
            canDeactivate: [leaveContactGroup],
          },
          { path: 'groups/:groupId/contact-groups', children: [] },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
  signIn({ role: 'SA', permissions: FULL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const scope = {
    get nativeElement() {
      return harness.routeNativeElement;
    },
  } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  /** Answers the reads the page makes when it opens. */
  const answer = async (o: Reads = {}) => {
    await settle();
    harness.detectChanges();
    await settle();
    const lookup = backend().expectOne(LOOKUP);
    if (o.lists === 'fail') {
      lookup.flush(...fail('INTERNAL_ERROR'));
    } else {
      lookup.flush({ data: o.lists ?? LISTS });
    }
    if ((o.edit ?? !url.endsWith('/new')) && o.item !== 'skip') {
      backend()
        .expectOne(ITEM)
        .flush({ data: o.item ?? GROUP_OF_CONTACTS }, { headers: { ETag: o.etag ?? '"v1"' } });
    }
    await view();
  };
  if (reads !== null) {
    await answer(reads);
  }
  const el = () => harness.routeNativeElement as HTMLElement;
  const page = () => harness.routeDebugElement!.componentInstance as ContactGroupPage;
  const type = async (label: string, value: string) => {
    const control = findControl(scope, label);
    control.value = value;
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const blur = async (label: string) => {
    findControl(scope, label).dispatchEvent(new Event('blur'));
    await view();
  };
  const submit = async () => {
    el()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => el().querySelector<HTMLButtonElement>('button[type=submit]');
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  const formError = () => el().querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const dialogButton = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const headerButton = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text && b.closest('dialog') === null,
    );
  const reload = () => headerButton('CONTACT_GROUPS.FORM.RELOAD');
  const select = (label: string) => findControl(scope, label) as HTMLSelectElement;
  return {
    harness,
    el,
    page,
    view,
    answer,
    type,
    blur,
    submit,
    save,
    toasts,
    formError,
    dialogButton,
    headerButton,
    reload,
    select,
    invalidate,
    router: TestBed.inject(Router),
    control: (label: string) => findControl(scope, label),
    error: (label: string) => errorOf(scope, label),
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactGroupPage: a new group of contacts', () => {
  it('starts empty, asks the name, and has no delete nor count', async () => {
    const { el, control, save, submit, error, select } = await render(NEW);
    expect(el().querySelector('h1')?.textContent).toContain('CONTACT_GROUPS.FORM.NEW_TITLE');
    expect((control(L.name) as HTMLInputElement).value).toBe('');
    expect(select(L.priceList).value).toBe('');
    expect((control(L.discount) as HTMLInputElement).value).toBe('');
    expect(save()!.textContent).toContain('CONTACT_GROUPS.FORM.CREATE');
    expect(save()!.disabled).toBe(true);
    expect(el().querySelector('page-header, fc-page-header')?.textContent).not.toContain(
      'CONTACT_GROUPS.DELETE.ACTION',
    );
    expect(el().textContent).not.toContain('CONTACTS_COUNT');
    expect(el().querySelector('.meta')).toBeNull();
    expect(el().querySelector('a[href]')?.getAttribute('href')).toBe(
      `/groups/${GROUP}/contact-groups`,
    );
    await submit();
    expect(error(L.name)).toBe('FORM.ISSUE.REQUIRED');
    backend().expectNone(LIST);
  });

  it('offers only the active price lists', async () => {
    const { select } = await render(NEW);
    expect([...select(L.priceList).options].map((o) => o.textContent?.trim())).toEqual([
      'CONTACT_GROUPS.NONE',
      'Wholesale',
      'Staff prices',
    ]);
  });

  it('creates the group of contacts with an Idempotency-Key, says so, invalidates the lookup and opens it', async () => {
    const { type, submit, view, toasts, router, answer, save, invalidate } = await render(NEW);
    await type(L.name, ' Regulars ');
    await type(L.priceList, PL2);
    await type(L.discount, '12.5');
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(LIST);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.body).toEqual({ name: 'Regulars', priceListId: PL2, discountPercent: 12.5 });
    req.flush(
      { data: { ...GROUP_OF_CONTACTS, priceListId: PL2, discountPercent: 12.5 } },
      { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } },
    );
    await view();
    expect(toasts()).toEqual(['success: CONTACT_GROUPS.FORM.CREATED']);
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'contact-groups');
    expect(router.url).toBe(EDIT);
    await answer({ edit: true });
  });

  it('sends null for the price list and the discount that were not chosen', async () => {
    const { type, submit, view } = await render(NEW);
    await type(L.name, 'Plain');
    await submit();
    const req = backend().expectOne(LIST);
    expect(req.request.body).toEqual({ name: 'Plain', priceListId: null, discountPercent: null });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('reuses the key when the same request is retried and takes a new one when it changes', async () => {
    const { type, submit, view } = await render(NEW);
    await type(L.name, 'Plain');
    await submit();
    const first = backend().expectOne(LIST);
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(...fail('INTERNAL_ERROR'));
    await view();
    await submit();
    const retry = backend().expectOne(LIST);
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    retry.flush(...fail('INTERNAL_ERROR'));
    await view();
    await type(L.name, 'Plain 2');
    await submit();
    const changed = backend().expectOne(LIST);
    expect(changed.request.headers.get('Idempotency-Key')).not.toBe(key);
    changed.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('maps a 422 with details onto the fields, and the rest to the message of the form', async () => {
    const { type, submit, view, error, formError } = await render(NEW);
    await type(L.name, 'Plain');
    await type(L.discount, '10');
    await submit();
    backend()
      .expectOne(LIST)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'name', issue: 'duplicate' },
          { field: 'discountPercent', issue: 'maximum' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(error(L.name)).not.toBe('');
    expect(error(L.discount)).not.toBe('');
    expect(formError()).toBeNull();
    await type(L.name, 'Plain 2');
    await type(L.discount, '11');
    await submit();
    backend()
      .expectOne(LIST)
      .flush(errorBody('VALIDATION_ERROR', [{ field: 'unknown', issue: 'incorrect' }]), {
        status: 422,
        statusText: 'x',
      });
    await view();
    expect(formError()).toBe('ERRORS.API.VALIDATION_ERROR');
  });

  it('shows a 422 without details as the generic message', async () => {
    const { type, submit, view, formError } = await render(NEW);
    await type(L.name, 'Plain');
    await submit();
    backend()
      .expectOne(LIST)
      .flush(errorBody('VALIDATION_ERROR'), { status: 422, statusText: 'x' });
    await view();
    expect(formError()).toBe('ERRORS.API.VALIDATION_ERROR');
  });

  it.each([
    ['FORBIDDEN', 403, 'ERRORS.API.FORBIDDEN'],
    ['SERVICE_UNAVAILABLE', 503, 'CONTACTS.ERROR.TOO_SLOW'],
    ['INTERNAL_ERROR', 500, 'ERRORS.API.INTERNAL_ERROR'],
  ])('shows a %s failure of the creation in the form', async (code, status, message) => {
    const { type, submit, view, formError, reload } = await render(NEW);
    await type(L.name, 'Plain');
    await submit();
    backend().expectOne(LIST).flush(errorBody(code), { status, statusText: 'x' });
    await view();
    expect(formError()).toBe(message);
    expect(reload()).toBeUndefined();
  });

  it('says how long to wait after a 429', async () => {
    const { type, submit, view, formError } = await render(NEW);
    await type(L.name, 'Plain');
    await submit();
    backend()
      .expectOne(LIST)
      .flush(errorBody('RATE_LIMITED'), {
        status: 429,
        statusText: 'x',
        headers: { 'Retry-After': '30' },
      });
    await view();
    expect(formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
  });

  it('shows a 409 as a concurrent change and offers to read again', async () => {
    const { type, submit, view, formError, reload } = await render(NEW);
    await type(L.name, 'Plain');
    await submit();
    backend().expectOne(LIST).flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view();
    expect(formError()).toBe('CONTACTS.ERROR.CONCURRENT');
    expect(reload()).toBeTruthy();
  });

  it('shows the error of the name and the discount once they are left', async () => {
    const { type, blur, error, view } = await render(NEW);
    await blur(L.name);
    expect(error(L.name)).toBe('FORM.ISSUE.REQUIRED');
    await type(L.name, 'x'.repeat(CONTACT_GROUP_LIMITS.name + 1));
    expect(error(L.name)).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(L.discount, 'abc');
    await blur(L.discount);
    expect(error(L.discount)).not.toBe('');
    await type(L.discount, '101');
    expect(error(L.discount)).toBe('FORM.ISSUE.MAXIMUM');
    await type(L.discount, '-1');
    expect(error(L.discount)).toBe('FORM.ISSUE.MINIMUM');
    await type(L.discount, '1.234');
    expect(error(L.discount)).toBe('FORM.ISSUE.FORMAT');
    await type(L.discount, '');
    expect(error(L.discount)).toBe('');
    await view();
  });

  it('marks the price list as touched when it is left', async () => {
    const { blur, page } = await render(NEW);
    await blur(L.priceList);
    const form = (page() as unknown as { groupForm: { priceListId(): { touched(): boolean } } })
      .groupForm;
    expect(form.priceListId().touched()).toBe(true);
  });

  it('does not send anything when the form is not valid, and focuses the first wrong field', async () => {
    const { type, submit, el, view } = await render(NEW);
    await type(L.discount, '200');
    await submit();
    backend().expectNone(LIST);
    await view();
    expect(el().querySelector('input[aria-invalid=true]')).not.toBeNull();
  });
});

describe('ContactGroupPage: reads', () => {
  it('keeps the price list of the group when it is no longer among the active ones', async () => {
    const { select } = await render(
      EDIT,
      {},
      { item: { ...GROUP_OF_CONTACTS, priceListId: PL_OFF } },
    );
    expect([...select(L.priceList).options].map((o) => o.textContent?.trim())).toEqual([
      'CONTACT_GROUPS.NONE',
      'Wholesale',
      'Staff prices',
      PL_OFF,
    ]);
    expect(select(L.priceList).value).toBe(PL_OFF);
  });

  it('offers no price list when they cannot be read, and keeps the one of the group', async () => {
    const { select } = await render(EDIT, {}, { lists: 'fail' });
    expect([...select(L.priceList).options].map((o) => o.textContent?.trim())).toEqual([
      'CONTACT_GROUPS.NONE',
      PL1,
    ]);
  });

  it('shows the error state with a way back when the group cannot be read, and retries', async () => {
    const { el, view } = await render(EDIT, {}, { item: 'skip' });
    backend()
      .expectOne(ITEM)
      .flush(errorBody('NOT_FOUND'), {
        status: 404,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-9' },
      });
    await view();
    const state = el().querySelector('fc-error-state')!;
    expect(state.textContent).toContain('CONTACT_GROUPS.LOAD_ERROR');
    expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
    expect(state.textContent).toContain('req-9');
    expect(el().querySelector('a[href]')?.getAttribute('href')).toBe(
      `/groups/${GROUP}/contact-groups`,
    );
    expect(el().textContent).toContain('CONTACT_GROUPS.FORM.BACK');
    state.querySelector('button')!.click();
    await view();
    backend()
      .expectOne(ITEM)
      .flush({ data: GROUP_OF_CONTACTS }, { headers: { ETag: '"v1"' } });
    await view();
    expect(el().querySelector('fc-error-state')).toBeNull();
    expect(el().querySelector('h1')?.textContent).toContain('EDIT_TITLE');
  });

  it('shows the loading state while the group is read', async () => {
    const { el } = await render(EDIT, {}, { item: 'skip' });
    expect(el().querySelector('[role=status]')?.textContent).toBe('COMMON.LOADING');
    expect(el().querySelector('form')).toBeNull();
    backend().expectOne(ITEM).flush({ data: GROUP_OF_CONTACTS });
  });

  it('reports an unexpected failure to read generically', async () => {
    const { el, view } = await render(EDIT, {}, null, [
      { provide: AppConfig, useValue: { apiBaseUrl: () => null } },
    ]);
    await view();
    expect(el().querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    for (const req of backend().match(() => true)) {
      req.flush({ data: [] });
    }
  });
});

describe('ContactGroupPage: an existing group of contacts', () => {
  it('shows it with its date and its contacts, and a save that waits for a change', async () => {
    const { el, control, select, save } = await render(EDIT);
    expect(el().querySelector('h1')?.textContent).toContain('CONTACT_GROUPS.FORM.EDIT_TITLE');
    expect(el().querySelector('.meta')?.textContent).toContain('CONTACT_GROUPS.FORM.UPDATED');
    expect(el().querySelector('.meta')?.textContent).not.toContain('"date":""');
    expect((control(L.name) as HTMLInputElement).value).toBe('Regulars');
    expect(select(L.priceList).value).toBe(PL1);
    expect((control(L.discount) as HTMLInputElement).value).toBe('7.5');
    expect(el().querySelector('.meta:nth-of-type(2)')?.textContent).toContain(
      'CONTACT_GROUPS.FIELD.CONTACTS_COUNT {"count":4}',
    );
    expect(save()!.textContent).toContain('COMMON.SAVE');
    expect(save()!.disabled).toBe(true);
  });

  it('shows no date and no count when the server gives none', async () => {
    const { el } = await render(
      EDIT,
      {},
      { item: { ...GROUP_OF_CONTACTS, updatedAt: null, contactsCount: undefined } },
    );
    expect(el().querySelector('.meta')?.textContent).toContain('{"date":""}');
    expect(el().textContent).not.toContain('CONTACTS_COUNT');
  });

  it('shows a count of zero', async () => {
    const { el } = await render(EDIT, {}, { item: { ...GROUP_OF_CONTACTS, contactsCount: 0 } });
    expect(el().querySelector('.meta:nth-of-type(2)')?.textContent).toContain(
      'CONTACT_GROUPS.FIELD.CONTACTS_COUNT {"count":0}',
    );
  });

  it('shows a group with no price list and no discount', async () => {
    const { select, control } = await render(
      EDIT,
      {},
      { item: { ...GROUP_OF_CONTACTS, priceListId: null, discountPercent: null } },
    );
    expect(select(L.priceList).value).toBe('');
    expect((control(L.discount) as HTMLInputElement).value).toBe('');
  });

  it('formats the date in the language of the interface', async () => {
    const { el, view } = await render(EDIT);
    const loading = TestBed.inject(I18nService).use('it');
    backend().expectOne('/i18n/it.json').flush({ TEST: 'x' });
    await loading;
    await view();
    expect(el().querySelector('.meta')?.textContent).toContain('2026');
  });

  it('saves only what changed with the version in If-Match, and uses the new one for the next save', async () => {
    const { type, submit, save, view, toasts, router, invalidate } = await render(EDIT);
    await type(L.name, 'VIP');
    expect(save()!.disabled).toBe(false);
    await submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.body).toEqual({ name: 'VIP' });
    req.flush({ data: { ...GROUP_OF_CONTACTS, name: 'VIP' } }, { headers: { ETag: '"v2"' } });
    await view();
    expect(toasts()).toEqual(['success: CONTACT_GROUPS.FORM.SAVED']);
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'contact-groups');
    expect(save()!.disabled).toBe(true);
    expect(router.url).toBe(EDIT);
    await type(L.discount, '');
    await submit();
    const second = backend().expectOne(ITEM);
    expect(second.request.headers.get('If-Match')).toBe('"v2"');
    expect(second.request.body).toEqual({ discountPercent: null });
    second.flush({ data: { ...GROUP_OF_CONTACTS, name: 'VIP', discountPercent: null } });
    await view();
  });

  it('sends every field that changed, and nothing else', async () => {
    const { type, submit, view } = await render(EDIT);
    await type(L.name, 'Staff');
    await type(L.priceList, '');
    await type(L.discount, '0');
    await submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.body).toEqual({ name: 'Staff', priceListId: null, discountPercent: 0 });
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('sends no If-Match when the server gave no version', async () => {
    const { type, submit, view } = await render(EDIT, {}, { item: 'skip' });
    backend().expectOne(ITEM).flush({ data: GROUP_OF_CONTACTS });
    await view();
    await type(L.name, 'VIP');
    await submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: GROUP_OF_CONTACTS });
    await view();
  });

  it('asks to read the group again on a 412, and reads it on request', async () => {
    const { type, submit, view, formError, reload, control, el } = await render(EDIT);
    await type(L.name, 'Mine');
    await submit();
    backend()
      .expectOne(ITEM)
      .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view();
    expect(formError()).toBe('CONTACT_GROUPS.FORM.STALE');
    reload()!.click();
    await view();
    backend()
      .expectOne(ITEM)
      .flush(
        { data: { ...GROUP_OF_CONTACTS, name: "Someone else's" } },
        { headers: { ETag: '"v9"' } },
      );
    await view();
    expect(formError()).toBeNull();
    expect((control(L.name) as HTMLInputElement).value).toBe("Someone else's");
    expect(el().querySelector('fc-error-state')).toBeNull();
    await type(L.name, 'New');
    await submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.headers.get('If-Match')).toBe('"v9"');
    req.flush(...fail('INTERNAL_ERROR'));
    await view();
  });

  it('answers a 404 on save with the generic message, without offering to read again', async () => {
    const { type, submit, view, formError, reload } = await render(EDIT);
    await type(L.name, 'VIP');
    await submit();
    backend().expectOne(ITEM).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(formError()).toBe('ERRORS.API.NOT_FOUND');
    expect(reload()).toBeUndefined();
  });
});

describe('ContactGroupPage: toolbar and confirmations', () => {
  it('orders the toolbar as back, save, delete and keeps the count out of the form', async () => {
    const { el } = await render(EDIT);
    const actions = [...el().querySelectorAll('fc-page-header a, fc-page-header button')].map((e) =>
      e.textContent?.trim(),
    );
    expect(actions).toEqual([
      'CONTACT_GROUPS.FORM.BACK',
      'COMMON.SAVE',
      'CONTACT_GROUPS.DELETE.ACTION',
    ]);
    expect(el().querySelector('form')?.textContent).not.toContain('CONTACTS_COUNT');
  });

  it('names the group in the confirmation of the deletion, as an alert dialog', async () => {
    const { el, headerButton, view } = await render(
      EDIT,
      {},
      { item: { ...GROUP_OF_CONTACTS, contactsCount: 0 } },
    );
    headerButton('CONTACT_GROUPS.DELETE.ACTION')!.click();
    await view();
    const dialog = el().querySelector('dialog[open]')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('CONTACT_GROUPS.DELETE.CONFIRM {"name":"Regulars"}');
  });

  it('warns in the confirmation that the group still has contacts', async () => {
    const { el, headerButton, view } = await render(EDIT);
    headerButton('CONTACT_GROUPS.DELETE.ACTION')!.click();
    await view();
    expect(el().querySelector('dialog[open]')?.textContent).toContain(
      'CONTACT_GROUPS.DELETE.CONFIRM_WITH_CONTACTS {"name":"Regulars","count":4}',
    );
  });

  it('confirms with no name for a group without count (not saved yet)', async () => {
    const { page } = await render(NEW);
    expect((page() as unknown as { deleteMessage(): string }).deleteMessage()).toBe(
      'CONTACT_GROUPS.DELETE.CONFIRM {"name":""}',
    );
  });

  it('shows no read-only note to a user who can write', async () => {
    const { el } = await render(EDIT);
    expect(el().querySelector('[role=note]')).toBeNull();
  });
});

describe('ContactGroupPage: deletion', () => {
  const ask = async (extra: Provider[] = []) => {
    const view = await render(EDIT, {}, {}, extra);
    view.headerButton('CONTACT_GROUPS.DELETE.ACTION')!.click();
    await view.view();
    return view;
  };

  it('asks for confirmation, deletes with If-Match, says so, invalidates the lookup and goes back to the list', async () => {
    const { el, dialogButton, view, toasts, router, invalidate } = await ask();
    const dialog = el().querySelector('dialog[open]')!;
    expect(dialog.textContent).toContain('CONTACT_GROUPS.DELETE.TITLE');
    expect(dialog.textContent).toContain('CONTACT_GROUPS.DELETE.CONFIRM');
    expect(dialogButton('CONTACT_GROUPS.DELETE.ACTION').getAttribute('data-variant')).toBe(
      'danger',
    );
    dialogButton('CONTACT_GROUPS.DELETE.ACTION').click();
    await view();
    const req = backend().expectOne(ITEM);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(toasts()).toEqual(['success: CONTACT_GROUPS.DELETE.DONE']);
    expect(invalidate).toHaveBeenCalledWith(GROUP, 'contact-groups');
    expect(router.url).toBe(`/groups/${GROUP}/contact-groups`);
  });

  it('does nothing when the user cancels', async () => {
    const { el, dialogButton, view } = await ask();
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(el().querySelector('dialog[open]')).toBeNull();
    backend().expectNone(ITEM);
  });

  it('says what refers to the group, by kind and count, when the server refuses with 409', async () => {
    const { el, dialogButton, view, toasts, invalidate } = await ask();
    dialogButton('CONTACT_GROUPS.DELETE.ACTION').click();
    await view();
    backend()
      .expectOne(ITEM)
      .flush(
        errorBody('CONFLICT', [
          { field: 'contacts.665f1c2e9b1d4a0012ab3601', issue: 'referenced' },
          { field: 'contacts.665f1c2e9b1d4a0012ab3602', issue: 'referenced' },
          { field: 'promotions.665f1c2e9b1d4a0012ab3701', issue: 'referenced' },
        ]),
        { status: 409, statusText: 'x' },
      );
    await view();
    const blocked = el().querySelector('fc-contact-reference-block')!;
    expect(blocked.querySelector('h2')?.textContent).toBe('CONTACT_GROUPS.DELETE.BLOCKED_TITLE');
    expect(blocked.querySelector('p')?.textContent).toBe('CONTACT_GROUPS.DELETE.BLOCKED_MESSAGE');
    expect([...blocked.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual([
      'CONTACTS.REFERENCE.ITEM {"kind":"CONTACTS.REFERENCE.contacts","count":"2"}',
      'CONTACTS.REFERENCE.ITEM {"kind":"CONTACTS.REFERENCE.promotions","count":"1"}',
    ]);
    expect(el().querySelector('dialog[open]')).toBeNull();
    expect(toasts()).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    blocked.querySelector('button')!.click();
    await view();
    expect(el().querySelector('fc-contact-reference-block')).toBeNull();
  });

  it('asks to read again on a 412', async () => {
    const { dialogButton, view, formError, reload, el } = await ask();
    dialogButton('CONTACT_GROUPS.DELETE.ACTION').click();
    await view();
    backend()
      .expectOne(ITEM)
      .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view();
    expect(formError()).toBe('CONTACT_GROUPS.FORM.STALE');
    expect(reload()).toBeTruthy();
    expect(el().querySelector('dialog[open]')).toBeNull();
  });

  it.each([
    ['SERVICE_UNAVAILABLE', 503, 'CONTACTS.ERROR.TOO_SLOW'],
    ['CONFLICT', 409, 'CONTACTS.ERROR.CONCURRENT'],
    ['FORBIDDEN', 403, 'ERRORS.API.FORBIDDEN'],
    ['NOT_FOUND', 404, 'ERRORS.API.NOT_FOUND'],
  ])('shows a %s refusal in the form', async (code, status, message) => {
    const { dialogButton, view, formError, el, toasts } = await ask();
    dialogButton('CONTACT_GROUPS.DELETE.ACTION').click();
    await view();
    backend().expectOne(ITEM).flush(errorBody(code), { status, statusText: 'x' });
    await view();
    expect(formError()).toBe(message);
    expect(el().querySelector('dialog[open]')).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it('says how long to wait after a 429', async () => {
    const { dialogButton, view, formError } = await ask();
    dialogButton('CONTACT_GROUPS.DELETE.ACTION').click();
    await view();
    backend()
      .expectOne(ITEM)
      .flush(errorBody('RATE_LIMITED'), {
        status: 429,
        statusText: 'x',
        headers: { 'Retry-After': '60' },
      });
    await view();
    expect(formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
  });

  it('keeps the delete button disabled while the request is pending', async () => {
    const { dialogButton, view, headerButton } = await ask();
    dialogButton('CONTACT_GROUPS.DELETE.ACTION').click();
    await view();
    expect(headerButton('CONTACT_GROUPS.DELETE.ACTION')!.disabled).toBe(true);
    backend()
      .expectOne(ITEM)
      .flush(...fail('INTERNAL_ERROR'));
    await view();
    expect(headerButton('CONTACT_GROUPS.DELETE.ACTION')!.disabled).toBe(false);
  });
});

describe('ContactGroupPage: read only', () => {
  it('is read only without contacts:write: no save, no delete, fields disabled', async () => {
    const { el, control, select, save, headerButton, page } = await render(EDIT, {
      permissions: READ_ONLY,
    });
    expect((control(L.name) as HTMLInputElement).disabled).toBe(true);
    expect(select(L.priceList).disabled).toBe(true);
    expect((control(L.discount) as HTMLInputElement).disabled).toBe(true);
    expect(save()).toBeNull();
    expect(headerButton('CONTACT_GROUPS.DELETE.ACTION')).toBeUndefined();
    expect(el().textContent).toContain('CONTACTS_COUNT');
    expect(el().querySelector('[role=note]')?.textContent).toBe('CONTACT_GROUPS.READ_ONLY_NOTE');
    expect(page().confirmLeave()).toBe(true);
  });
});

describe('ContactGroupPage: leaving the page', () => {
  it('leaves at once when nothing changed', async () => {
    const { page } = await render(EDIT);
    expect(page().confirmLeave()).toBe(true);
  });

  it('asks first when something is unsaved: staying, or leaving', async () => {
    const { type, page, view, dialogButton, el } = await render(EDIT);
    await type(L.name, 'Changed');
    const stay = page().confirmLeave() as Promise<boolean>;
    await view();
    expect(el().querySelector('dialog[open]')?.textContent).toContain(
      'CONTACT_GROUPS.LEAVE.MESSAGE',
    );
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(await stay).toBe(false);
    const leave = page().confirmLeave() as Promise<boolean>;
    await view();
    dialogButton('CONTACT_GROUPS.LEAVE.CONFIRM').click();
    await view();
    expect(await leave).toBe(true);
    expect(el().querySelector('dialog[open]')).toBeNull();
  });

  it('asks on a new group that was started, through the guard of the route, and not after a save', async () => {
    const { type, submit, view, router, dialogButton, answer } = await render(NEW);
    await type(L.name, 'Plain');
    const blocked = router.navigateByUrl('/elsewhere');
    await view();
    dialogButton('COMMON.CANCEL').click();
    await view();
    expect(await blocked).toBe(false);
    await submit();
    backend()
      .expectOne(LIST)
      .flush(
        { data: GROUP_OF_CONTACTS },
        { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } },
      );
    await view();
    await answer({ edit: true });
    expect(router.url).toBe(EDIT);
    expect(await router.navigateByUrl('/elsewhere')).toBe(true);
  });

  it('does not ask on a new group left empty', async () => {
    const { page } = await render(NEW);
    expect(page().confirmLeave()).toBe(true);
  });
});
