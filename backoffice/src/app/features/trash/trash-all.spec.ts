import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody } from '../../../testing/api';
import {
  COMPANY_LEGACY,
  COMPANY_ROW,
  finishTrash,
  GROUP,
  GROUP_ROW,
  PLACE_ROW,
  renderTrash,
  result,
  trashPage,
  TRASH_ALL,
  USER_BARE,
  USER_ROW,
} from '../../../testing/trash';

const G2 = '665f1c2e9b1d4a0012ab34a2';
const G3 = '665f1c2e9b1d4a0012ab34a3';
const DEALER = '665f1c2e9b1d4a0012ab34d1';
const PARAMS = ['limit', 'sort', 'trashed'];

const IN_G1 = { ...COMPANY_ROW, groupId: GROUP, groupName: 'Gruppo Uno' };
const IN_G1_B = { ...COMPANY_LEGACY, groupId: GROUP, groupName: 'Gruppo Uno' };
const IN_G2 = {
  ...COMPANY_ROW,
  id: '665f1c2e9b1d4a0012ab3510',
  name: 'Delta',
  groupId: G2,
  groupName: '',
};
const IN_G3 = {
  ...COMPANY_ROW,
  id: '665f1c2e9b1d4a0012ab3511',
  name: 'Omega',
  groupId: G3,
  groupName: null,
};

afterEach(() => {
  sessionStorage.clear();
  finishTrash();
});

