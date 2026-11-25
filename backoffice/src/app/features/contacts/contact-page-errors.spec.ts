import { TestBed } from '@angular/core/testing';
import { backend, errorBody } from '../../../testing/api';
import {
  BASE,
  CONTACT,
  EDIT,
  ITEM,
  L,
  NEW,
  ContactView,
  Options,
  renderContact,
} from '../../../testing/contacts-page';
import { ContactApi } from './contact-api';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

type Details = { field: string; issue: string }[];

/** Renders the page of a contact with a change ready to be saved. */
async function edited(options: Options = {}) {
  const view = await renderContact(EDIT, options);
  await view.type(L.code, 'K2');
  return view;
}

/** Saves the contact and answers the request with an error. */
async function saveWith(
  view: ContactView,
  code: string,
  status: number,
  details?: Details,
  headers: Record<string, string> = {},
) {
  await view.submit();
  backend().expectOne(ITEM).flush(errorBody(code, details), { status, statusText: 'x', headers });
  await view.view();
}

const count = (view: ContactView, tab: string, errors: number) =>
  expect(view.tab(tab)!.textContent, tab).toContain(`TAB_LIST.ERRORS {"count":${errors}}`);

describe('ContactPage: reading fails without a conforming error', () => {
  it('shows the generic message', async () => {
    const view = await renderContact(EDIT, {
      reads: null,
      prepare: () => {
        vi.spyOn(TestBed.inject(ContactApi), 'read').mockRejectedValue(new Error('boom'));
      },
    });
    await view.answer({ item: 'skip' });
    expect(view.el().querySelector('fc-error-state')?.textContent).toContain(
      'ERRORS.GENERIC.MESSAGE',
    );
    expect(view.el().querySelector('.request-id')).toBeNull();
  });
});

