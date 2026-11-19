import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { TPipe } from '../i18n/t-pipe';
import { IconButton } from '../../shared/ui/icon-button/icon-button';
import { Icon } from '../../shared/ui/icon/icon';
import { GroupContext } from '../groups/group-context';
import { GroupFeatures } from '../groups/group-features';
import { GroupSelector } from './group-selector';
import { SessionService } from '../session/session.service';
import { activeMenuIds, activeParentIds, MENU_ITEMS, MenuItem, visibleMenu } from './menu';
import { PageAnnouncer } from './page-announcer';
import { UserMenu } from './user-menu';

/**
 * Application shell: skip link, header (name, group selector for PSA and dealers, user menu), side menu that
 * collapses to a drawer on small screens, the `<main>` content area and a live region that
 * announces page changes.
 */
@Component({
  selector: 'fc-shell',
  imports: [RouterLink, RouterOutlet, GroupSelector, Icon, IconButton, TPipe, UserMenu],
  templateUrl: './shell.html',
  styleUrl: './shell.css',
  host: { '(keydown.escape)': 'onEscape()' },
})
export class Shell {
  protected readonly announcer = inject(PageAnnouncer);
  private readonly main = viewChild.required('main', { read: ElementRef });
  private readonly toggle = viewChild.required('toggle', {
    read: ElementRef,
  });
  private readonly drawerClose = viewChild.required('drawerClose', { read: ElementRef });
  private readonly injector = inject(Injector);

  private readonly session = inject(SessionService);
  private readonly menuItems = inject(MENU_ITEMS);
  protected readonly groups = inject(GroupContext);
  private readonly features = inject(GroupFeatures);

  /** The side menu is offered only to a fully signed-in user (not while a password change is pending). */
  protected readonly showNav = computed(() => this.session.status() === 'authenticated');

  /**
   * Menu entries visible to the current user: filtered by the permissions the server granted and
   * by the features of the working group; the entries that need a working group appear only once
   * one is selected (PSA and dealers), and follow the selection without a reload.
   */
  protected readonly menu = computed(() =>
    visibleMenu(
      this.menuItems,
      (permission) => this.session.can(permission),
      (feature) => this.features.enabled(feature),
      this.session.me()?.role,
      this.groups.groupId() !== null,
    ),
  );

  /** Router link of an entry: group pages point to the working group once there is one. */
  protected link(item: MenuItem): string {
    const groupId = this.groups.groupId();
    if (item.groupPath === undefined) {
      return item.route;
    }
    return groupId === null
      ? (item.allRoute ?? item.route)
      : `/groups/${groupId}/${item.groupPath}`;
  }

  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /**
   * Query of an entry's link: without a working group a group page points to the chooser and
   * carries the page it stands for, so that the choice leads there.
   */
  protected queryOf(item: MenuItem): { to: string } | null {
    return item.groupPath !== undefined &&
      this.link(item) === item.route &&
      item.route === '/groups'
      ? { to: item.groupPath }
      : null;
  }

  /** Entries shown as the current page: the most specific match only (see `activeMenuIds`). */
  protected readonly activeIds = computed(() =>
    activeMenuIds(this.menu(), (item) => this.link(item), this.url()),
  );

  /** Entries with children that contain the current page. */
  protected readonly activeParents = computed(() => activeParentIds(this.menu(), this.activeIds()));

  /** Whether the drawer is open (only meaningful on small screens). */
  protected readonly menuOpen = signal(false);
  /** `inert` value for the page behind the open drawer. */
  protected readonly drawerInert = computed(() => (this.menuOpen() ? '' : null));

  protected toggleMenu(): void {
    if (this.menuOpen()) {
      this.closeMenu();
    } else {
      this.menuOpen.set(true);
      this.focusAfterRender(() => this.drawerClose().nativeElement);
    }
  }

  /** Closes the drawer (if open) and returns the focus to the menu button. */
  protected closeMenu(): void {
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      this.focusAfterRender(() => this.toggle().nativeElement);
    }
  }

  protected onEscape(): void {
    this.closeMenu();
  }

  // The target may be inert or hidden until the view has been re-rendered.
  private focusAfterRender(target: () => HTMLElement): void {
    afterNextRender(() => target().focus(), { injector: this.injector });
  }

  protected skipToContent(event: Event): void {
    event.preventDefault();
    this.main().nativeElement.focus();
  }
}
