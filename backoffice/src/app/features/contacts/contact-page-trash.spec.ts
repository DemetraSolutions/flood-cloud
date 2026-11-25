import { backend, errorBody } from '../../../testing/api';
import {
  CONTACT,
  EDIT,
  GROUP,
  ITEM,
  L,
  LIST_ROUTE,
  ContactView,
  Reads,
  renderContact,
} from '../../../testing/contacts-page';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

const TRASHED: Reads = {
  item: { trashed: true, trashedAt: '2026-11-12T10:00:00.000Z' },
  etag: '"t1"',
};
const TRASHED_CONTACT = { ...CONTACT, trashed: true, trashedAt: '2026-11-12T10:00:00.000Z' };

/** Asks to put the contact in the trash and confirms in the dialog. */
async function trash(view: ContactView) {
  view.button('CONTACTS.TRASH.ACTION')!.click();
  await view.view();
  expect(view.el().querySelector('dialog[open]')?.textContent).toContain(
    'CONTACTS.TRASH.CONFIRM_ONE {"name":"Verdi srl"}',
  );
  view.dialogButton('CONTACTS.TRASH.ACTION').click();
  await view.view();
}

/** Asks to delete the contact for good and confirms in the dialog. */
async function remove(view: ContactView) {
  view.button('CONTACTS.DELETE.ACTION')!.click();
  await view.view();
  expect(view.el().querySelector('dialog[open]')?.textContent).toContain(
    'CONTACTS.DELETE.CONFIRM {"name":"Verdi srl"}',
  );
  view.dialogButton('CONTACTS.DELETE.ACTION').click();
  await view.view();
}

describe('ContactPage: moving to the trash', () => {
  it('asks to confirm, puts the contact in the trash with its version and shows it read only', async () => {
    const view = await renderContact(EDIT);
    await trash(view);
    const req = backend().expectOne(`${ITEM}/trash`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.body).toBeNull();
    req.flush({ data: TRASHED_CONTACT }, { headers: { ETag: '"t1"' } });
    await view.view();

    expect(view.toasts()).toEqual(['success: CONTACTS.TRASH.DONE']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'customers');
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'suppliers');
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.control(L.code).disabled).toBe(true);
    expect(view.save()).toBeNull();
    expect(view.button('CONTACTS.TRASH.ACTION')).toBeUndefined();
    expect(view.button('CONTACTS.RESTORE.ACTION')).toBeDefined();
    expect(view.button('CONTACTS.DELETE.ACTION')).toBeDefined();
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain(
      'CONTACTS.TRASHED_NOTE',
    );
  });

  it('keeps the contact when the user cancels', async () => {
    const view = await renderContact(EDIT);
    view.button('CONTACTS.TRASH.ACTION')!.click();
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.control(L.code).disabled).toBe(false);
  });

  it('shows a 412 as a stale version, closes the dialog and reads the contact again on request', async () => {
    const view = await renderContact(EDIT);
    await trash(view);
    backend()
      .expectOne(`${ITEM}/trash`)
      .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.toasts()).toEqual([]);
    view.reload()!.click();
    await view.answer({ item: { code: 'K7' } });
    expect(view.formError()).toBeNull();
    expect(view.control(L.code).value).toBe('K7');
  });

  it('shows a 403 as its own message', async () => {
    const view = await renderContact(EDIT);
    await trash(view);
    backend()
      .expectOne(`${ITEM}/trash`)
      .flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.ERROR.FORBIDDEN');
    expect(view.control(L.code).disabled).toBe(false);
  });

  it('shows a 404 and a 500 with the message of their code, and a 409 as a concurrent change', async () => {
    const view = await renderContact(EDIT);
    await trash(view);
    backend()
      .expectOne(`${ITEM}/trash`)
      .flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.NOT_FOUND');

    await trash(view);
    backend()
      .expectOne(`${ITEM}/trash`)
      .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.INTERNAL_ERROR');
  });

  it('disables the actions while the request is on its way', async () => {
    const view = await renderContact(EDIT);
    await trash(view);
    expect(view.button('CONTACTS.TRASH.ACTION')!.disabled).toBe(true);
    backend().expectOne(`${ITEM}/trash`).flush({ data: TRASHED_CONTACT });
    await view.view();
    expect(view.button('CONTACTS.RESTORE.ACTION')!.disabled).toBe(false);
  });
});