describe('ContactPage: errors of the server on a save', () => {
  it('asks to read the contact again on a 412, and reads it on request', async () => {
    const view = await edited();
    await saveWith(view, 'PRECONDITION_FAILED', 412);
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.reload()).toBeDefined();
    expect(view.toasts()).toEqual([]);

    view.reload()!.click();
    await view.answer({ item: { code: 'K9' }, etag: '"v7"' });
    expect(view.formError()).toBeNull();
    expect(view.reload()).toBeUndefined();
    expect(view.control(L.code).value).toBe('K9');
    expect(view.save()!.disabled).toBe(true);

    await view.type(L.code, 'K10');
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.headers.get('If-Match')).toBe('"v7"');
    req.flush({ data: { ...CONTACT, code: 'K10' } });
    await view.view();
  });

  it('asks to read the contact again on a 409 without details', async () => {
    const view = await edited();
    await saveWith(view, 'CONFLICT', 409);
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.reload()).toBeDefined();
  });

  it.each([
    ['account.email', L.accountEmail, 'account'],
    ['account.phone', L.accountPhone, 'account'],
  ])('puts a 409 taken on %s on its field and opens its tab', async (field, label, tab) => {
    const view = await edited();
    await saveWith(view, 'CONFLICT', 409, [{ field, issue: 'taken' }]);
    expect(view.visible()).toEqual([tab]);
    expect(view.error(label)).toBe('FORM.ISSUE.TAKEN');
    count(view, tab, 1);
    expect(view.formError()).toBeNull();
    expect(view.reload()).toBeUndefined();
  });

  it('puts a 422 on a card code on the cards, in the tab that was hidden', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'fidelityCards.0.code', issue: 'maxLength' },
    ]);
    expect(view.visible()).toEqual(['fidelity']);
    expect(view.el().querySelector('#contact-panel-fidelity .problem')?.textContent).toContain(
      'FORM.ISSUE.MAX_LENGTH',
    );
    count(view, 'fidelity', 1);
    expect(view.formError()).toBeNull();
  });

  it('puts the removal of a price list a product still uses (409 referenced) on the price lists of the supplier', async () => {
    const view = await edited();
    await saveWith(view, 'CONFLICT', 409, [
      { field: 'products.665f1c2e9b1d4a0012ab3701', issue: 'referenced' },
    ]);
    expect(view.visible()).toEqual(['company']);
    expect(view.el().querySelector('#contact-panel-company .problem')?.textContent).toContain(
      'CONTACTS.ERROR.LIST_IN_USE {"count":1}',
    );
    count(view, 'company', 1);
    expect(view.formError()).toBeNull();
  });

  it('says in one message how many products use the price lists that were taken away', async () => {
    const view = await edited();
    await saveWith(view, 'CONFLICT', 409, [
      { field: 'products.665f1c2e9b1d4a0012ab3701', issue: 'referenced' },
      { field: 'products.665f1c2e9b1d4a0012ab3702', issue: 'referenced' },
      { field: 'account.email', issue: 'taken' },
    ]);
    expect(view.el().querySelectorAll('#contact-panel-company .problem')).toHaveLength(1);
    expect(view.el().querySelector('#contact-panel-company .problem')?.textContent).toContain(
      'CONTACTS.ERROR.LIST_IN_USE {"count":2}',
    );
    expect(view.error(L.accountEmail)).toBe('FORM.ISSUE.TAKEN');
    expect(view.formError()).toBeNull();
  });

  it('puts the 422 issues on their fields in every tab and counts them in the tabs', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'services.0.duration', issue: 'incorrect' },
      { field: 'account.email', issue: 'format' },
      { field: 'eInvoicing.recipientCode', issue: 'format' },
      { field: 'company.vatNumber', issue: 'maxLength' },
      { field: 'person.firstName', issue: 'maxLength' },
      { field: 'person.phones.0', issue: 'pattern' },
      { field: 'code', issue: 'maxLength' },
    ]);
    expect(view.error(L.code)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(view.error(L.firstName)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(view.error(L.vatNumber)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(view.error(L.recipientCode)).toBe('FORM.ISSUE.FORMAT');
    expect(view.error(L.accountEmail)).toBe('FORM.ISSUE.FORMAT');
    count(view, 'general', 1);
    count(view, 'person', 2);
    count(view, 'company', 2);
    count(view, 'services', 1);
    count(view, 'account', 1);
    // The first tab with an error opens: the one of the general data comes first.
    expect(view.visible()).toEqual(['general']);
    expect(view.formError()).toBeNull();
  });

  it.each([
    ['person.firstName', 'person'],
    ['person.address.city', 'person'],
    ['company.name', 'company'],
    ['company.supplierPriceLists.0.name', 'company'],
    ['eInvoicing.pec', 'company'],
    ['fidelityCards.0.code', 'fidelity'],
    ['services.0.duration', 'services'],
    ['account.phone', 'account'],
    ['notes', 'general'],
  ])('opens the tab of the field %s', async (field, section) => {
    const view = await edited();
    await view.openTab('account');
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field, issue: 'incorrect' }]);
    expect(view.visible()).toEqual([section]);
  });

  it('opens the first tab that has an error, in the order of the tabs', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'account.email', issue: 'format' },
      { field: 'company.name', issue: 'maxLength' },
      { field: 'person.lastName', issue: 'maxLength' },
    ]);
    expect(view.visible()).toEqual(['person']);
  });

  it('puts an issue on a part of a list on the list', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'company.emails.2', issue: 'format' }]);
    count(view, 'company', 1);
    expect(view.el().querySelector('#contact-panel-company .problem')?.textContent).toContain(
      'FORM.ISSUE.FORMAT',
    );
  });

  it('shows the first issue of a field that has several', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'code', issue: 'maxLength' },
      { field: 'code', issue: 'pattern' },
    ]);
    expect(view.error(L.code)).toBe('FORM.ISSUE.MAX_LENGTH');
    count(view, 'general', 1);
  });

  it('clears the server error of a field when the user edits it', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'code', issue: 'maxLength' }]);
    expect(view.error(L.code)).toBe('FORM.ISSUE.MAX_LENGTH');
    await view.type(L.code, 'K3');
    expect(view.error(L.code)).toBe('');
    expect(view.tab('general')!.textContent).not.toContain('TAB_LIST.ERRORS');
  });

  it('answers a 422 without details with the message of the code', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422);
    expect(view.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    expect(view.reload()).toBeUndefined();
  });

  it('shows an issue on a field the form does not have as a message of the form', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [{ field: 'extra', issue: 'unknown' }]);
    expect(view.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    expect(view.visible()).toEqual(['general']);
  });

  it('shows an issue on a group of fields as a message of the form, and still marks the fields that match', async () => {
    const view = await edited();
    await saveWith(view, 'VALIDATION_ERROR', 422, [
      { field: 'person.address.unknown', issue: 'unknown' },
      { field: 'account', issue: 'unknown' },
      { field: 'code', issue: 'maxLength' },
    ]);
    expect(view.formError()).toContain('ERRORS.API.VALIDATION_ERROR');
    expect(view.error(L.code)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(view.visible()).toEqual(['general']);
  });

  it('says an Idempotency-Key used with another body (409 reused) on a creation as a message of the form', async () => {
    const view = await renderContact(NEW);
    await view.type(L.firstName, 'Anna');
    await view.submit();
    backend()
      .expectOne(BASE)
      .flush(errorBody('CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]), {
        status: 409,
        statusText: 'x',
      });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.ERROR.KEY_REUSED');
    expect(view.reload()).toBeUndefined();
    expect(view.tab('account')!.textContent).not.toContain('TAB_LIST.ERRORS');
    expect(view.router.url).toBe(NEW);
  });

  it('shows a 403 as its own message', async () => {
    const view = await edited();
    await saveWith(view, 'FORBIDDEN', 403);
    expect(view.formError()).toContain('CONTACTS.ERROR.FORBIDDEN');
    expect(view.reload()).toBeUndefined();
  });

  it('shows a 403 with details as its own message too', async () => {
    const view = await edited();
    await saveWith(view, 'FORBIDDEN', 403, [{ field: 'code', issue: 'notAllowed' }]);
    expect(view.formError()).toContain('CONTACTS.ERROR.FORBIDDEN');
  });

  it('shows a 404 with the message of its code', async () => {
    const view = await edited();
    await saveWith(view, 'NOT_FOUND', 404);
    expect(view.formError()).toContain('ERRORS.API.NOT_FOUND');
  });

  it('shows a 500 with the message of its code and keeps what the user typed', async () => {
    const view = await edited();
    await saveWith(view, 'INTERNAL_ERROR', 500);
    expect(view.formError()).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(view.control(L.code).value).toBe('K2');
    expect(view.save()!.disabled).toBe(false);
  });

  it('shows the waiting time of a 429', async () => {
    const view = await edited();
    await saveWith(view, 'RATE_LIMITED', 429, undefined, { 'Retry-After': '90' });
    expect(view.formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
  });

  it('shows a network failure', async () => {
    const view = await edited();
    await view.submit();
    backend().expectOne(ITEM).error(new ProgressEvent('error'));
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.NETWORK_ERROR');
  });

  it('shows the error of a failed creation and keeps the page of the new contact', async () => {
    const view = await renderContact(NEW);
    await view.type(L.firstName, 'Anna');
    await view.submit();
    backend()
      .expectOne(BASE)
      .flush(errorBody('CONFLICT', [{ field: 'account.email', issue: 'taken' }]), {
        status: 409,
        statusText: 'x',
      });
    await view.view();
    expect(view.router.url).toBe(NEW);
    expect(view.visible()).toEqual(['account']);
    expect(view.error(L.accountEmail)).toBe('FORM.ISSUE.TAKEN');
  });

  it('clears the message of the last attempt when the next one starts', async () => {
    const view = await edited();
    await saveWith(view, 'INTERNAL_ERROR', 500);
    expect(view.formError()).not.toBeNull();
    await view.submit();
    expect(view.formError()).toBeNull();
    backend()
      .expectOne(ITEM)
      .flush({ data: { ...CONTACT, code: 'K2' } });
    await view.view();
  });
});
