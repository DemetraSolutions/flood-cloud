import { Component, computed, inject, input } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { CrossGroupFilterChange, CrossGroupFilters } from '../groups/cross-group-filters';
import { TrashTab } from './trash-tab';
import { READ_PERMISSION, TRASH_KINDS, TrashKind } from './trash.types';

const OBJECT_ID = /^[0-9a-f]{24}$/;

/**
 * Trash of a group (`/groups/:groupId/trash`) or, for a PSA or dealer with no working group, of
 * every group in their scope (`/trash`, route data `scope: 'all'`: `groupId` and `dealerId` are
 * then query filters shared by the tabs). A tab for the companies, places and users and, with
 * `groups:trash`, one for the groups of the platform.
 * A tab is offered only with its read permission. The tab, the search and the pagination live
 * in the URL (changing tab starts from the first page without a search).
 */
@Component({
  selector: 'fc-trash-page',
  imports: [CrossGroupFilters, TabList, TPipe, TrashTab],
  templateUrl: './trash-page.html',
  styleUrl: './trash-page.css',
})
export class TrashPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input<string>();
  /** Route data: `all` for the cross-group trash (`/trash`). */
  readonly scope = input<string>();
  /** Dealer filter (cross-group trash, platform administrator only). */
  readonly dealerId = input<string>();
  readonly tab = input<string>();
  readonly q = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly isAll = computed(() => this.scope() === 'all');
  /** Group of the page: the path parameter, `undefined` in the cross-group trash. */
  protected readonly ownGroupId = computed(() => (this.isAll() ? undefined : this.groupId()));
  /** Group filter of the cross-group trash (valid ids only). */
  protected readonly groupFilter = computed(() => {
    const value = this.groupId();
    return this.isAll() && OBJECT_ID.test(value ?? '') ? value : undefined;
  });
  protected readonly dealerFilter = computed(() => {
    const value = this.dealerId();
    return this.isAll() && this.session.me()?.role === 'PSA' && OBJECT_ID.test(value ?? '')
      ? value
      : undefined;
  });

  // The products and the contacts are managed by group: the cross-group trash has no tab for them.
  private readonly kinds = computed(() =>
    TRASH_KINDS.filter(
      (kind) =>
        this.session.can(READ_PERMISSION[kind]) &&
        !(this.isAll() && (kind === 'products' || kind === 'contacts')),
    ),
  );
  protected readonly tabs = computed<TabItem[]>(() =>
    this.kinds().map((kind) => ({
      id: kind,
      label: this.i18n.t(`TRASH.KIND.${kind.toUpperCase()}`),
    })),
  );
  /** The tab of the URL when the user may see it, the first one otherwise. */
  protected readonly active = computed<TrashKind>(() => {
    const kinds = this.kinds();
    return kinds.find((kind) => kind === this.tab()) ?? kinds[0];
  });

  /** A group or dealer filter changed: the first page is shown again. */
  protected onFilter(change: CrossGroupFilterChange): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [change.name]: change.value === '' ? null : change.value, cursor: null },
      queryParamsHandling: 'merge',
    });
  }

  protected select(tab: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab, q: null, limit: null, cursor: null },
      queryParamsHandling: 'merge',
    });
  }
}
