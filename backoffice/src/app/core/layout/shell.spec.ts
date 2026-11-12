import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { fakeFeatureFlags } from '../../../testing/groups';
import { signIn } from '../../../testing/session';
import { GroupContext } from '../groups/group-context';
import { I18nService } from '../i18n/i18n.service';
import { SessionService } from '../session/session.service';
import { Profile } from '../session/session.types';
import { PageAnnouncer } from './page-announcer';
import { MENU_ITEMS, MenuItem } from './menu';
import { Shell } from './shell';

async function render(menu?: readonly MenuItem[], profile: Partial<Profile> | null = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      ...(menu ? [{ provide: MENU_ITEMS, useValue: menu }] : []),
      provideRouter([
        {
          path: '',
          component: Shell,
          children: [
            {
              path: 'page',
              loadComponent: () => import('../../features/home/home').then((m) => m.Home),
            },
          ],
        },
      ]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `[${key}]`);
  if (profile !== null) {
    signIn(profile);
  }
  const harness = await RouterTestingHarness.create('/page');
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  return { harness, root, announcer: TestBed.inject(PageAnnouncer) };
}

afterEach(() => vi.restoreAllMocks());

describe('Shell', () => {
  it('has a skip link first, a banner header, a named nav and the main content', async () => {
    const { root } = await render();
    const first = root.querySelector('a')!;
    expect(first.className).toContain('skip-link');
    expect(first.textContent).toBe('[LAYOUT.SKIP_TO_CONTENT]');
    expect(root.querySelector('header')?.textContent).toContain('[APP.NAME]');
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe('[LAYOUT.MAIN_NAV]');
    expect(root.querySelector('main')?.id).toBe('main');
    expect(root.querySelector('main h1')).not.toBeNull();
    expect(root.querySelector('fc-theme-selector select')).not.toBeNull();
    expect(root.querySelector('fc-language-selector select')).not.toBeNull();
  });

  it('moves the focus to the main content from the skip link without navigating', async () => {
    const { root } = await render();
    const link = root.querySelector<HTMLAnchorElement>('.skip-link')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('main'));
  });

  it('lists the visible menu entries with the current page marked', async () => {
    const { root } = await render();
    const links = root.querySelectorAll<HTMLAnchorElement>('nav a');
    expect(links.length).toBe(2);
    expect(links[0].textContent).toContain('[MENU.HOME]');
    expect(links[0].getAttribute('href')).toBe('/');
    expect(links[0].hasAttribute('aria-current')).toBe(false);
    expect(links[1].textContent).toContain('[MENU.PROFILE]');
  });

  it('hides the entries whose permission the user lacks', async () => {
    const { root } = await render(undefined, { permissions: [] });
    const links = root.querySelectorAll<HTMLAnchorElement>('nav a');
    expect([...links].map((l) => l.getAttribute('href'))).toEqual(['/']);
  });

  it('follows the permissions of the session when they change', async () => {
    const { harness, root } = await render(undefined, { permissions: [] });
    signIn({ permissions: ['profile:read'] });
    harness.detectChanges();
    expect(root.querySelectorAll('nav a').length).toBe(2);
  });

  it('offers no side menu while a temporary password must be changed', async () => {
    const { root } = await render(undefined, { passwordChangeRequired: true });
    expect(root.querySelector('nav')).toBeNull();
    expect(root.querySelector('.menu-toggle')).toBeNull();
    expect(root.querySelector('fc-user-menu')).not.toBeNull();
    expect(TestBed.inject(SessionService).status()).toBe('passwordChangeRequired');
  });

  it('shows the user menu in the header', async () => {
    const { root } = await render();
    expect(root.querySelector('header fc-user-menu .trigger')?.textContent).toContain(
      'mario.rossi',
    );
  });

  it('renders groups with their sub-entries and marks the current page', async () => {
    const { root } = await render([
      {
        id: 'g',
        labelKey: 'G',
        icon: 'home',
        route: '/g',
        children: [{ id: 'c', labelKey: 'C', icon: 'home', route: '/page' }],
      },
    ]);
    const links = root.querySelectorAll<HTMLAnchorElement>('nav a');
    expect([...links].map((l) => l.getAttribute('href'))).toEqual(['/g', '/page']);
    expect(links[1].getAttribute('aria-current')).toBe('page');
    expect(links[1].classList.contains('active')).toBe(true);
  });

  it('hides the entries whose feature the working group does not have', async () => {
    const { root } = await render(
      [
        { id: 'a', labelKey: 'A', icon: 'home', route: '/a' },
        { id: 'w', labelKey: 'W', icon: 'home', route: '/w', feature: 'warehouse' },
        { id: 'r', labelKey: 'R', icon: 'home', route: '/r', feature: 'rooms' },
      ],
      { role: 'SA', groupFeatures: fakeFeatureFlags(false, { warehouse: true }) },
    );
    expect([...root.querySelectorAll('nav a')].map((l) => l.getAttribute('href'))).toEqual([
      '/a',
      '/w',
    ]);
  });

  describe('working group', () => {
    const usersMenu: MenuItem[] = [
      { id: 'home', labelKey: 'HOME', icon: 'home', route: '/' },
      {
        id: 'users',
        labelKey: 'USERS',
        icon: 'users',
        route: '/groups',
        groupPath: 'users',
        permission: 'users:read',
      },
    ];
    const hrefs = (root: HTMLElement) =>
      [...root.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));

    it('links group pages to the group of the profile and offers no selector', async () => {
      const { root } = await render(usersMenu, { role: 'SA', permissions: ['users:read'] });
      expect(hrefs(root)).toEqual(['/', '/groups/665f1c2e9b1d4a0012ab34a1/users']);
      expect(root.querySelector('fc-group-selector')).toBeNull();
    });

    it('offers the selector to a PSA and links to the chooser until a group is chosen', async () => {
      sessionStorage.clear();
      const { root, harness } = await render(usersMenu, {
        role: 'PSA',
        groupId: null,
        group: null,
        permissions: ['users:read'],
      });
      expect(root.querySelector('header fc-group-selector')).not.toBeNull();
      expect(hrefs(root)).toEqual(['/', '/groups']);
      TestBed.inject(GroupContext).choose({ id: '665f1c2e9b1d4a0012ab34a2', name: 'Alfa' });
      harness.detectChanges();
      expect(hrefs(root)).toEqual(['/', '/groups/665f1c2e9b1d4a0012ab34a2/users']);
      sessionStorage.clear();
    });

    it('links children of a group entry as well', async () => {
      const { root } = await render(
        [
          {
            id: 'g',
            labelKey: 'G',
            icon: 'home',
            route: '/g',
            children: [
              { id: 'c', labelKey: 'C', icon: 'users', route: '/groups', groupPath: 'users' },
            ],
          },
        ],
        { role: 'SA' },
      );
      expect(hrefs(root)).toEqual(['/g', '/groups/665f1c2e9b1d4a0012ab34a1/users']);
    });
  });

  describe('mobile drawer', () => {
    // jsdom ignores media queries: show the mobile-only controls, as on a phone.
    let style: HTMLStyleElement;
    beforeEach(() => {
      style = document.createElement('style');
      style.textContent =
        '.menu-toggle, .drawer-close { display: inline-flex !important; } .backdrop.open { display: block !important; }';
      document.head.appendChild(style);
    });
    afterEach(() => style.remove());

    async function open() {
      const ctx = await render();
      const q = <T extends Element>(selector: string) => ctx.root.querySelector<T>(selector)!;
      const toggle = q<HTMLButtonElement>('.menu-toggle');
      toggle.click();
      await ctx.harness.fixture.whenStable();
      return { ...ctx, q, toggle };
    }

    it('has an accessible toggle that opens the drawer and focuses its close button', async () => {
      const { harness, q, toggle } = await render().then(async (ctx) => ({
        ...ctx,
        q: <T extends Element>(selector: string) => ctx.root.querySelector<T>(selector)!,
        toggle: ctx.root.querySelector<HTMLButtonElement>('.menu-toggle')!,
      }));
      expect(toggle.getAttribute('aria-label')).toBe('[LAYOUT.MENU]');
      expect(toggle.getAttribute('aria-controls')).toBe(q('nav').id);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(q('main').hasAttribute('inert')).toBe(false);

      toggle.click();
      await harness.fixture.whenStable();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(q('nav').classList.contains('open')).toBe(true);
      expect(q('.drawer-close').getAttribute('aria-label')).toBe('[LAYOUT.CLOSE_MENU]');
      expect(document.activeElement).toBe(q('.drawer-close'));
    });

    it('makes the page behind the drawer inert while it is open', async () => {
      const { harness, q, toggle } = await open();
      for (const selector of ['header', 'main', '.skip-link']) {
        expect(q(selector).hasAttribute('inert')).toBe(true);
      }
      expect(q('nav').hasAttribute('inert')).toBe(false);
      q<HTMLButtonElement>('.drawer-close').click();
      await harness.fixture.whenStable();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes with the close button and returns the focus to the menu button', async () => {
      const { harness, q, toggle } = await open();
      q<HTMLButtonElement>('.drawer-close').click();
      await harness.fixture.whenStable();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(q('main').hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(toggle);
    });

    it('closes by clicking the backdrop', async () => {
      const { harness, q, toggle } = await open();
      q<HTMLElement>('.backdrop').click();
      await harness.fixture.whenStable();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
    });

    it('closes when a menu entry is chosen', async () => {
      const { harness, q, toggle } = await open();
      q('nav a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await harness.fixture.whenStable();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes with Escape', async () => {
      const { harness, q, toggle } = await open();
      q('nav a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await harness.fixture.whenStable();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
    });

    it('toggles closed when the menu button is pressed again', async () => {
      const { harness, toggle } = await open();
      toggle.focus();
      toggle.removeAttribute('inert');
      toggle.click();
      await harness.fixture.whenStable();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('ignores Escape and nav clicks when the drawer is closed', async () => {
      const { harness, root } = await render();
      root.querySelector('nav a')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await harness.fixture.whenStable();
      expect(document.activeElement).not.toBe(root.querySelector('.menu-toggle'));
    });
  });

  it('announces page changes in a status region', async () => {
    const { harness, root, announcer } = await render();
    announcer.announce('Home');
    harness.detectChanges();
    const status = root.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('Home');
    expect(status.classList.contains('visually-hidden')).toBe(true);
  });
});