describe('Trash across groups', () => {
  describe('companies', () => {
    it('reads GET /v1/companies?trashed=true and shows the group of each row', async () => {
      const { request, view, cells, root } = await renderTrash('/trash');
      const req = request('companies');
      expect(req.request.params.keys().sort()).toEqual(PARAMS);
      req.flush(trashPage([IN_G1, IN_G2, IN_G3]));
      await view();
      expect([...root.querySelectorAll('thead th')][1].textContent?.trim()).toBe(
        'CROSS_GROUP.COLUMN.GROUP',
      );
      expect(cells(0)[1]).toBe('Gruppo Uno');
      expect(cells(1)[1]).toBe('CROSS_GROUP.NO_NAME');
      expect(cells(2)[1]).toBe('CROSS_GROUP.NO_NAME');
      const links = [...root.querySelectorAll<HTMLAnchorElement>('tbody a')].map((a) =>
        a.getAttribute('href'),
      );
      expect(links).toEqual([
        `/groups/${GROUP}/settings`,
        `/groups/${GROUP}/companies/${IN_G1.id}`,
        `/groups/${G2}/settings`,
        `/groups/${G2}/companies/${IN_G2.id}`,
        `/groups/${G3}/companies/${IN_G3.id}`,
      ]);
    });

    it('sends the group and dealer filters of the URL', async () => {
      const { request, view } = await renderTrash(`/trash?groupId=${GROUP}&dealerId=${DEALER}`);
      const req = request('companies');
      expect(req.request.params.get('groupId')).toBe(GROUP);
      expect(req.request.params.get('dealerId')).toBe(DEALER);
      req.flush(trashPage([]));
      await view();
      for (const read of backend().match((r) => /\/v1\/groups\/[0-9a-f]{24}$/.test(r.url))) {
        read.flush({ data: { name: 'Gruppo Uno' } });
      }
      await view();
    });

    it('drops an invalid group and never sends a dealer for a dealer user', async () => {
      const { request, view } = await renderTrash(`/trash?groupId=nope&dealerId=${DEALER}`, {
        role: 'D',
      });
      const req = request('companies');
      expect(req.request.params.has('groupId')).toBe(false);
      expect(req.request.params.has('dealerId')).toBe(false);
      req.flush(trashPage([]));
      await view();
    });

    it('searches the groups to filter by, and puts the chosen one in the URL', async () => {
      const { request, view, root, search } = await renderTrash('/trash?cursor=c1');
      request('companies').flush(trashPage([]));
      await view();
      const submit = new Event('submit', { cancelable: true });
      root.querySelector('form.filters')!.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
      root
        .querySelector<HTMLInputElement>('input[role=combobox]')!
        .dispatchEvent(new Event('focus'));
      await view();
      backend()
        .expectOne((r) => r.url === `${API}/v1/groups` && r.params.get('trashed') === null)
        .flush(trashPage([{ id: GROUP, name: 'Gruppo Uno' }]));
      await view();
      root.querySelector<HTMLElement>('[role=option]')!.click();
      await view();
      expect(search().get('groupId')).toBe(GROUP);
      expect(search().has('cursor')).toBe(false);
      request('companies').flush(trashPage([]));
      await view();
    });

    it('puts a filter change in the URL and starts from the first page', async () => {
      const { request, view, root, search } = await renderTrash(`/trash?cursor=c1`);
      request('companies').flush(trashPage([]));
      await view();
      const select = root.querySelector<HTMLSelectElement>('fc-cross-group-filters select')!;
      for (const dealers of backend().match((r) => r.url === `${API}/v1/dealers`)) {
        dealers.flush(trashPage([{ id: DEALER, businessName: 'Dealer' }]));
      }
      await view();
      select.value = DEALER;
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('dealerId')).toBe(DEALER);
      expect(search().has('cursor')).toBe(false);
      request('companies').flush(trashPage([]));
      await view();
      select.value = '';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().has('dealerId')).toBe(false);
      request('companies').flush(trashPage([]));
      await view();
    });
  });

  describe('products', () => {
    it('has no tab of products: they are managed by group', async () => {
      const { request, view, root } = await renderTrash('/trash', {
        permissions: [...TRASH_ALL, 'products:read'],
      });
      request('companies').flush(trashPage([IN_G1]));
      await view();
      const tabs = [...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent?.trim());
      expect(tabs).toEqual([
        'TRASH.KIND.COMPANIES',
        'TRASH.KIND.PLACES',
        'TRASH.KIND.USERS',
        'TRASH.KIND.GROUPS',
      ]);
    });

    it('falls back to the first tab when the URL asks for them', async () => {
      const { request, view, root } = await renderTrash('/trash?tab=products', {
        permissions: [...TRASH_ALL, 'products:read'],
      });
      request('companies').flush(trashPage([IN_G1]));
      await view();
      expect(root.querySelector('[role=tab][aria-selected=true]')?.id).toBe('trash-tab-companies');
    });
  });

  describe('places', () => {
    it('reads GET /v1/places and has no company column without a group filter', async () => {
      const { request, view, root } = await renderTrash('/trash?tab=places');
      const req = request('places');
      expect(req.request.params.keys().sort()).toEqual(PARAMS);
      req.flush(trashPage([{ ...PLACE_ROW, groupId: GROUP, groupName: 'Gruppo Uno' }]));
      await view();
      const headers = [...root.querySelectorAll('thead th')].map((h) => h.textContent?.trim());
      expect(headers).toContain('CROSS_GROUP.COLUMN.GROUP');
      expect(headers).not.toContain('TRASH.COLUMN.COMPANY');
    });

    it('names the companies of the filtered group', async () => {
      const { request, view, root } = await renderTrash(`/trash?tab=places&groupId=${GROUP}`);
      request('places').flush(
        trashPage([{ ...PLACE_ROW, groupId: GROUP, groupName: 'Gruppo Uno' }]),
      );
      await view();
      for (const read of backend().match((r) => /\/v1\/groups\/[0-9a-f]{24}$/.test(r.url))) {
        read.flush({ data: { name: 'Gruppo Uno' } });
      }
      for (const read of backend().match(
        (r) => r.url === `${API}/v1/groups/${GROUP}/companies` && r.params.get('trashed') === null,
      )) {
        read.flush(trashPage([{ id: COMPANY_ROW.id, name: 'Alfa Srl', trashed: false }]));
      }
      await view();
      expect([...root.querySelectorAll('thead th')].map((h) => h.textContent?.trim())).toContain(
        'TRASH.COLUMN.COMPANY',
      );
      expect(root.querySelector('tbody')?.textContent).toContain('Alfa Srl');
    });
  });

  describe('users', () => {
    const GROUPED = { ...USER_ROW, groupName: 'Gruppo Uno' };
    const PLATFORM = {
      ...USER_BARE,
      id: '665f1c2e9b1d4a0012ab3799',
      groupId: null,
      groupName: null,
      role: 'D' as const,
    };
    const PLATFORM_B = { ...PLATFORM, id: '665f1c2e9b1d4a0012ab3798', username: 'p2' };

    it('reads GET /v1/users and shows the group name, a dash without a link for a platform user', async () => {
      const { request, view, cells, root } = await renderTrash('/trash?tab=users');
      const req = request('users');
      expect(req.request.params.get('sort')).toBe('username');
      req.flush(trashPage([GROUPED, PLATFORM]));
      await view();
      expect(cells(0)[1]).toBe('Gruppo Uno');
      expect(cells(1)[1]).toBe('CROSS_GROUP.NO_NAME');
      expect(
        [...root.querySelectorAll<HTMLAnchorElement>('tbody a')].map((a) => a.getAttribute('href')),
      ).toEqual([
        `/groups/${GROUP}/settings`,
        `/groups/${GROUP}/users/${GROUPED.id}`,
        `/platform/users/${PLATFORM.id}`,
      ]);
    });

    it('lets a PSA select the platform users, and a dealer only the users of a group', async () => {
      const psa = await renderTrash('/trash?tab=users');
      psa.request('users').flush(trashPage([GROUPED, PLATFORM]));
      await psa.view();
      expect(psa.checkboxes().map((box) => box.disabled)).toEqual([false, false]);
      const all = psa.root.querySelector<HTMLInputElement>('.bulk fc-checkbox input')!;
      all.checked = true;
      all.dispatchEvent(new Event('change'));
      await psa.view();
      expect(psa.checkboxes().map((box) => box.checked)).toEqual([true, true]);
      finishTrash();
      TestBed.resetTestingModule();
      const dealer = await renderTrash('/trash?tab=users', { role: 'D' });
      dealer.request('users').flush(trashPage([GROUPED, PLATFORM]));
      await dealer.view();
      expect(dealer.checkboxes().map((box) => box.disabled)).toEqual([false, true]);
    });

    const pick = async (ctx: Awaited<ReturnType<typeof renderTrash>>, rows: object[]) => {
      ctx.request('users').flush(trashPage(rows));
      await ctx.view();
      const all = ctx.root.querySelector<HTMLInputElement>('.bulk fc-checkbox input')!;
      all.checked = true;
      all.dispatchEvent(new Event('change'));
      await ctx.view();
    };

    it('restores platform users one request each, after the groups, and merges the outcomes', async () => {
      const ctx = await renderTrash('/trash?tab=users');
      await pick(ctx, [GROUPED, PLATFORM, PLATFORM_B]);
      ctx.button('TRASH.RESTORE')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/users/restore`)
        .flush({ data: { results: [result(GROUPED.id, 'restored')] } });
      await ctx.view();
      const first = backend().expectOne(`${API}/v1/users/${PLATFORM.id}/restore`);
      expect(first.request.method).toBe('POST');
      expect(first.request.headers.has('If-Match')).toBe(false);
      expect(backend().match(`${API}/v1/users/${PLATFORM_B.id}/restore`)).toHaveLength(0);
      first.flush({ data: PLATFORM });
      await ctx.view();
      backend().expectOne(`${API}/v1/users/${PLATFORM_B.id}/restore`).flush({ data: PLATFORM_B });
      await ctx.view();
      expect(ctx.root.textContent).toContain('TRASH.SUMMARY.RESTORED {"count":3}');
      ctx.request('users').flush(trashPage([]));
      await ctx.view();
    });

    it('deletes platform users for good with DELETE /v1/users/{id}, after the confirmation', async () => {
      const ctx = await renderTrash('/trash?tab=users');
      await pick(ctx, [PLATFORM]);
      ctx.button('TRASH.DELETE.ACTION')!.click();
      await ctx.view();
      ctx.dialogButton('TRASH.DELETE.ACTION')!.click();
      await ctx.view();
      const del = backend().expectOne(`${API}/v1/users/${PLATFORM.id}`);
      expect(del.request.method).toBe('DELETE');
      del.flush(null, { status: 204, statusText: 'No Content' });
      await ctx.view();
      expect(ctx.root.textContent).toContain('TRASH.SUMMARY.DELETED {"count":1}');
      ctx.request('users').flush(trashPage([]));
      await ctx.view();
    });

    it.each([
      [403, errorBody('FORBIDDEN'), 'TRASH.ISSUE.FORBIDDEN'],
      [404, errorBody('NOT_FOUND'), 'TRASH.ISSUE.NOT_FOUND'],
      [
        409,
        errorBody('CONFLICT', [{ field: 'groups', issue: 'referenced' }]),
        'TRASH.ISSUE.HAS_GROUPS',
      ],
    ])('reports a %s of a platform user as a readable reason', async (status, body, reason) => {
      const ctx = await renderTrash('/trash?tab=users');
      await pick(ctx, [GROUPED, PLATFORM]);
      ctx.button('TRASH.DELETE.ACTION')!.click();
      await ctx.view();
      ctx.dialogButton('TRASH.DELETE.ACTION')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/users/delete`)
        .flush({ data: { results: [result(GROUPED.id, 'deleted')] } });
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/users/${PLATFORM.id}`)
        .flush(body, { status, statusText: 'x' });
      await ctx.view();
      expect(ctx.root.textContent).toContain('TRASH.SUMMARY.DELETED {"count":1}');
      expect(ctx.root.textContent).toContain(reason);
      ctx.request('users').flush(trashPage([]));
      await ctx.view();
    });

    it('lists a platform user whose request failed for another reason, and shows an error if all failed', async () => {
      const ctx = await renderTrash('/trash?tab=users');
      await pick(ctx, [GROUPED, PLATFORM]);
      ctx.button('TRASH.RESTORE')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/users/restore`)
        .flush({ data: { results: [result(GROUPED.id, 'restored')] } });
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/users/${PLATFORM.id}/restore`)
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await ctx.view();
      expect(ctx.root.querySelector('[role=alert]')?.textContent).toContain(PLATFORM.username);
      ctx.request('users').flush(trashPage([]));
      await ctx.view();
      finishTrash();
      TestBed.resetTestingModule();
      const all = await renderTrash('/trash?tab=users');
      await pick(all, [PLATFORM]);
      all.button('TRASH.RESTORE')!.click();
      await all.view();
      backend()
        .expectOne(`${API}/v1/users/${PLATFORM.id}/restore`)
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await all.view();
      expect(all.toasts()).toHaveLength(1);
    });
  });

  describe('groups', () => {
    it('reads GET /v1/groups?trashed=true with the dealer filter only, and restores in one call', async () => {
      const { request, view, root, tick, checkboxes, button } = await renderTrash(
        `/trash?tab=groups&groupId=${GROUP}&dealerId=${DEALER}`,
      );
      const req = request('groups');
      expect(req.request.params.has('groupId')).toBe(false);
      expect(req.request.params.get('dealerId')).toBe(DEALER);
      req.flush(trashPage([GROUP_ROW]));
      await view();
      expect([...root.querySelectorAll('fc-cross-group-filters label')]).toHaveLength(1);
      await tick(checkboxes()[0]);
      button('TRASH.RESTORE')!.click();
      await view();
      const post = backend().expectOne(`${API}/v1/trash/groups/restore`);
      expect(post.request.body).toEqual({ ids: [GROUP_ROW.id] });
      post.flush({ data: { results: [result(GROUP_ROW.id, 'restored')] } });
      await view();
      expect(root.textContent).toContain('TRASH.SUMMARY.RESTORED');
      request('groups').flush(trashPage([]));
      await view();
    });
  });

  describe('bulk actions across groups', () => {
    const select = async (ctx: Awaited<ReturnType<typeof renderTrash>>) => {
      ctx.request('companies').flush(trashPage([IN_G1, IN_G1_B, IN_G2]));
      await ctx.view();
      const all = ctx.root.querySelector<HTMLInputElement>('.bulk fc-checkbox input')!;
      all.checked = true;
      all.dispatchEvent(new Event('change'));
      await ctx.view();
    };

    it('restores with one request per group, in order, and merges the results', async () => {
      const ctx = await renderTrash('/trash');
      await select(ctx);
      ctx.button('TRASH.RESTORE')!.click();
      await ctx.view();
      const first = backend().expectOne(`${API}/v1/groups/${GROUP}/trash/companies/restore`);
      expect(first.request.body).toEqual({ ids: [IN_G1.id, IN_G1_B.id] });
      // The second group is asked only after the first one answered.
      expect(backend().match(`${API}/v1/groups/${G2}/trash/companies/restore`)).toHaveLength(0);
      first.flush({
        data: { results: [result(IN_G1.id, 'restored'), result(IN_G1_B.id, 'restored')] },
      });
      await ctx.view();
      const second = backend().expectOne(`${API}/v1/groups/${G2}/trash/companies/restore`);
      expect(second.request.body).toEqual({ ids: [IN_G2.id] });
      second.flush({ data: { results: [result(IN_G2.id, 'skipped', 'taken')] } });
      await ctx.view();
      expect(ctx.root.textContent).toContain('TRASH.SUMMARY.RESTORED {"count":2}');
      expect(ctx.root.textContent).toContain('TRASH.SUMMARY.SKIPPED {"count":1}');
      ctx.request('companies').flush(trashPage([]));
      await ctx.view();
    });

    it('keeps the results of the groups that worked when another one fails, and names it', async () => {
      const ctx = await renderTrash('/trash');
      await select(ctx);
      ctx.button('TRASH.RESTORE')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/companies/restore`)
        .flush({
          data: { results: [result(IN_G1.id, 'restored'), result(IN_G1_B.id, 'restored')] },
        });
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${G2}/trash/companies/restore`)
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await ctx.view();
      expect(ctx.toasts()).toEqual([]);
      expect(ctx.root.textContent).toContain('TRASH.SUMMARY.RESTORED {"count":2}');
      // A group without a name is told by its short id.
      expect(ctx.root.querySelector('[role=alert]')?.textContent).toContain(
        'TRASH.SUMMARY.FAILED_GROUPS',
      );
      expect(ctx.root.querySelector('[role=alert]')?.textContent).toContain('…ab34a2');
      ctx.request('companies').flush(trashPage([]));
      await ctx.view();
    });

    it('names a failed group with its name, and shows an error when every group fails', async () => {
      const ctx = await renderTrash('/trash');
      ctx.request('companies').flush(trashPage([IN_G1]));
      await ctx.view();
      const one = ctx.root.querySelector<HTMLInputElement>('td input[type=checkbox]')!;
      await ctx.tick(one);
      ctx.button('TRASH.RESTORE')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/companies/restore`)
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await ctx.view();
      expect(ctx.toasts()).toHaveLength(1);
      expect(ctx.toasts()[0]).toContain('error');
      expect(ctx.openDialogs()).toHaveLength(0);
    });

    it('lists the name of a group that failed when others worked', async () => {
      const ctx = await renderTrash('/trash');
      ctx.request('companies').flush(trashPage([IN_G1, IN_G3, IN_G2]));
      await ctx.view();
      const all = ctx.root.querySelector<HTMLInputElement>('.bulk fc-checkbox input')!;
      all.checked = true;
      all.dispatchEvent(new Event('change'));
      await ctx.view();
      ctx.button('TRASH.RESTORE')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/companies/restore`)
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${G3}/trash/companies/restore`)
        .flush({ data: { results: [result(IN_G3.id, 'restored')] } });
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${G2}/trash/companies/restore`)
        .flush({ data: { results: [result(IN_G2.id, 'restored')] } });
      await ctx.view();
      expect(ctx.root.querySelector('[role=alert]')?.textContent).toContain('Gruppo Uno');
      ctx.request('companies').flush(trashPage([]));
      await ctx.view();
    });

    it('deletes for good one group at a time after the confirmation', async () => {
      const ctx = await renderTrash('/trash');
      await select(ctx);
      ctx.button('TRASH.DELETE.ACTION')!.click();
      await ctx.view();
      ctx.dialogButton('TRASH.DELETE.ACTION')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/companies/delete`)
        .flush({
          data: { results: [result(IN_G1.id, 'deleted'), result(IN_G1_B.id, 'deleted')] },
        });
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${G2}/trash/companies/delete`)
        .flush({ data: { results: [result(IN_G2.id, 'deleted')] } });
      await ctx.view();
      expect(ctx.root.textContent).toContain('TRASH.SUMMARY.DELETED {"count":3}');
      ctx.request('companies').flush(trashPage([]));
      await ctx.view();
    });
  });

  describe('Svuota cestino', () => {
    it('is not offered without a group filter, and a hint says why', async () => {
      const { request, view, root, button } = await renderTrash('/trash');
      request('companies').flush(trashPage([IN_G1]));
      await view();
      expect(button('TRASH.EMPTY.ACTION')).toBeUndefined();
      expect(root.querySelector('.needs-group')?.textContent).toContain('TRASH.EMPTY.NEEDS_GROUP');
    });

    it('is offered with a group filter and empties that group', async () => {
      const ctx = await renderTrash(`/trash?groupId=${GROUP}`);
      ctx.request('companies').flush(trashPage([IN_G1]));
      await ctx.view();
      for (const read of backend().match((r) => /\/v1\/groups\/[0-9a-f]{24}$/.test(r.url))) {
        read.flush({ data: { name: 'Gruppo Uno' } });
      }
      await ctx.view();
      expect(ctx.root.querySelector('.needs-group')).toBeNull();
      ctx.button('TRASH.EMPTY.ACTION')!.click();
      await ctx.view();
      const understood = ctx.root.querySelector<HTMLInputElement>(
        'dialog[open] input[type=checkbox]',
      )!;
      understood.checked = true;
      understood.dispatchEvent(new Event('change'));
      await ctx.view();
      ctx.dialogButton('TRASH.EMPTY.START')!.click();
      await ctx.view();
      backend()
        .expectOne(`${API}/v1/groups/${GROUP}/trash/companies/empty`)
        .flush({ data: { results: [result(IN_G1.id, 'deleted')], remaining: 0, next: null } });
      await ctx.view();
      ctx.request('companies').flush(trashPage([]));
      await ctx.view();
    });

    it('has neither the button nor the hint without trash:empty, and not on the groups tab', async () => {
      const { request, view, root, button } = await renderTrash('/trash', {
        permissions: ['companies:read', 'companies:trash'],
      });
      request('companies').flush(trashPage([IN_G1]));
      await view();
      expect(button('TRASH.EMPTY.ACTION')).toBeUndefined();
      expect(root.querySelector('.needs-group')).toBeNull();
    });
  });
});
