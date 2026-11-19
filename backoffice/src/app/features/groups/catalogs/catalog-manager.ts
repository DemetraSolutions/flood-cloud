import { httpResource } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  contentChild,
  inject,
  input,
  signal,
  TemplateRef,
} from '@angular/core';
import { ApiData } from '../../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { ActionsMenu } from '../../../shared/ui/actions-menu/actions-menu';
import { Button } from '../../../shared/ui/button/button';
import { ConfirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog';
import { DataTable } from '../../../shared/ui/data-table/data-table';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { RowActionsTemplate } from '../../../shared/ui/data-table/table-templates';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { ErrorState } from '../../../shared/ui/error-state/error-state';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../../profile/sessions';
import { CatalogSegment } from './catalog.types';
import { catalogFailureMessage } from './catalog-errors';
import { CatalogsApi } from './catalogs-api';

/** Catalogs of the group record; each has its texts under `CATALOG.<KIND>` in the dictionary. */
export type CatalogKind =
  | 'PRICE_LISTS'
  | 'TAXES'
  | 'CURRENCIES'
  | 'MEASURE_UNITS'
  | 'WAREHOUSE_RULES'
  | 'FIDELITY_CARD_RULES'
  | 'CARD_TYPES'
  | 'POINTS_COLLECTIONS'
  | 'PRIZE_CATALOGUES'
  | 'PRODUCT_FAVORITES'
  | 'PROMOTIONS';

/**
 * What the manager gives to the editor template of a catalog (`let-item`, `let-error="error"`…).
 * The editor shows the form, builds the body and calls `save`; `cancel` closes the dialog.
 */
export interface EditorContext<T> {
  /** The element being changed; `null` when creating. */
  readonly $implicit: T | null;
  /** Error of the last save, to show on the fields. */
  readonly error: ApiError | null;
  /** A save is in progress. */
  readonly busy: boolean;
  /** The element is shown for reading only: no field changes and nothing is saved. */
  readonly readonly: boolean;
  /** Sends the body (the whole element to create, the changes to modify). */
  readonly save: (body: object) => void;
  /** Closes the dialog without saving. */
  readonly cancel: () => void;
}

/**
 * Table of one catalog of a group with its create / modify / delete flows: the elements are
 * read from `/v1/groups/{groupId}/{segment}`, creation and modification happen in a dialog whose
 * form is the `#editor` template given as content, deletion asks for confirmation. Whoever cannot
 * write sees the table only. Rejections (`taken`, `default`, `last`, `referenced`, `tooMany`,
 * concurrent change) come back as a message; a concurrent change also reloads the table.
 */
@Component({
  selector: 'fc-catalog-manager',
  imports: [
    ActionsMenu,
    Button,
    ConfirmDialog,
    DataTable,
    Dialog,
    ErrorState,
    NgTemplateOutlet,
    RowActionsTemplate,
    TPipe,
  ],
  templateUrl: './catalog-manager.html',
  styleUrl: './catalog-manager.css',
})
export class CatalogManager<T> {
  private readonly api = inject(CatalogsApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** Group the catalog belongs to. */
  readonly groupId = input.required<string>();
  /** Catalog URL segment. */
  readonly segment = input.required<CatalogSegment>();
  /** Which texts to use. */
  readonly kind = input.required<CatalogKind>();
  /** Columns of the table. */
  readonly columns = input.required<readonly TableColumn<T>[]>();
  /** Identifier of an element in the URLs. */
  readonly idOf = input.required<(row: T) => string>();
  /** Name of an element, for labels and messages. */
  readonly nameOf = input.required<(row: T) => string>();
  /** Whether the user may create, modify and delete (`groups:update`). */
  readonly canWrite = input(false);
  /** Whether elements can be created. */
  readonly allowCreate = input(true);
  /** Whether elements can be deleted. */
  readonly allowDelete = input(true);
  /** How an element is modified: `PUT` replaces it (loyalty-card rules). */
  readonly updateMethod = input<'PATCH' | 'PUT'>('PATCH');
  /** Most elements the catalog may hold, to stop offering "new" when reached. */
  readonly limit = input<number | null>(null);
  /** Elements that cannot be modified or deleted (the standard ones). */
  readonly locked = input<(row: T) => boolean>(() => false);
  /** Elements that can be modified but not deleted (the standard price list). */
  readonly kept = input<(row: T) => boolean>(() => false);

  /** Wider dialog, for long forms. */
  readonly wide = input(false);
  /**
   * Dictionary key of the explanation shown when some elements are read-only for the user (for
   * example elements of stores outside the perimeter of a company or store administrator).
   */
  readonly lockedNote = input<string | null>(null);
  /**
   * Offers "View" on the elements that cannot be modified (`locked`): the same dialog opens for
   * reading only, with the explanation.
   */
  readonly viewable = input(false);

  /** The form of the editor: `<ng-template #editor let-item let-error="error" …>`. */
  protected readonly editor = contentChild.required<TemplateRef<EditorContext<T>>>('editor');

  protected readonly resource = httpResource<ApiData<T[]>>(() =>
    this.api.url(this.groupId(), this.segment()),
  );
  protected readonly rows = computed(() =>
    this.resource.hasValue() ? this.resource.value().data : [],
  );
  protected readonly loadError = computed(() => apiErrorOf(this.resource.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly rowKey = (row: T): string => this.idOf()(row);
  protected readonly atLimit = computed(() => {
    const limit = this.limit();
    return limit !== null && this.rows().length >= limit;
  });
  protected readonly showLockedNote = computed(
    () => this.lockedNote() !== null && this.rows().some((row) => this.locked()(row)),
  );

  protected readonly canCreate = computed(() => this.canWrite() && this.allowCreate());

  // Editor dialog.
  protected readonly editing = signal<T | null>(null);
  protected readonly editorOpen = signal(false);
  protected readonly viewing = signal(false);
  protected readonly saveError = signal<ApiError | null>(null);
  protected readonly saving = signal(false);
  protected readonly context = computed<EditorContext<T>>(() => ({
    $implicit: this.editing(),
    error: this.saveError(),
    busy: this.saving(),
    readonly: this.viewing(),
    save: (body) => void this.save(body),
    cancel: () => this.editorOpen.set(false),
  }));

  // Delete confirmation.
  protected readonly removing = signal<T | null>(null);
  protected readonly removeOpen = signal(false);
  protected readonly removeBusy = signal(false);

  protected text(part: string, params?: Record<string, string | number>): string {
    return this.i18n.t(`CATALOG.${this.kind()}.${part}`, params);
  }

  protected rowLabel(key: string, row: T): string {
    return this.i18n.t(key, { name: this.nameOf()(row) });
  }

  protected canEdit(row: T): boolean {
    return this.canWrite() && !this.locked()(row);
  }

  protected canView(row: T): boolean {
    return this.viewable() && this.locked()(row);
  }

  protected canRemove(row: T): boolean {
    return this.canEdit(row) && this.allowDelete() && !this.kept()(row);
  }

  protected create(): void {
    this.open(null, false);
  }

  protected edit(row: T): void {
    this.open(row, false);
  }

  protected view(row: T): void {
    this.open(row, true);
  }

  private open(row: T | null, viewOnly: boolean): void {
    this.viewing.set(viewOnly);
    this.editing.set(row);
    this.saveError.set(null);
    this.editorOpen.set(true);
  }

  private async save(body: object): Promise<void> {
    const row = this.editing();
    this.saving.set(true);
    this.saveError.set(null);
    try {
      if (row === null) {
        await this.api.create(this.groupId(), this.segment(), body);
      } else if (this.updateMethod() === 'PUT') {
        await this.api.put(this.groupId(), this.segment(), this.idOf()(row), body);
      } else {
        await this.api.patch(this.groupId(), this.segment(), this.idOf()(row), body);
      }
    } catch (error) {
      this.saving.set(false);
      this.failSave(error);
      return;
    }
    this.saving.set(false);
    this.editorOpen.set(false);
    this.toast.success(this.i18n.t(row === null ? 'CATALOG.CREATED' : 'CATALOG.SAVED'));
    this.resource.reload();
  }

  /** The editor shows the error: on the fields when it has details, as a message otherwise. */
  private failSave(error: unknown): void {
    if (error instanceof ApiError) {
      this.saveError.set(error);
      if (error.code === 'CONFLICT' && error.details.length === 0) {
        this.resource.reload();
      }
      return;
    }
    console.error(error);
    this.saveError.set(
      new ApiError({ status: 0, code: 'UNKNOWN_ERROR', message: 'Unexpected error' }),
    );
  }

  protected askRemove(row: T): void {
    this.removing.set(row);
    this.removeOpen.set(true);
  }

  protected async confirmRemove(): Promise<void> {
    const row = this.removing() as T;
    this.removeBusy.set(true);
    try {
      await this.api.remove(this.groupId(), this.segment(), this.idOf()(row));
      this.toast.success(this.i18n.t('CATALOG.DELETED'));
    } catch (error) {
      this.toast.error(catalogFailureMessage(this.i18n, error));
    }
    this.removeBusy.set(false);
    this.removeOpen.set(false);
    this.resource.reload();
  }
}
