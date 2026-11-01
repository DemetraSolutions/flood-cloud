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
import { LanguageSelector } from './language-selector';
import { allowAll, MENU_ITEMS, visibleMenu } from './menu';
import { PageAnnouncer } from './page-announcer';
import { ThemeSelector } from './theme-selector';

/**
 * Application shell: skip link, header (name, theme and language selectors), side menu that
 * collapses to a drawer on small screens, the `<main>` content area and a live region that
 * announces page changes.
 */
@Component({
  selector: 'fc-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    Icon,
    IconButton,
    LanguageSelector,
    ThemeSelector,
    TPipe,
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

  /**
   * Menu entries visible to the current user. Session permissions and enabled features arrive
   * with tasks 3.5.4 and 4.5.2: until then every entry is visible.
   */
  protected readonly menu = visibleMenu(inject(MENU_ITEMS), allowAll, allowAll);

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
