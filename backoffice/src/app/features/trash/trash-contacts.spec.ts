import { TestBed } from '@angular/core/testing';
import { ReferenceStore } from '../../core/reference/reference-store';
import { API, backend, errorBody, settle } from '../../../testing/api';
import {
  CONTACT_ID_1,
  CONTACT_ID_2,
  TRASHED_BARE_CONTACT,
  TRASHED_CONTACT,
  trashedContact,
} from '../../../testing/contacts-trash';
import {
  COMPANY_ROW,
  finishTrash,
  GROUP,
  renderTrash,
  result,
  TRASH_ALL,
} from '../../../testing/trash';

const BULK = `${API}/v1/groups/${GROUP}/trash/contacts`;
const URL = `/groups/${GROUP}/trash?tab=contacts`;
const PSA = { permissions: [...TRASH_ALL, 'contacts:read', 'contacts:write'] };

/** Spies on the reference store: the compact lists it keeps are read again when invalidated. */
function watchStore() {
  return vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate').mockImplementation(() => undefined);
}

afterEach(finishTrash);

describe('TrashTab: contacts', () => {
  it('is a tab of the group trash, after the products and before the groups', async () => {
    const { flush, root } = await renderTrash(URL, PSA);
    await flush('contacts', [TRASHED_CONTACT]);
    expect([...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent?.trim())).toEqual([
      'TRASH.KIND.COMPANIES',
      'TRASH.KIND.PLACES',
      'TRASH.KIND.USERS',
      'TRASH.KIND.CONTACTS',
      'TRASH.KIND.GROUPS',
    ]);
    expect(root.querySelector('[role=tab][aria-selected=true]')?.id).toBe('trash-tab-contacts');
  });

  it('reads the trashed contacts of every kind sorted by display name', async () => {
    const { request, view } = await renderTrash(URL, PSA);
    const req = request('contacts');
    expect(req.request.url).toBe(`${API}/v1/groups/${GROUP}/contacts`);
    expect(req.request.params.get('sort')).toBe('displayName');
    expect(req.request.params.get('trashed')).toBe('true');
    expect(req.request.params.keys().sort()).toEqual(['limit', 'sort', 'trashed']);
    req.flush({ data: [], page: { limit: 25, next: null } });
    await view();
  });

  it('shows name, company, e-mail, phone and date, with a link to the contact', async () => {
    const { flush, cells, root } = await renderTrash(URL, PSA);
    const bare = trashedContact('665f1c2e9b1d4a0012ab3c03', { displayName: null, code: '' });
    await flush('contacts', [TRASHED_CONTACT, TRASHED_BARE_CONTACT, bare]);
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
      'TRASH.COLUMN.SELECT',
      'TRASH.COLUMN.DISPLAY_NAME',
      'TRASH.COLUMN.COMPANY_NAME',
      'TRASH.COLUMN.EMAIL',
      'TRASH.COLUMN.PHONE',
      'TRASH.COLUMN.TRASHED_AT',
    ]);
    expect(cells(0)).toEqual([
      '',
      'Mario Bianchi',
      'Bianchi Srl',
      'mario@example.com',
      '+390212345678',
      '10 nov 2026',
    ]);
    expect(cells(1)).toEqual(['', 'K-002', '', '', '', '—']);
    expect(cells(2)[1]).toBe('…ab3c03');
    expect(
      [...root.querySelectorAll<HTMLAnchorElement>('tbody a')].map((a) => a.getAttribute('href')),
    ).toEqual([
      `/groups/${GROUP}/contacts/${CONTACT_ID_1}`,
      `/groups/${GROUP}/contacts/${CONTACT_ID_2}`,
      `/groups/${GROUP}/contacts/665f1c2e9b1d4a0012ab3c03`,
    ]);
  });

  it('explains an empty trash', async () => {
    const { flush, root } = await renderTrash(URL, PSA);
    await flush('contacts', []);
    expect(root.querySelector('fc-empty-state')?.textContent).toContain('TRASH.EMPTY_TITLE');
  });

  describe('restore', () => {
    it('restores the selected contacts, reports the skipped and reads the compact lists again', async () => {
      const { flush, checkboxes, tick, button, view, request, openDialogs, dialogButton } =
        await renderTrash(URL, PSA);
      const invalidate = watchStore();
      await flush('contacts', [TRASHED_CONTACT, TRASHED_BARE_CONTACT]);
      await tick(checkboxes()[0]);
      await tick(checkboxes()[1]);
      button('TRASH.RESTORE')!.click();
      await view();
      const req = backend().expectOne(`${BULK}/restore`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ ids: [CONTACT_ID_1, CONTACT_ID_2] });
      req.flush({
        data: {
          results: [result(CONTACT_ID_1, 'restored'), result(CONTACT_ID_2, 'skipped', 'taken')],
        },
      });
      await view();
      const [dialog] = openDialogs();
      expect(dialog.textContent).toContain('TRASH.SUMMARY.RESTORED {"count":1}');
      expect(dialog.textContent).toContain('TRASH.ISSUE.TAKEN_CONTACTS');
      expect(dialog.textContent).toContain('K-002');
      expect(invalidate.mock.calls).toEqual([
        [GROUP, 'customers'],
        [GROUP, 'suppliers'],
      ]);
      request('contacts').flush({ data: [TRASHED_BARE_CONTACT], page: { limit: 25, next: null } });
      await view();
      dialogButton('COMMON.CLOSE')!.click();
      await view();
      expect(openDialogs()).toEqual([]);
    });
  });

  describe('delete for good', () => {
    it('confirms, deletes, says which contacts are still in use and reads the compact lists again', async () => {
      const { flush, selectAll, tick, button, view, request, openDialogs, dialogButton } =
        await renderTrash(URL, PSA);
      const invalidate = watchStore();
      await flush('contacts', [TRASHED_CONTACT, TRASHED_BARE_CONTACT]);
      await tick(selectAll());
      expect(button('TRASH.DELETE.ACTION')!.disabled).toBe(false);
      button('TRASH.DELETE.ACTION')!.click();
      await view();
      expect(openDialogs()[0].textContent).toContain('TRASH.DELETE.MESSAGE {"count":2}');
      dialogButton('TRASH.DELETE.ACTION')!.click();
      await view();
      const req = backend().expectOne(`${BULK}/delete`);
      expect(req.request.body).toEqual({ ids: [CONTACT_ID_1, CONTACT_ID_2] });
      req.flush({
        data: {
          results: [result(CONTACT_ID_1, 'deleted'), result(CONTACT_ID_2, 'skipped', 'referenced')],
        },
      });
      await view();
      const [summary] = openDialogs();
      expect(summary.textContent).toContain('TRASH.SUMMARY.DELETED {"count":1}');
      expect(summary.textContent).toContain('TRASH.ISSUE.REFERENCED_CONTACTS');
      expect(summary.textContent).toContain('K-002');
      expect(invalidate.mock.calls).toEqual([
        [GROUP, 'customers'],
        [GROUP, 'suppliers'],
      ]);
      request('contacts').flush({ data: [TRASHED_BARE_CONTACT], page: { limit: 25, next: null } });
      await view();
    });

    it('allows ten contacts at most and says so when the selection is longer', async () => {
      const { flush, selectAll, tick, button, root, checkboxes } = await renderTrash(URL, PSA);
      const ids = Array.from(
        { length: 11 },
        (_, i) => `665f1c2e9b1d4a0012ab4d${String(i).padStart(2, '0')}`,
      );
      await flush(
        'contacts',
        ids.map((id) => trashedContact(id)),
      );
      await tick(selectAll());
      expect(button('TRASH.DELETE.ACTION')!.disabled).toBe(true);
      expect(root.querySelector('.bulk')?.textContent).toContain(
        'TRASH.DELETE.LIMIT {"max":10,"count":11}',
      );
      expect(button('TRASH.DELETE.ACTION')!.getAttribute('aria-describedby')).toBe(
        'trash-delete-limit',
      );
      expect(root.querySelector('#trash-delete-limit')?.textContent).toContain(
        'TRASH.DELETE.LIMIT',
      );
      await tick(checkboxes()[10], false);
      expect(button('TRASH.DELETE.ACTION')!.hasAttribute('aria-describedby')).toBe(false);
      expect(button('TRASH.DELETE.ACTION')!.disabled).toBe(false);
      expect(root.querySelector('.bulk')?.textContent).not.toContain('TRASH.DELETE.LIMIT');
    });

    it('has no limit of ten for the other kinds', async () => {
      const { flush, selectAll, tick, button, root } = await renderTrash(
        `/groups/${GROUP}/trash`,
        PSA,
      );
      const rows = Array.from({ length: 11 }, (_, i) => ({
        ...COMPANY_ROW,
        id: `665f1c2e9b1d4a0012ab4e${String(i).padStart(2, '0')}`,
      }));
      await flush('companies', rows);
      await tick(selectAll());
      expect(button('TRASH.DELETE.ACTION')!.disabled).toBe(false);
      expect(root.querySelector('.bulk')?.textContent).not.toContain('TRASH.DELETE.LIMIT');
    });
  });

  describe('empty the trash', () => {
    it('is for platform administrators: empties in blocks and reads the compact lists again', async () => {
      const { flush, button, dialogButton, openDialogs, view, request } = await renderTrash(
        URL,
        PSA,
      );
      const invalidate = watchStore();
      await flush('contacts', [TRASHED_CONTACT]);
      button('TRASH.EMPTY.ACTION')!.click();
      await view();
      const [dialog] = openDialogs();
      expect(dialog.textContent).toContain(
        'TRASH.EMPTY.MESSAGE_COUNT {"count":1,"kind":"TRASH.KIND.CONTACTS"}',
      );
      const box = dialog.querySelector<HTMLInputElement>('input[type=checkbox]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      dialogButton('TRASH.EMPTY.START')!.click();
      await view();
      const first = backend().expectOne(`${BULK}/empty`);
      expect(first.request.body).toBeNull();
      first.flush({
        data: { results: [result(CONTACT_ID_1, 'deleted')], remaining: 1, next: CONTACT_ID_1 },
      });
      await view();
      const second = backend().expectOne(`${BULK}/empty`);
      expect(second.request.body).toEqual({ after: CONTACT_ID_1 });
      second.flush({
        data: {
          results: [result(CONTACT_ID_2, 'skipped', 'referenced')],
          remaining: 0,
          next: null,
        },
      });
      await view();
      const [summary] = openDialogs();
      expect(summary.textContent).toContain('TRASH.SUMMARY.DELETED {"count":1}');
      expect(summary.textContent).toContain('TRASH.ISSUE.REFERENCED_CONTACTS');
      expect(invalidate).toHaveBeenCalledTimes(4);
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'customers');
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'suppliers');
      request('contacts').flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });

    it('is not offered to a group administrator', async () => {
      const { flush, tick, checkboxes, button } = await renderTrash(URL, {
        role: 'SA',
        groupId: GROUP,
        permissions: ['contacts:read', 'contacts:write'],
      });
      await flush('contacts', [TRASHED_CONTACT]);
      await tick(checkboxes()[0]);
      expect(button('TRASH.EMPTY.ACTION')).toBeUndefined();
      expect(button('TRASH.RESTORE')).toBeDefined();
      expect(button('TRASH.DELETE.ACTION')).toBeDefined();
    });
  });

  describe('a check that is too slow (503)', () => {
    const slow = { status: 503, statusText: 'SERVICE_UNAVAILABLE' };

    it('says so for the restore and the deletion of contacts', async () => {
      const { flush, selectAll, tick, button, view, toasts, dialogButton } = await renderTrash(
        URL,
        PSA,
      );
      await flush('contacts', [TRASHED_CONTACT]);
      await tick(selectAll());
      button('TRASH.RESTORE')!.click();
      await settle();
      backend().expectOne(`${BULK}/restore`).flush(errorBody('SERVICE_UNAVAILABLE'), slow);
      await view();
      button('TRASH.DELETE.ACTION')!.click();
      await view();
      dialogButton('TRASH.DELETE.ACTION')!.click();
      await settle();
      backend().expectOne(`${BULK}/delete`).flush(errorBody('SERVICE_UNAVAILABLE'), slow);
      await view();
      expect(toasts()).toEqual([
        'error: CONTACTS.ERROR.TOO_SLOW',
        'error: CONTACTS.ERROR.TOO_SLOW',
      ]);
    });

    it('says so when emptying the trash of the contacts', async () => {
      const { flush, button, dialogButton, openDialogs, view, toasts, request } = await renderTrash(
        URL,
        PSA,
      );
      await flush('contacts', [TRASHED_CONTACT]);
      button('TRASH.EMPTY.ACTION')!.click();
      await view();
      const box = openDialogs()[0].querySelector<HTMLInputElement>('input[type=checkbox]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      dialogButton('TRASH.EMPTY.START')!.click();
      await settle();
      backend().expectOne(`${BULK}/empty`).flush(errorBody('SERVICE_UNAVAILABLE'), slow);
      await view();
      expect(toasts()).toEqual(['error: CONTACTS.ERROR.TOO_SLOW']);
      request('contacts').flush({ data: [TRASHED_CONTACT], page: { limit: 25, next: null } });
      await view();
    });
  });

  describe('permissions', () => {
    it('shows the tab with contacts:read alone, and no action without contacts:write', async () => {
      const { flush, root, tick, checkboxes, button } = await renderTrash(URL, {
        role: 'CA',
        permissions: ['contacts:read'],
      });
      await flush('contacts', [TRASHED_CONTACT]);
      expect(
        [...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent?.trim()),
      ).toEqual(['TRASH.KIND.CONTACTS']);
      await tick(checkboxes()[0]);
      expect(button('TRASH.RESTORE')).toBeUndefined();
      expect(button('TRASH.DELETE.ACTION')).toBeUndefined();
    });

    it('has no contacts tab in the cross-group trash', async () => {
      const { flush, root } = await renderTrash('/trash', PSA);
      await flush('companies', []);
      expect(root.querySelector('#trash-tab-contacts')).toBeNull();
      expect(root.querySelector('#trash-tab-companies')).not.toBeNull();
    });

    it('hides the tab without contacts:read', async () => {
      const { flush, root } = await renderTrash(URL, { permissions: TRASH_ALL });
      await flush('companies', []);
      expect(root.querySelector('#trash-tab-contacts')).toBeNull();
    });
  });
});
