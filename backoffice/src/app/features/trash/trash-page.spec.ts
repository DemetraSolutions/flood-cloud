import {
  COMPANY_ROW,
  finishTrash,
  GROUP,
  PLACE_ROW,
  renderTrash,
  trashPage,
  USER_ROW,
} from '../../../testing/trash';

afterEach(finishTrash);

const labels = (root: HTMLElement) =>
  [...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent?.trim());

describe('TrashPage', () => {
  it('offers the four tabs to a platform administrator and opens the companies', async () => {
    const { flush, root } = await renderTrash();
    await flush('companies', [COMPANY_ROW]);
    expect(root.querySelector('h1')?.textContent).toBe('TRASH.TITLE');
    expect(labels(root)).toEqual([
      'TRASH.KIND.COMPANIES',
      'TRASH.KIND.PLACES',
      'TRASH.KIND.USERS',
      'TRASH.KIND.GROUPS',
    ]);
    const active = root.querySelector('[role=tab][aria-selected=true]');
    expect(active?.id).toBe('trash-tab-companies');
    const panel = root.querySelector('[role=tabpanel]');
    expect(panel?.id).toBe('trash-panel-companies');
    expect(panel?.getAttribute('aria-labelledby')).toBe('trash-tab-companies');
    expect(panel?.querySelector('fc-trash-tab')).not.toBeNull();
  });

  it('shows only the tabs the user may read', async () => {
    const { flush, root } = await renderTrash(undefined, {
      role: 'SA',
      permissions: ['places:read', 'users:read'],
    });
    await flush('places', [PLACE_ROW]);
    expect(labels(root)).toEqual(['TRASH.KIND.PLACES', 'TRASH.KIND.USERS']);
  });

  it('shows the groups tab only with the permission to restore groups', async () => {
    const { request, view, root } = await renderTrash(undefined, {
      permissions: ['companies:read', 'groups:trash'],
    });
    request('companies').flush(trashPage([]));
    await view();
    expect(labels(root)).toEqual(['TRASH.KIND.COMPANIES', 'TRASH.KIND.GROUPS']);
  });

  it('opens the tab of the URL', async () => {
    const { flush, root } = await renderTrash(`/groups/${GROUP}/trash?tab=users`);
    await flush('users', [USER_ROW]);
    expect(root.querySelector('[role=tab][aria-selected=true]')?.id).toBe('trash-tab-users');
  });

  it('falls back to the first tab for an unknown tab or one the user may not see', async () => {
    const unknown = await renderTrash(`/groups/${GROUP}/trash?tab=products`);
    await unknown.flush('companies', []);
    expect(unknown.root.querySelector('[role=tab][aria-selected=true]')?.id).toBe(
      'trash-tab-companies',
    );
  });

  it('changes tab in the URL, starting from the first page without a search', async () => {
    const { flush, root, view, search, request } = await renderTrash(
      `/groups/${GROUP}/trash?q=alfa&limit=50&cursor=c1`,
    );
    await flush('companies', [COMPANY_ROW]);
    root.querySelector<HTMLButtonElement>('#trash-tab-users')!.click();
    await view();
    expect(search().get('tab')).toBe('users');
    expect(search().has('q')).toBe(false);
    expect(search().has('limit')).toBe(false);
    expect(search().has('cursor')).toBe(false);
    const req = request('users');
    expect(req.request.params.get('q')).toBeNull();
    expect(req.request.params.get('limit')).toBe('25');
    req.flush(trashPage([USER_ROW]));
    await view();
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(root.querySelector('[role=tab][aria-selected=true]')?.id).toBe('trash-tab-users');
  });
});
