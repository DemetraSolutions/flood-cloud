import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { Country } from '../../core/reference/countries';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../profile/sessions';
import { CountriesApi } from './countries-api';
import { CountryArea, CountryBody, countryRoute, VersionedCountry } from './countries.types';
import { CountryEditor } from './country-editor';
import { countryNotice, CountryNotice, isFieldFailure } from './country-errors';

/** What the editor dialog is doing. */
type EditorMode =
  { kind: 'rename' } | { kind: 'new-area' } | { kind: 'rename-area'; area: CountryArea };

/** What the confirmation dialog is asking to delete. */
type Deletion = { kind: 'country' } | { kind: 'area'; area: CountryArea };

/**
 * One country (`/settings/countries/:countryCode`, platform administrators): the code (read
 * only), the name (editable) and the provinces, each with its code (read only) and its name
 * (editable); provinces can be added and deleted, and so can the country. Every write presents
 * the version of the country in `If-Match` and resolves with the new one. A stale version (`412`)
 * asks to reload; a deletion refused because companies or places use the item says how many.
 */
@Component({
  selector: 'fc-country-page',
  imports: [
    Button,
    ConfirmDialog,
    CountryEditor,
    DataTable,
    Dialog,
    ErrorState,
    RouterLink,
    RowActionsTemplate,
    TPipe,
  ],
  templateUrl: './country-page.html',
  styleUrl: './country-page.css',
})
export class CountryPage {
  private readonly api = inject(CountriesApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** Route parameter (bound by the router). */
  readonly countryCode = input.required<string>();

  private readonly loaded = resource({
    params: () => this.countryCode(),
    loader: ({ params }) => this.api.read(params),
  });
  /** The country as the server has it, and its version; replaced by every write. */
  private readonly saved = linkedSignal<VersionedCountry | undefined, VersionedCountry | null>({
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly country = computed(() => this.saved()?.country ?? null);
  protected readonly loading = computed(() => this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  // Read only by the template of a loaded country.
  protected readonly areas = computed(() =>
    [...(this.country() as Country).areas].sort((a, b) => a.name.localeCompare(b.name, 'it')),
  );
  protected readonly columns = computed<TableColumn<CountryArea>[]>(() => [
    {
      key: 'code',
      header: this.i18n.t('COUNTRIES.COLUMN.CODE'),
      cell: (row) => row.code,
      narrow: true,
    },
    { key: 'name', header: this.i18n.t('COUNTRIES.COLUMN.NAME'), cell: (row) => row.name },
  ]);
  protected readonly rowKey = (row: CountryArea): string => row.code;
  protected readonly listRoute = countryRoute();

  protected readonly notice = signal<CountryNotice | null>(null);

  // Editor dialog.
  protected readonly mode = signal<EditorMode | null>(null);
  protected readonly editorOpen = computed(() => this.mode() !== null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<ApiError | null>(null);
  protected readonly editorItem = computed(() => {
    const mode = this.mode();
    if (mode?.kind === 'rename') {
      return this.country();
    }
    return mode?.kind === 'rename-area' ? mode.area : null;
  });
  protected readonly editorHeading = computed(() => {
    const mode = this.mode();
    return this.i18n.t(
      mode?.kind === 'rename'
        ? 'COUNTRIES.RENAME_TITLE'
        : mode?.kind === 'rename-area'
          ? 'COUNTRIES.AREAS.RENAME_TITLE'
          : 'COUNTRIES.AREAS.NEW_TITLE',
    );
  });

  // Delete confirmation.
  protected readonly deleting = signal<Deletion | null>(null);
  protected readonly deleteOpen = signal(false);
  protected readonly deleteBusy = signal(false);
  protected readonly deleteMessage = computed(() => {
    const target = this.deleting();
    return target?.kind === 'area'
      ? this.i18n.t('COUNTRIES.AREAS.DELETE_CONFIRM', { name: target.area.name })
      : this.i18n.t('COUNTRIES.DELETE_CONFIRM', { name: this.country()?.name ?? '' });
  });

  protected areaLabel(key: string, area: CountryArea): string {
    return this.i18n.t(key, { name: area.name });
  }

  protected reload(): void {
    this.notice.set(null);
    this.loaded.reload();
  }

  protected open(mode: EditorMode): void {
    this.saveError.set(null);
    this.notice.set(null);
    this.mode.set(mode);
  }

  protected close(): void {
    this.mode.set(null);
  }

  protected async save(body: CountryBody): Promise<void> {
    const mode = this.mode() as EditorMode;
    const { country, etag } = this.saved() as VersionedCountry;
    this.saving.set(true);
    this.saveError.set(null);
    let result: VersionedCountry;
    try {
      result =
        mode.kind === 'rename'
          ? await this.api.rename(country.code, body.name as string, etag)
          : mode.kind === 'new-area'
            ? await this.api.addArea(country.code, body, etag)
            : await this.api.renameArea(country.code, mode.area.code, body.name as string, etag);
    } catch (error) {
      this.saving.set(false);
      if (isFieldFailure(error)) {
        this.saveError.set(error);
      } else {
        this.mode.set(null);
        this.notice.set(countryNotice(this.i18n, error, 'AREA'));
      }
      return;
    }
    this.saving.set(false);
    this.saved.set(result);
    this.mode.set(null);
    this.toast.success(
      this.i18n.t(mode.kind === 'new-area' ? 'COUNTRIES.AREAS.CREATED' : 'COUNTRIES.SAVED'),
    );
  }

  protected askDelete(target: Deletion): void {
    this.notice.set(null);
    this.deleting.set(target);
    this.deleteOpen.set(true);
  }

  protected async confirmDelete(): Promise<void> {
    const target = this.deleting() as Deletion;
    const { country, etag } = this.saved() as VersionedCountry;
    this.deleteBusy.set(true);
    try {
      if (target.kind === 'country') {
        await this.api.remove(country.code, etag);
        this.toast.success(this.i18n.t('COUNTRIES.DELETED', { name: country.name }));
        this.deleteOpen.set(false);
        await this.router.navigate(countryRoute());
        return;
      }
      this.saved.set(await this.api.removeArea(country.code, target.area.code, etag));
      this.toast.success(this.i18n.t('COUNTRIES.AREAS.DELETED', { name: target.area.name }));
    } catch (error) {
      this.notice.set(
        countryNotice(this.i18n, error, target.kind === 'country' ? 'COUNTRY' : 'AREA'),
      );
    } finally {
      this.deleteBusy.set(false);
      this.deleteOpen.set(false);
    }
  }
}
