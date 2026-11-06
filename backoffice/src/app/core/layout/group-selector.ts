import { Component, computed, ElementRef, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IconButton } from '../../shared/ui/icon-button/icon-button';
import { failureMessage } from '../../shared/forms/form-errors';
import { uniqueId } from '../../shared/ui/unique-id';
import { createDebouncer } from '../../shared/util/debouncer';
import { GroupContext } from '../groups/group-context';
import { I18nService } from '../i18n/i18n.service';
import { TPipe } from '../i18n/t-pipe';
import { GroupRef, ReferenceApi } from '../reference/reference-api';

/**
 * Header combobox (ARIA 1.2 editable combobox with list popup) to choose the working group of
 * a PSA or dealer: search by name (debounced), arrow keys, Enter, Esc, and "load more" as the
 * last option of the cursor-paginated list. Choosing a group remembers it and opens its users.
 */
@Component({
  selector: 'fc-group-selector',
  imports: [IconButton, TPipe],
  templateUrl: './group-selector.html',
  styleUrls: ['../../shared/ui/field.css', './group-selector.css'],
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class GroupSelector {
  private readonly api = inject(ReferenceApi);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);
  protected readonly context = inject(GroupContext);

  protected readonly inputId = uniqueId('fc-group-selector');
  protected readonly listId = `${this.inputId}-list`;
  protected readonly open = signal(false);
  protected readonly text = signal('');
  protected readonly items = signal<readonly GroupRef[]>([]);
  protected readonly next = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly active = signal(-1);

  private requestId = 0;
  private loaded = false;

  /** What the input shows: the search text while open, the working group otherwise. */
  protected readonly inputValue = computed(() => {
    if (this.open()) {
      return this.text();
    }
    const id = this.context.groupId();
    // A group adopted from the URL has no known name: show a short reference instead.
    return (
      this.context.groupName() ||
      (id === null ? '' : this.i18n.t('GROUP_SELECTOR.BY_ID', { id: id.slice(-6) }))
    );
  });
  protected readonly activeId = computed(() =>
    this.open() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );
  /** Number of options: "all groups" (index 0), the groups, and the "load more" one. */
  private readonly optionCount = computed(
    () => 1 + this.items().length + (this.next() === null ? 0 : 1),
  );
  protected readonly announcement = computed(() =>
    this.open() && !this.loading() && this.failure() === null
      ? this.i18n.t('GROUP_SELECTOR.RESULTS', { count: this.items().length })
      : '',
  );

  protected optionId(index: number): string {
    return `${this.inputId}-option-${index}`;
  }

  protected show(): void {
    if (this.open()) {
      return;
    }
    this.open.set(true);
    this.text.set('');
    if (!this.loaded) {
      void this.load(true);
    }
  }

  protected onInput(event: Event): void {
    this.open.set(true);
    this.text.set((event.target as HTMLInputElement).value);
    this.debouncer.schedule(() => void this.load(true));
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.show();
        this.active.update((index) => Math.min(index + 1, this.optionCount() - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => Math.max(index - 1, 0));
        break;
      case 'Enter':
        if (this.open() && this.active() >= 0) {
          event.preventDefault();
          this.activate(this.active());
        }
        break;
      case 'Escape':
        if (this.open()) {
          event.stopPropagation();
          this.close();
        }
        break;
    }
  }

  protected onFocusOut(event: FocusEvent): void {
    if (!this.host.nativeElement.contains(event.relatedTarget as Node | null)) {
      this.close();
    }
  }

  /**
   * Chooses "all groups" (index 0), the group at `index - 1`, or loads more when it is the last
   * "load more" option.
   */
  protected activate(index: number): void {
    if (index === 0) {
      this.clear();
      return;
    }
    const group = this.items()[index - 1];
    if (group === undefined) {
      void this.load(false);
      return;
    }
    this.context.choose({ id: group.id, name: group.name });
    this.close();
    void this.router.navigate(['/groups', group.id, 'users']);
  }

  /**
   * Back to "all groups": forgets the working group and moves to the cross-group view of the
   * current page (users, activity log); other pages stay where they are.
   */
  protected clear(): void {
    this.context.clear();
    this.close();
    const path = this.router.url.split('?')[0];
    if (/^\/groups\/[^/]+/.test(path)) {
      void this.router.navigate(['/users']);
    } else if (path === '/activity-log') {
      void this.router.navigate(['/activity-log'], {
        queryParams: { groupId: null },
        queryParamsHandling: 'merge',
      });
    }
  }

  protected retry(): void {
    void this.load(true);
  }

  private close(): void {
    this.debouncer.cancel();
    this.open.set(false);
  }

  private async load(reset: boolean): Promise<void> {
    const request = ++this.requestId;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const page = await this.api.groups({
        q: this.text(),
        cursor: reset ? null : this.next(),
      });
      if (request === this.requestId) {
        this.items.update((current) => (reset ? page.data : [...current, ...page.data]));
        this.next.set(page.page.next);
        this.loaded = true;
        if (reset) {
          this.active.set(page.data.length > 0 ? 1 : 0);
        }
      }
    } catch (error) {
      if (request === this.requestId) {
        this.failure.set(failureMessage(this.i18n, error));
      }
    } finally {
      if (request === this.requestId) {
        this.loading.set(false);
      }
    }
  }
}
