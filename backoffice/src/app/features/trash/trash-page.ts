import { Component, computed, inject, input } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { TrashTab } from './trash-tab';
import { READ_PERMISSION, TRASH_KINDS, TrashKind } from './trash.types';

/**
 * Trash of a group (`/groups/:groupId/trash`): a tab for the companies, places and users of the
 * working group and, for the platform administrator, one for the groups of the whole platform.
 * A tab is offered only with its read permission. The tab, the search and the pagination live
 * in the URL (changing tab starts from the first page without a search).
 */
@Component({
  selector: 'fc-trash-page',
  imports: [TabList, TPipe, TrashTab],
  templateUrl: './trash-page.html',
  styleUrl: './trash-page.css',
})
export class TrashPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly tab = input<string>();
  readonly q = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  private readonly kinds = computed(() =>
    TRASH_KINDS.filter((kind) => this.session.can(READ_PERMISSION[kind])),
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

  protected select(tab: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab, q: null, limit: null, cursor: null },
      queryParamsHandling: 'merge',
    });
  }
}
