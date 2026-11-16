import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { failureMessage } from '../../shared/forms/form-errors';
import { apiErrorOf } from '../profile/sessions';
import { EmailTemplatesApi } from './email-templates-api';
import { EmailTemplateSummary, templateRoute } from './email-template.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['name', 'updatedAt'] as const;

/** The places that stopped the deletion of a template. */
interface Blocked {
  readonly template: string;
  /** Names of the places (the id of a place the user cannot see). */
  readonly places: readonly string[];
}

/**
 * E-mail templates of a group (`/groups/:groupId/email-templates`): the name and the date of the
 * last change; the content is never in the list. Search, sort and cursor pagination live in the
 * URL. Whoever may update places creates and deletes; deleting asks for confirmation, and when the
 * server refuses (`409`) because a place still uses the template, the places are listed.
 */
@Component({
  selector: 'fc-email-templates-list',
  imports: [
    Button,
    Can,
    CellTemplate,
    ConfirmDialog,
    CursorPaginator,
    DataTable,
    ErrorState,
    RouterLink,
    RowActionsTemplate,
    TextField,
    TPipe,
  ],
  templateUrl: './email-templates-list.html',
  styleUrl: './email-templates-list.css',
})
export class EmailTemplatesList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(EmailTemplatesApi);
  private readonly store = inject(ReferenceStore);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly q = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly sortValue = computed(() => {
    const value = this.sort() ?? '';
    return SORT_KEYS.some((key) => value === key || value === `-${key}`) ? value : 'name';
  });
  protected readonly tableSort = computed<TableSort>(() => {
    const value = this.sortValue();
    return value.startsWith('-')
      ? { key: value.slice(1), direction: 'desc' }
      : { key: value, direction: 'asc' };
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return PAGE_SIZES.includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly newRoute = computed(() => templateRoute(this.groupId(), null));

  protected readonly templates = httpResource<ApiPage<EmailTemplateSummary>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const text = this.q()?.trim();
    if (text) {
      params['q'] = text;
    }
    if (this.cursor()) {
      params['cursor'] = this.cursor() as string;
    }
    return { url: this.api.baseUrl(this.groupId()), params };
  });

  protected readonly rows = computed(() => this.templates.value()?.data ?? []);
  protected readonly nextCursor = computed(() => this.templates.value()?.page.next ?? null);
  protected readonly loadError = computed(() => apiErrorOf(this.templates.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<EmailTemplateSummary>[]>(() => [
    { key: 'name', header: this.i18n.t('EMAIL_TEMPLATES.COLUMN.NAME'), sortable: true },
    {
      key: 'updatedAt',
      header: this.i18n.t('EMAIL_TEMPLATES.COLUMN.UPDATED'),
      sortable: true,
      hideNarrow: true,
      cell: (row) => this.date(row.updatedAt),
    },
  ]);
  protected readonly rowKey = (row: EmailTemplateSummary): string => row.id;

  // Deletion.
  protected readonly target = signal<EmailTemplateSummary | null>(null);
  protected readonly confirmOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly blocked = signal<Blocked | null>(null);
  protected readonly confirmMessage = computed(() =>
    this.i18n.t('EMAIL_TEMPLATES.DELETE.CONFIRM', { name: this.target()?.name ?? '' }),
  );

  protected detailRoute(row: EmailTemplateSummary): string[] {
    return templateRoute(this.groupId(), row.id);
  }

  protected rowLabel(row: EmailTemplateSummary): string {
    return this.i18n.t('EMAIL_TEMPLATES.DELETE.LABEL', { name: row.name });
  }

  protected date(value: string | null): string {
    return value === null
      ? ''
      : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  }

  protected askDelete(row: EmailTemplateSummary): void {
    this.blocked.set(null);
    this.target.set(row);
    this.confirmOpen.set(true);
  }

  protected async delete(): Promise<void> {
    const template = this.target() as EmailTemplateSummary;
    this.busy.set(true);
    try {
      await this.api.remove(this.groupId(), template.id);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        this.blocked.set({
          template: template.name,
          places: await this.placeNames(error.details.map((detail) => detail.field)),
        });
      } else {
        this.toast.error(failureMessage(this.i18n, error));
      }
      return;
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
    this.toast.success(this.i18n.t('EMAIL_TEMPLATES.DELETE.DONE', { name: template.name }));
    this.templates.reload();
  }

  protected reload(): void {
    this.templates.reload();
  }

  /** The names of the places of the details of a refused deletion (`places.<id>`); the id stands for a place the user cannot see. */
  private async placeNames(fields: readonly string[]): Promise<string[]> {
    const ids = fields.map((field) => field.replace(/^places\./, ''));
    try {
      const page = await this.store.page(this.groupId(), 'places', { ids });
      const names = new Map(page.data.map((place) => [place.id, place.name]));
      return ids.map((id) => names.get(id) ?? id);
    } catch (error) {
      console.warn('Cannot read the names of the places that use the template', error);
      return ids;
    }
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onSort(sort: TableSort): void {
    this.change({ sort: sort.direction === 'desc' ? `-${sort.key}` : sort.key });
  }

  protected onLimit(limit: number): void {
    this.change({ limit: String(limit) });
  }

  protected onNext(cursor: string): void {
    this.cursorStack.update((stack) => [...stack, this.cursor() ?? null]);
    void this.navigate({ cursor });
  }

  protected onPrevious(): void {
    const stack = this.cursorStack();
    this.cursorStack.set(stack.slice(0, -1));
    void this.navigate({ cursor: stack[stack.length - 1] });
  }

  private change(change: Record<string, string | null>): void {
    this.cursorStack.set([]);
    void this.navigate({ ...change, cursor: null });
  }

  private navigate(change: Record<string, string | null | undefined>): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: change,
      queryParamsHandling: 'merge',
    });
  }
}