describe('ContactPage: restoring from the trash', () => {
  it('takes the contact out of the trash with its version and makes it editable again', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    view.button('CONTACTS.RESTORE.ACTION')!.click();
    await view.view();
    const req = backend().expectOne(`${ITEM}/restore`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('If-Match')).toBe('"t1"');
    req.flush({ data: CONTACT }, { headers: { ETag: '"v2"' } });
    await view.view();

    expect(view.toasts()).toEqual(['success: CONTACTS.RESTORE.DONE']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'customers');
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'suppliers');
    expect(view.control(L.code).disabled).toBe(false);
    expect(view.button('CONTACTS.RESTORE.ACTION')).toBeUndefined();
    expect(view.button('CONTACTS.TRASH.ACTION')).toBeDefined();
    expect(view.el().querySelector('.note[role=note]')).toBeNull();
  });

  it('treats a 409 that does not list references as a stale version', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    view.button('CONTACTS.RESTORE.ACTION')!.click();
    await view.view();
    backend()
      .expectOne(`${ITEM}/restore`)
      .flush(errorBody('CONFLICT', [{ field: 'fidelityCards.0.code', issue: 'taken' }]), {
        status: 409,
        statusText: 'x',
      });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.reload()).toBeDefined();
    expect(view.control(L.code).disabled).toBe(true);
    expect(view.button('CONTACTS.RESTORE.ACTION')!.disabled).toBe(false);
  });

  it('asks to read the contact again on a 412', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    view.button('CONTACTS.RESTORE.ACTION')!.click();
    await view.view();
    backend()
      .expectOne(`${ITEM}/restore`)
      .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.reload()).toBeDefined();
  });

  it('asks to read the contact again on a 409 without details', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    view.button('CONTACTS.RESTORE.ACTION')!.click();
    await view.view();
    backend()
      .expectOne(`${ITEM}/restore`)
      .flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.reload()).toBeDefined();
  });
});

describe('ContactPage: deleting for good', () => {
  it('asks to confirm, deletes with the version, and goes back to the list', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    const req = backend().expectOne(ITEM);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('If-Match')).toBe('"t1"');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await view.view();

    expect(view.toasts()).toEqual(['success: CONTACTS.DELETE.DONE']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'customers');
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'suppliers');
    expect(view.router.url).toBe(LIST_ROUTE);
  });

  it('keeps the contact when the user cancels', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    view.button('CONTACTS.DELETE.ACTION')!.click();
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.router.url).toBe(EDIT);
  });

  it('says what still refers to the contact (409 referenced), in the order of the server, with the counts', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend()
      .expectOne(ITEM)
      .flush(
        errorBody('CONFLICT', [
          { field: 'sales.665f1c2e9b1d4a0012ab3c01', issue: 'referenced' },
          { field: 'sales.665f1c2e9b1d4a0012ab3c02', issue: 'referenced' },
          { field: 'promotions.665f1c2e9b1d4a0012ab3c03', issue: 'referenced' },
          { field: 'unknownKind.665f1c2e9b1d4a0012ab3c04', issue: 'referenced' },
        ]),
        { status: 409, statusText: 'x' },
      );
    await view.view();
    const block = view.el().querySelector('fc-contact-reference-block')!;
    expect(block.getAttribute('role') ?? block.querySelector('section')?.getAttribute('role')).toBe(
      'alert',
    );
    expect(block.textContent).toContain('CONTACTS.DELETE.BLOCKED_TITLE');
    expect(block.textContent).toContain('CONTACTS.DELETE.BLOCKED_MESSAGE');
    const items = [...block.querySelectorAll('li')].map((li) => li.textContent?.trim());
    expect(items).toEqual([
      'CONTACTS.REFERENCE.ITEM {"kind":"CONTACTS.REFERENCE.promotions","count":"1"}',
      'CONTACTS.REFERENCE.ITEM {"kind":"CONTACTS.REFERENCE.sales","count":"2"}',
    ]);
    expect(view.formError()).toBeNull();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.router.url).toBe(EDIT);
    expect(view.toasts()).toEqual([]);

    [...block.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('COMMON.CLOSE'))!
      .click();
    await view.view();
    expect(view.el().querySelector('fc-contact-reference-block')).toBeNull();
  });

  it('closes the panel of references when the contact is restored', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend()
      .expectOne(ITEM)
      .flush(
        errorBody('CONFLICT', [
          { field: 'documents.665f1c2e9b1d4a0012ab3c01', issue: 'referenced' },
        ]),
        { status: 409, statusText: 'x' },
      );
    await view.view();
    expect(view.el().querySelector('fc-contact-reference-block')).not.toBeNull();
    view.button('CONTACTS.RESTORE.ACTION')!.click();
    await view.view();
    backend().expectOne(`${ITEM}/restore`).flush({ data: CONTACT });
    await view.view();
    expect(view.el().querySelector('fc-contact-reference-block')).toBeNull();
  });

  it('says the check of the references was too slow on a 503', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend()
      .expectOne(ITEM)
      .flush(errorBody('SERVICE_UNAVAILABLE'), { status: 503, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.ERROR.TOO_SLOW');
    expect(view.el().querySelector('fc-contact-reference-block')).toBeNull();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
  });

  it('shows the waiting time of a 429', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend()
      .expectOne(ITEM)
      .flush(errorBody('RATE_LIMITED'), {
        status: 429,
        statusText: 'x',
        headers: { 'Retry-After': '120' },
      });
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
  });

  it('asks to read the contact again on a 412', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend()
      .expectOne(ITEM)
      .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.reload()).toBeDefined();
    expect(view.router.url).toBe(EDIT);
  });

  it('shows a 409 that lists no reference as a stale version', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend().expectOne(ITEM).flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.FORM.STALE');
    expect(view.el().querySelector('fc-contact-reference-block')).toBeNull();
  });

  it('shows a 403 as its own message', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend().expectOne(ITEM).flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('CONTACTS.ERROR.FORBIDDEN');
  });

  it('shows a 404 with the message of its code', async () => {
    const view = await renderContact(EDIT, { reads: TRASHED });
    await remove(view);
    backend().expectOne(ITEM).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.NOT_FOUND');
  });
});
