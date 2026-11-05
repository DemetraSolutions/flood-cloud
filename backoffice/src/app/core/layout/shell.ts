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
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TPipe } from '../i18n/t-pipe';
import { IconButton } from '../../shared/ui/icon-button/icon-button';
import { Icon } from '../../shared/ui/icon/icon';
import { GroupContext } from '../groups/group-context';
import { GroupSelector } from './group-selector';
import { LanguageSelector } from './language-selector';
import { SessionService } from '../session/session.service';
import { allowAll, MENU_ITEMS, MenuItem, visibleMenu } from './menu';
import { PageAnnouncer } from './page-announcer';
import { ThemeSelector } from './theme-selector';
import { UserMenu } from './user-menu';

/**
 * Application shell: skip link, header (name, group selector for PSA and dealers, theme and language selectors, user menu), side menu that
 * collapses to a drawer on small screens, the `<main>` content area and a live region that
 * announces page changes.
 */
@Component({
  selector: 'fc-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    GroupSelector,
    Icon,
    IconButton,
    LanguageSelector,
    ThemeSelector,
    TPipe,
    UserMenu,
  ],
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

  /** The side menu is offered only to a fully signed-in user (not while a password change is pending). */
  protected readonly showNav = computed(() => this.session.status() === 'authenticated');

  /**
   * Menu entries visible to the current user: filtered by the permissions the server granted.
   * Enabled features arrive with task 4.5.2: until then every feature is considered enabled.
   */
  protected readonly menu = computed(() =>
    visibleMenu(
      this.menuItems,
      (permission) => this.session.can(permission),
      allowAll,
      this.session.me()?.role,
    ),
  );

  /** Router link of an entry: group pages point to the working group once there is one. */
  protected link(item: MenuItem): string {
    const groupId = this.groups.groupId();
    return item.groupPath === undefined || groupId === null
      ? item.route
      : `/groups/${groupId}/${item.groupPath}`;
  }

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
