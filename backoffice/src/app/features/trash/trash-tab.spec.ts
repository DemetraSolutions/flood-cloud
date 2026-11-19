import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, settle } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import {
  COMPANY_LEGACY,
  COMPANY_ROW,
  finishTrash,
  GROUP,
  GROUP_NO_DEALER,
  GROUP_ROW,
  listUrl,
  PLACE_NO_COMPANY,
  PLACE_ROW,
  renderTrash,
  result,
  USER_BARE,
  USER_ROW,
} from '../../../testing/trash';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext } from '../../core/groups/group-context';
import { ReferenceStore } from '../../core/reference/reference-store';

const BULK = `${API}/v1/groups/${GROUP}/trash`;

afterEach(finishTrash);

describe('TrashTab', () => {
  describe('companies', () => {
    it('reads the trashed companies with the defaults', async () => {
      const { request, view } = await renderTrash();
      const req = request('companies');
      expect(req.request.params.get('limit')).toBe('25');
      expect(req.request.params.get('sort')).toBe('name');
      expect(req.request.params.get('trashed')).toBe('true');
      expect(req.request.params.keys().sort()).toEqual(['limit', 'sort', 'trashed']);
      req.flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });

    it('shows one row per company with its columns and a link to the detail', async () => {
      const { flush, cells, root } = await renderTrash();
      await flush('companies', [COMPANY_ROW, COMPANY_LEGACY]);
      expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
        'TRASH.COLUMN.SELECT',
        'TRASH.COLUMN.NAME',
        'TRASH.COLUMN.VAT_NUMBER',
        'TRASH.COLUMN.CITY',
        'TRASH.COLUMN.PROVINCE',
        'TRASH.COLUMN.COUNTRY',
        'TRASH.COLUMN.TRASHED_AT',
      ]);
      expect(cells(0)).toEqual([
        '',
        'Alfa Srl',
        '01114601006',
        'Milano',
        'MI',
        'IT',
        '10 nov 2026',
      ]);
      expect(cells(1)).toEqual(['', 'Beta Srl', '', '', '', '', '—']);
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/companies/${COMPANY_ROW.id}`,
      );
    });

    it('explains an empty trash', async () => {
      const { flush, root } = await renderTrash();
      await flush('companies', []);
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('TRASH.EMPTY_TITLE');
      expect(root.querySelector('.bulk fc-checkbox')).toBeNull();
    });

    it('shows a loading table while it reads', async () => {
      const { request, root, view } = await renderTrash();
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      request('companies').flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });

    it('shows the error with a retry', async () => {
      const { request, root, view } = await renderTrash();
      request('companies').flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'INTERNAL_ERROR',
      });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('TRASH.LOAD_ERROR');
      root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
      await view();
      request('companies').flush({ data: [], page: { limit: 25, next: null } });
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await renderTrash(undefined, {}, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });

    it('sends the search, the page size and the cursor of the URL', async () => {
      const { request, view, root } = await renderTrash(
        `/groups/${GROUP}/trash?q=%20alfa%20&limit=50&cursor=c1`,
      );
      const { params } = request('companies').request;
      expect(params.get('q')).toBe('alfa');
      expect(params.get('limit')).toBe('50');
      expect(params.get('cursor')).toBe('c1');
      await view();
      expect(root.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe(' alfa ');
    });

    it('ignores an unknown page size', async () => {
      const { request, view } = await renderTrash(`/groups/${GROUP}/trash?limit=7`);
      const req = request('companies');
      expect(req.request.params.get('limit')).toBe('25');
      req.flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });

    it('searches after the user stops typing', async () => {
      const { flush, root, search, request, view } = await renderTrash();
      await flush('companies', []);
      const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
      input.value = ' alfa ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().get('q')).toBe('alfa');
      request('companies').flush({ data: [], page: { limit: 25, next: null } });
      await view();
      input.value = '  ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().has('q')).toBe(false);
      request('companies').flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });

    it('does not submit the search form', async () => {
      const { flush, root } = await renderTrash();
      await flush('companies', []);
      const form = root.querySelector('form')!;
      const event = new Event('submit', { cancelable: true });
      form.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('changes the page size and pages with the cursor', async () => {
      const { flush, root, search, request, view } = await renderTrash();
      await flush('companies', [COMPANY_ROW], 'c2');
      const [previous, next] = [
        ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator button'),
      ];
      expect(previous.disabled).toBe(true);
      next.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      request('companies').flush({ data: [COMPANY_LEGACY], page: { limit: 25, next: null } });
      await view();
      previous.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      request('companies').flush({ data: [COMPANY_ROW], page: { limit: 25, next: 'c2' } });
      await view();
      const size = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      size.value = '50';
      size.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      request('companies').flush({ data: [COMPANY_ROW], page: { limit: 50, next: null } });
      await view();
    });

    it('does not make the group of the URL the working group', async () => {
      const { flush } = await renderTrash();
      const choose = vi.spyOn(TestBed.inject(GroupContext), 'choose');
      await flush('companies', []);
      expect(choose).not.toHaveBeenCalled();
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    });
  });

  describe('selection', () => {
    it('has a checkbox per row, labelled with the name, and one for the whole page', async () => {
      const { flush, checkboxes, selectAll, tick, root } = await renderTrash();
      await flush('companies', [COMPANY_ROW, COMPANY_LEGACY]);
      expect(checkboxes().map((box) => box.getAttribute('aria-label'))).toEqual([
        'TRASH.SELECT_ROW {"name":"Alfa Srl"}',
        'TRASH.SELECT_ROW {"name":"Beta Srl"}',
      ]);
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
      expect(selectAll().checked).toBe(false);
      await tick(checkboxes()[0]);
      expect(root.querySelector('.bulk [role=status]')?.textContent).toBe(
        'TRASH.SELECTED {"count":1}',
      );
      expect(selectAll().checked).toBe(false);
      await tick(checkboxes()[1]);
      expect(selectAll().checked).toBe(true);
      await tick(checkboxes()[0], false);
      expect(selectAll().checked).toBe(false);
    });

    it('selects and clears the whole page', async () => {
      const { flush, checkboxes, selectAll, tick, root } = await renderTrash();
      await flush('companies', [COMPANY_ROW, COMPANY_LEGACY]);
      await tick(selectAll());
      expect(checkboxes().every((box) => box.checked)).toBe(true);
      await tick(selectAll(), false);
      expect(checkboxes().some((box) => box.checked)).toBe(false);
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
    });

    it('offers each action only with its permission', async () => {
      const full = await renderTrash();
      await full.flush('companies', [COMPANY_ROW]);
      await full.tick(full.checkboxes()[0]);
      expect(full.button('TRASH.RESTORE')).toBeDefined();
      expect(full.button('TRASH.DELETE.ACTION')).toBeDefined();
      expect(full.button('TRASH.EMPTY.ACTION')).toBeDefined();
      finishTrash();
      TestBed.resetTestingModule();

      const restoreOnly = await renderTrash(undefined, {
        role: 'CA',
        permissions: ['companies:read', 'companies:trash'],
      });
      await restoreOnly.flush('companies', [COMPANY_ROW]);
      await restoreOnly.tick(restoreOnly.checkboxes()[0]);
      expect(restoreOnly.button('TRASH.RESTORE')).toBeDefined();
      expect(restoreOnly.button('TRASH.DELETE.ACTION')).toBeUndefined();
      expect(restoreOnly.button('TRASH.EMPTY.ACTION')).toBeUndefined();
      finishTrash();
      TestBed.resetTestingModule();

      const deleteOnly = await renderTrash(undefined, {
        role: 'CA',
        permissions: ['companies:read', 'companies:delete'],
      });
      await deleteOnly.flush('companies', [COMPANY_ROW]);
      await deleteOnly.tick(deleteOnly.checkboxes()[0]);
      expect(deleteOnly.button('TRASH.RESTORE')).toBeUndefined();
      expect(deleteOnly.button('TRASH.DELETE.ACTION')).toBeDefined();
    });
  });

  describe('restore', () => {
    it('restores the selected companies with no confirmation and shows the summary', async () => {
      const { flush, checkboxes, tick, button, view, request, openDialogs, dialogButton } =
        await renderTrash();
      await flush('companies', [COMPANY_ROW, COMPANY_LEGACY]);
      await tick(checkboxes()[0]);
      await tick(checkboxes()[1]);
      button('TRASH.RESTORE')!.click();
      await settle();
      const req = backend().expectOne(`${BULK}/companies/restore`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ ids: [COMPANY_ROW.id, COMPANY_LEGACY.id] });
      expect(button('TRASH.RESTORE')!.disabled).toBe(true);
      req.flush({
        data: {
          results: [
            result(COMPANY_ROW.id, 'restored'),
            result(COMPANY_LEGACY.id, 'skipped', 'taken'),
          ],
        },
      });
      await view();
      const [dialog] = openDialogs();
      expect(dialog.textContent).toContain('TRASH.SUMMARY.RESTORED {"count":1}');
      expect(dialog.textContent).toContain('TRASH.ISSUE.TAKEN');
      expect(dialog.textContent).toContain('Beta Srl');
      request('companies').flush({ data: [COMPANY_LEGACY], page: { limit: 25, next: null } });
      await view();
      expect(button('TRASH.RESTORE')).toBeUndefined();
      dialogButton('COMMON.CLOSE')!.click();
      await view();
      expect(openDialogs()).toEqual([]);
    });

    it('restores the selected users and the selected places', async () => {
      const users = await renderTrash(`/groups/${GROUP}/trash?tab=users`);
      await users.flush('users', [USER_ROW]);
      await users.tick(users.checkboxes()[0]);
      users.button('TRASH.RESTORE')!.click();
      await settle();
      backend()
        .expectOne(`${BULK}/users/restore`)
        .flush({ data: { results: [result(USER_ROW.id, 'restored')] } });
      await users.view();
      expect(users.openDialogs()[0].textContent).toContain('TRASH.SUMMARY.RESTORED');
      users.request('users').flush({ data: [], page: { limit: 25, next: null } });
      await users.view();
    });

    it('restores groups from the platform trash', async () => {
      const { flush, checkboxes, tick, button, view, request, openDialogs, lookups } =
        await renderTrash(`/groups/${GROUP}/trash?tab=groups`);
      await lookups([], [fakeDealer()]);
      await flush('groups', [GROUP_ROW]);
      await tick(checkboxes()[0]);
      expect(button('TRASH.DELETE.ACTION')).toBeUndefined();
      expect(button('TRASH.EMPTY.ACTION')).toBeUndefined();
      button('TRASH.RESTORE')!.click();
      await settle();
      const req = backend().expectOne(`${API}/v1/trash/groups/restore`);
      expect(req.request.body).toEqual({ ids: [GROUP_ROW.id] });
      req.flush({ data: { results: [result(GROUP_ROW.id, 'restored')] } });
      await view();
      expect(openDialogs()[0].textContent).toContain('TRASH.SUMMARY.RESTORED');
      request('groups').flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });

    it('reports a failed call in a toast and keeps the selection', async () => {
      const { flush, checkboxes, tick, button, view, toasts, openDialogs } = await renderTrash();
      await flush('companies', [COMPANY_ROW]);
      await tick(checkboxes()[0]);
      button('TRASH.RESTORE')!.click();
      await settle();
      backend()
        .expectOne(`${BULK}/companies/restore`)
        .flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'FORBIDDEN' });
      await view();
      expect(toasts()).toEqual(['error: ERRORS.API.FORBIDDEN']);
      expect(openDialogs()).toEqual([]);
      expect(checkboxes()[0].checked).toBe(true);
      expect(button('TRASH.RESTORE')!.disabled).toBe(false);
    });
  });

  describe('delete for good', () => {
    it('asks for confirmation naming the count, and deletes only when confirmed', async () => {
      const { flush, checkboxes, tick, button, view, request, openDialogs, dialogButton } =
        await renderTrash();
      await flush('companies', [COMPANY_ROW, COMPANY_LEGACY]);
      await tick(checkboxes()[0]);
      await tick(checkboxes()[1]);
      button('TRASH.DELETE.ACTION')!.click();
      await view();
      expect(openDialogs()[0].textContent).toContain('TRASH.DELETE.MESSAGE {"count":2}');
      dialogButton('COMMON.CANCEL')!.click();
      await view();
      expect(openDialogs()).toEqual([]);

      button('TRASH.DELETE.ACTION')!.click();
      await view();
      dialogButton('TRASH.DELETE.ACTION')!.click();
      await settle();
      const req = backend().expectOne(`${BULK}/companies/delete`);
      expect(req.request.body).toEqual({ ids: [COMPANY_ROW.id, COMPANY_LEGACY.id] });
      req.flush({
        data: {
          results: [
            result(COMPANY_ROW.id, 'deleted'),
            result(COMPANY_LEGACY.id, 'skipped', 'referenced'),
          ],
        },
      });
      await view();
      const [summary] = openDialogs();
      expect(summary.textContent).toContain('TRASH.SUMMARY.DELETED {"count":1}');
      expect(summary.textContent).toContain('TRASH.ISSUE.REFERENCED_COMPANIES');
      request('companies').flush({ data: [COMPANY_LEGACY], page: { limit: 25, next: null } });
      await view();
    });

    it('closes the confirmation and reports a failure', async () => {
      const { flush, checkboxes, tick, button, view, toasts, openDialogs, dialogButton } =
        await renderTrash(`/groups/${GROUP}/trash?tab=places`);
      await flush('places', [PLACE_ROW]);
      await tick(checkboxes()[0]);
      button('TRASH.DELETE.ACTION')!.click();
      await view();
      dialogButton('TRASH.DELETE.ACTION')!.click();
      await settle();
      backend()
        .expectOne(`${BULK}/places/delete`)
        .flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'RATE_LIMITED' });
      await view();
      expect(toasts()).toEqual(['error: ERRORS.API.RATE_LIMITED']);
      expect(openDialogs()).toEqual([]);
    });

    it('tells the reference store about the places deleted', async () => {
      const { flush, checkboxes, tick, button, view, dialogButton, request } = await renderTrash(
        `/groups/${GROUP}/trash?tab=places`,
      );
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      await flush('places', [PLACE_ROW]);
      await tick(checkboxes()[0]);
      button('TRASH.DELETE.ACTION')!.click();
      await view();
      dialogButton('TRASH.DELETE.ACTION')!.click();
      await settle();
      backend()
        .expectOne(`${BULK}/places/delete`)
        .flush({ data: { results: [result(PLACE_ROW.id, 'deleted')] } });
      await view();
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'places');
      request('places').flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });
  });

  describe('empty the trash', () => {
    const emptyUrl = `${BULK}/companies/empty`;

    it('is disabled while the trash is empty', async () => {
      const { flush, button } = await renderTrash();
      await flush('companies', []);
      expect(button('TRASH.EMPTY.ACTION')!.disabled).toBe(true);
    });

    it('needs the confirmation, repeats the call while items remain and ends in the summary', async () => {
      const { flush, button, dialogButton, openDialogs, view, request, root } = await renderTrash();
      await flush('companies', [COMPANY_ROW, COMPANY_LEGACY]);
      button('TRASH.EMPTY.ACTION')!.click();
      await view();
      const [dialog] = openDialogs();
      expect(dialog.textContent).toContain('TRASH.EMPTY.MESSAGE_COUNT {"count":2,');
      expect(dialogButton('TRASH.EMPTY.START')!.disabled).toBe(true);
      const box = dialog.querySelector<HTMLInputElement>('input[type=checkbox]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      dialogButton('TRASH.EMPTY.START')!.click();
      await settle();
      backend()
        .expectOne(emptyUrl)
        .flush({
          data: {
            results: [
              result(COMPANY_ROW.id, 'deleted'),
              result(COMPANY_LEGACY.id, 'skipped', 'referenced'),
            ],
            remaining: 1,
            next: COMPANY_LEGACY.id,
          },
        });
      await view();
      expect(root.querySelector('dialog[open] [role=status]')?.textContent).toContain(
        'TRASH.EMPTY.PROGRESS {"deleted":1,"remaining":1}',
      );
      backend()
        .expectOne(emptyUrl)
        .flush({ data: { results: [result('x', 'deleted')], remaining: 0, next: null } });
      await view();
      const [summary] = openDialogs();
      expect(summary.textContent).toContain('TRASH.SUMMARY.DELETED {"count":2}');
      expect(summary.textContent).toContain(
        'TRASH.ISSUE.REFERENCED_COMPANIES TRASH.SUMMARY.COUNT {"count":1}',
      );
      request('companies').flush({ data: [COMPANY_LEGACY], page: { limit: 25, next: null } });
      await view();
    });

    it('does not state a count when the page shows only part of the trash', async () => {
      const { flush, button, openDialogs, view } = await renderTrash();
      await flush('companies', [COMPANY_ROW], 'c2');
      button('TRASH.EMPTY.ACTION')!.click();
      await view();
      expect(openDialogs()[0].textContent).toContain('TRASH.EMPTY.MESSAGE_ALL');
    });

    it('does not state a count on a page after the first', async () => {
      const { flush, button, openDialogs, view } = await renderTrash(
        `/groups/${GROUP}/trash?cursor=c1`,
      );
      await flush('companies', [COMPANY_ROW]);
      button('TRASH.EMPTY.ACTION')!.click();
      await view();
      expect(openDialogs()[0].textContent).toContain('TRASH.EMPTY.MESSAGE_ALL');
    });
  });

  describe('places', () => {
    it('shows the company of each place', async () => {
      const { lookups, cells, root, request } = await renderTrash(
        `/groups/${GROUP}/trash?tab=places`,
      );
      request('places').flush({
        data: [PLACE_ROW, PLACE_NO_COMPANY],
        page: { limit: 25, next: null },
      });
      await lookups([COMPANY_ROW]);
      expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
        'TRASH.COLUMN.SELECT',
        'TRASH.COLUMN.COMPANY',
        'TRASH.COLUMN.NAME',
        'TRASH.COLUMN.CITY',
        'TRASH.COLUMN.PROVINCE',
        'TRASH.COLUMN.COUNTRY',
        'TRASH.COLUMN.TRASHED_AT',
      ]);
      expect(cells(0)).toEqual(['', 'Alfa Srl', 'Bar Centro', 'Roma', 'RM', 'IT', '10 nov 2026']);
      expect(cells(1)).toEqual(['', '', 'Bar Nord', '', '', '', '—']);
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/places/${PLACE_ROW.id}`,
      );
    });

    it('does not read the companies without the permission to read them', async () => {
      const { flush, cells } = await renderTrash(`/groups/${GROUP}/trash?tab=places`, {
        role: 'PA',
        permissions: ['places:read', 'places:trash'],
      });
      await flush('places', [PLACE_ROW]);
      expect(cells(0)[1]).toBe('');
    });
  });

  describe('users', () => {
    it('shows role, username, name and e-mail', async () => {
      const { flush, cells, root } = await renderTrash(`/groups/${GROUP}/trash?tab=users`);
      await flush('users', [USER_ROW, USER_BARE]);
      expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
        'TRASH.COLUMN.SELECT',
        'TRASH.COLUMN.ROLE',
        'TRASH.COLUMN.USERNAME',
        'TRASH.COLUMN.FULL_NAME',
        'TRASH.COLUMN.EMAIL',
        'TRASH.COLUMN.TRASHED_AT',
      ]);
      expect(cells(0)).toEqual([
        '',
        'ROLE_SHORT.CA',
        'anna',
        'Anna Verdi',
        'anna@example.com',
        '10 nov 2026',
      ]);
      expect(cells(1)).toEqual(['', 'ROLE_SHORT.E', 'bare', '', '', '—']);
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/users/${USER_ROW.id}`,
      );
    });
  });

  describe('groups', () => {
    it('lists the trashed groups of the platform with their dealer', async () => {
      const { lookups, request, cells, root } = await renderTrash(
        `/groups/${GROUP}/trash?tab=groups`,
      );
      const req = request('groups');
      expect(req.request.params.get('sort')).toBe('name');
      req.flush({ data: [GROUP_ROW, GROUP_NO_DEALER], page: { limit: 25, next: null } });
      await lookups([], [fakeDealer()]);
      expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
        'TRASH.COLUMN.SELECT',
        'TRASH.COLUMN.NAME',
        'TRASH.COLUMN.ID',
        'TRASH.COLUMN.DEALER',
        'TRASH.COLUMN.TRASHED_AT',
      ]);
      expect(cells(0)).toEqual(['', 'Gruppo Alfa', GROUP_ROW.id, 'Dealer Nord Srl', '10 nov 2026']);
      expect(cells(1)).toEqual(['', 'Gruppo Beta', GROUP_NO_DEALER.id, '', '—']);
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP_ROW.id}/settings`,
      );
    });

    it('does not read the dealers without the permission', async () => {
      const { flush, cells } = await renderTrash(`/groups/${GROUP}/trash?tab=groups`, {
        permissions: ['groups:trash'],
      });
      await flush('groups', [GROUP_ROW]);
      expect(cells(0)[3]).toBe('');
    });
  });
});
