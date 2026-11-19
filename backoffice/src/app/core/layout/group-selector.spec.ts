import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { GroupContext, LAST_GROUP_ID_KEY } from '../groups/group-context';
import { I18nService } from '../i18n/i18n.service';
import { GroupSelector } from './group-selector';

const G1 = { id: '665f1c2e9b1d4a0012ab34a1', name: 'Alfa' };
const G2 = { id: '665f1c2e9b1d4a0012ab34a2', name: 'Beta' };
const G3 = { id: '665f1c2e9b1d4a0012ab34a3', name: 'Gamma' };

/** Lets pending promises run and the view update. */
async function view(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
  await settle();
  await fixture.whenStable();
}

function page(data: object[], next: string | null = null) {
  return { data, page: { limit: 25, next } };
}

async function render() {
  sessionStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      provideRouter([{ path: 'groups/:id/users', children: [] }]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'PSA', groupId: null, group: null });
  const fixture = TestBed.createComponent(GroupSelector);
  document.body.appendChild(fixture.nativeElement);
  await view(fixture);
  const root = fixture.nativeElement as HTMLElement;
  const input = root.querySelector<HTMLInputElement>('input')!;
  const allOption = () => root.querySelector<HTMLElement>('[role=option]')!;
  const options = () => [...root.querySelectorAll<HTMLElement>('[role=option]')].slice(1);
  const groupsRequests = () => backend().match((r) => r.url === `${API}/v1/groups`);
  const key = async (name: string) => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
    await view(fixture);
  };
  const open = async (data: object[], next: string | null = null) => {
    input.dispatchEvent(new Event('focus'));
    await settle();
    const [request] = groupsRequests();
    request.flush(page(data, next));
    await view(fixture);
    return request;
  };
  return { fixture, root, input, options, allOption, key, open, groupsRequests };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('GroupSelector', () => {
  it('shows the name of the working group, or a short reference when only its id is known', async () => {
    const { input, fixture } = await render();
    expect(input.value).toBe('');
    TestBed.inject(GroupContext).choose({ id: G1.id, name: '' });
    await view(fixture);
    expect(input.value).toBe('GROUP_SELECTOR.BY_ID {"id":"ab34a1"}');
    TestBed.inject(GroupContext).choose(G1);
    await view(fixture);
    expect(input.value).toBe('Alfa');
  });

  it('is a combobox that opens on focus and lists the first page of groups', async () => {
    const { input, options, root, open } = await render();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    const request = await open([G1, G2]);
    expect(request.request.params.get('limit')).toBe('25');
    expect(request.request.params.has('status')).toBe(false);
    expect(request.request.params.has('trashed')).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Alfa', 'Beta']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(root.querySelector('[role=status]')?.textContent).toBe(
      'GROUP_SELECTOR.RESULTS {"count":2}',
    );
  });

  describe('all groups', () => {
    const chosen = async () => {
      const ctx = await render();
      TestBed.inject(GroupContext).choose(G1);
      return ctx;
    };

    it('lists "all groups" first, selected while no group is chosen', async () => {
      const { allOption, open } = await render();
      await open([G1]);
      expect(allOption().textContent?.trim()).toBe('GROUP_SELECTOR.ALL');
      expect(allOption().getAttribute('aria-selected')).toBe('true');
    });

    it('has a labelled clear button only while a group is chosen', async () => {
      const { root, fixture } = await render();
      expect(root.querySelector('button[aria-label]')).toBeNull();
      TestBed.inject(GroupContext).choose(G1);
      await view(fixture);
      const button = root.querySelector<HTMLButtonElement>('button[aria-label]')!;
      expect(button.getAttribute('aria-label')).toBe('GROUP_SELECTOR.CLEAR');
    });

    it.each([
      ['/groups/g1/users', ['/users'], undefined],
      ['/groups/g1/users/u1', ['/users'], undefined],
      [
        '/activity-log?groupId=g1',
        ['/activity-log'],
        { queryParams: { groupId: null }, queryParamsHandling: 'merge' },
      ],
    ])('clearing from %s goes to the cross-group view', async (url, command, extras) => {
      const { root, fixture } = await chosen();
      await view(fixture);
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'url', 'get').mockReturnValue(url);
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      root.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
      await view(fixture);
      expect(navigate).toHaveBeenCalledWith(...(extras ? [command, extras] : [command]));
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
      expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBeNull();
    });

    it('stays on pages that do not depend on the group', async () => {
      const { root, fixture } = await chosen();
      await view(fixture);
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'url', 'get').mockReturnValue('/profile');
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      root.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
      await view(fixture);
      expect(navigate).not.toHaveBeenCalled();
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    });

    it('is chosen with a click or the keyboard on the first option', async () => {
      const { allOption, open, key, input, fixture } = await chosen();
      await open([G1]);
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      await key('ArrowUp');
      await key('Enter');
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
      expect(input.getAttribute('aria-expanded')).toBe('false');
      TestBed.inject(GroupContext).choose(G2);
      input.click();
      await view(fixture);
      allOption().click();
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    });
  });

  it('does not reload when reopened and ignores repeated opens', async () => {
    const { input, key, open, fixture, groupsRequests } = await render();
    await open([G1]);
    input.click();
    await key('Escape');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    input.click();
    await view(fixture);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(groupsRequests()).toHaveLength(0);
  });

  it('moves the active option with the arrows and chooses it with Enter', async () => {
    const { input, options, allOption, key, open } = await render();
    await open([G1, G2]);
    await key('ArrowDown');
    expect(options()[1].classList.contains('active')).toBe(true);
    await key('ArrowDown');
    expect(options()[1].classList.contains('active')).toBe(true);
    await key('ArrowUp');
    expect(options()[0].classList.contains('active')).toBe(true);
    await key('ArrowUp');
    await key('ArrowUp');
    expect(allOption().classList.contains('active')).toBe(true);
    await key('ArrowDown');
    await key('ArrowDown');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await key('Enter');
    expect(navigate).toHaveBeenCalledWith(['/groups', G2.id, 'users']);
    expect(TestBed.inject(GroupContext).groupId()).toBe(G2.id);
    expect(sessionStorage.getItem(LAST_GROUP_ID_KEY)).toBe(G2.id);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('Beta');
  });

  it('opens with ArrowDown when closed, and Enter or Escape do nothing when closed', async () => {
    const { input, key, groupsRequests, fixture } = await render();
    await key('Enter');
    await key('Escape');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await key('ArrowDown');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    await settle();
    groupsRequests()[0].flush(page([]));
    await view(fixture);
    // With no group listed the active option is "all groups": Enter chooses it and closes.
    await key('Enter');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('ignores other keys', async () => {
    const { input, key, open } = await render();
    await open([G1]);
    await key('a');
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('reaches the "load more" option with the keyboard and loads more with Enter', async () => {
    const { options, key, open, fixture, groupsRequests } = await render();
    await open([G1], 'c1');
    await key('ArrowDown');
    await key('ArrowDown');
    expect(options()[1].classList.contains('active')).toBe(true);
    await key('Enter');
    await settle();
    groupsRequests()[0].flush(page([G2]));
    await view(fixture);
    expect(options()).toHaveLength(2);
  });

  it('chooses a group by clicking it', async () => {
    const { options, open } = await render();
    await open([G1, G2]);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    options()[0].click();
    expect(navigate).toHaveBeenCalledWith(['/groups', G1.id, 'users']);
  });

  it.each([
    ['/groups?to=companies', '/groups/G1/companies'],
    ['/groups?to=fidelity/card-types', '/groups/G1/fidelity/card-types'],
  ])('from the chooser %s it goes to the page the user wanted', async (url, expected) => {
    const { options, open } = await render();
    await open([G1, G2]);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'url', 'get').mockReturnValue(url);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    options()[0].click();
    expect(navigateByUrl).toHaveBeenCalledWith(expected.replace('G1', encodeURIComponent(G1.id)));
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    '/groups',
    '/groups?to=',
    '/groups?to=evil',
    '/groups?to=//evil.example',
    '/groups?to=https://evil.example',
    '/groups?to=companies/../../x',
    '/groups?to=..%2Fusers',
    '/groups?to=Companies',
    '/groups?to=companies%00',
    '/groups?to=x&to=companies',
    '/users?to=companies',
  ])('ignores a hostile or missing destination (%s) and opens the users list', async (url) => {
    const { options, open } = await render();
    await open([G1, G2]);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'url', 'get').mockReturnValue(url);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    options()[0].click();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/groups', G1.id, 'users']);
  });

  it.each([
    ['/users?q=ann&role=SA&cursor=c1&groupId=x', { q: 'ann', role: 'SA' }],
    [
      '/users?role=D&status=active&trashed=true&sort=-createdAt&limit=50',
      {
        status: 'active',
        trashed: 'true',
        sort: '-createdAt',
        limit: '50',
      },
    ],
    ['/groups/g0/users?q=ann&role=PSA&dealerId=x', { q: 'ann' }],
  ])(
    'keeps the filters of the users list on screen when choosing a group (%s)',
    async (url, expected) => {
      const { options, open } = await render();
      await open([G1]);
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'url', 'get').mockReturnValue(url);
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      options()[0].click();
      expect(navigate).toHaveBeenCalledWith(['/groups', G1.id, 'users'], { queryParams: expected });
    },
  );

  it.each([
    [
      '/groups/g1/companies?q=ann&status=active&cursor=c1&companyId=x&sort=-name',
      '/companies',
      { q: 'ann', status: 'active', sort: '-name' },
    ],
    [
      '/groups/g1/places?q=bar&plan=advanced&country=IT&limit=50&companyId=x&cursor=c',
      '/places',
      { q: 'bar', plan: 'advanced', country: 'IT', limit: '50' },
    ],
    ['/groups/g1/places', '/places', null],
    ['/groups/g1/companies/c9?q=ann', '/companies', null],
    ['/groups/g1/places/p9/devices', '/places', null],
  ])(
    'from %s going back to all groups opens the cross-group list %s',
    async (url, target, filters) => {
      const { root, fixture } = await render();
      TestBed.inject(GroupContext).choose(G1);
      await view(fixture);
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'url', 'get').mockReturnValue(url);
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      root.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
      expect(navigate).toHaveBeenCalledWith(
        [target],
        ...(filters === null ? [] : [{ queryParams: filters }]),
      );
    },
  );

  it('keeps the filters of the users list, role included, when going back to all groups', async () => {
    const { root, fixture } = await render();
    TestBed.inject(GroupContext).choose(G1);
    await view(fixture);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/groups/g1/users?q=ann&role=SA&cursor=c1');
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    root.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
    expect(navigate).toHaveBeenCalledWith(['/users'], { queryParams: { q: 'ann', role: 'SA' } });
  });

  it('carries nothing over from pages that are not a users list', async () => {
    const { options, open } = await render();
    await open([G1]);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/?q=ann');
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    options()[0].click();
    expect(navigate).toHaveBeenCalledWith(['/groups', G1.id, 'users']);
  });

  it('marks the working group as selected', async () => {
    const { options, open } = await render();
    TestBed.inject(GroupContext).choose(G2);
    await open([G1, G2]);
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  });

  it('loads more groups from the last option', async () => {
    const { options, open, fixture, groupsRequests } = await render();
    await open([G1], 'c1');
    expect(options()).toHaveLength(2);
    expect(options()[1].textContent?.trim()).toBe('GROUP_SELECTOR.MORE');
    options()[1].click();
    await settle();
    const [request] = groupsRequests();
    expect(request.request.params.get('cursor')).toBe('c1');
    request.flush(page([G2]));
    await view(fixture);
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Alfa', 'Beta']);
  });

  it('searches as the user types, once the typing pauses', async () => {
    const { input, options, open, fixture, groupsRequests } = await render();
    await open([G1, G2]);
    vi.useFakeTimers();
    input.value = 'ga';
    input.dispatchEvent(new Event('input'));
    input.value = 'gam';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(groupsRequests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    const [request] = groupsRequests();
    expect(request.request.params.get('q')).toBe('gam');
    request.flush(page([G3]));
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Gamma']);
    expect(input.value).toBe('gam');
  });

  it('shows an empty message when nothing matches', async () => {
    const { root, open } = await render();
    await open([]);
    expect(root.querySelector('.note')?.textContent).toContain('GROUP_SELECTOR.EMPTY');
  });

  it('shows a loading note while waiting', async () => {
    const { root, input, fixture, groupsRequests } = await render();
    input.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    expect(root.querySelector('.note')?.textContent).toContain('COMMON.LOADING');
    await settle();
    groupsRequests()[0].flush(page([]));
    await view(fixture);
  });

  it('reports a failure and retries', async () => {
    const { root, input, options, fixture } = await render();
    input.dispatchEvent(new Event('focus'));
    await settle();
    failRequest(backend(), '/v1/groups?limit=25', 'INTERNAL_ERROR');
    await view(fixture);
    expect(root.querySelector('[role=alert]')?.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(root.querySelector('[role=status]')?.textContent).toBe('');
    root.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
    await settle();
    backend()
      .expectOne(`${API}/v1/groups?limit=25`)
      .flush(page([G1]));
    await view(fixture);
    expect(options()).toHaveLength(1);
    expect(root.querySelector('[role=alert]')).toBeNull();
  });

  it('ignores the answer of a request that was superseded', async () => {
    const { input, options, fixture, groupsRequests } = await render();
    input.dispatchEvent(new Event('focus'));
    await settle();
    const [first] = groupsRequests();
    vi.useFakeTimers();
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    const [second] = groupsRequests();
    first.flush(page([G1]));
    second.flush(page([G2]));
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Beta']);
  });

  it('ignores the failure of a request that was superseded', async () => {
    const { input, options, fixture, groupsRequests, root } = await render();
    input.dispatchEvent(new Event('focus'));
    await settle();
    const [first] = groupsRequests();
    vi.useFakeTimers();
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    const [second] = groupsRequests();
    first.flush(
      { error: { code: 'INTERNAL_ERROR', message: 'm' } },
      { status: 500, statusText: 'x' },
    );
    second.flush(page([G2]));
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(options()).toHaveLength(1);
  });

  it('closes when the focus leaves, but not when it moves inside', async () => {
    const { input, root, open, fixture } = await render();
    await open([G1]);
    const popup = root.querySelector('.popup')!;
    popup.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: input }));
    await view(fixture);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await view(fixture);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps focus on the input when the popup is pressed', async () => {
    const { root, open } = await render();
    await open([G1]);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    root.querySelector('.popup')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
