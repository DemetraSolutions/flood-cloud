import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Countries, Country } from '../../core/reference/countries';
import { Button } from '../../shared/ui/button/button';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { CountriesApi } from './countries-api';
import { CountryBody, countryRoute } from './countries.types';
import { isFieldFailure } from './country-errors';
import { CountryEditor } from './country-editor';

/** Lower case, without accents, to compare what the user typed with a name. */
function plain(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Countries (`/settings/countries`, platform administrators): the whole list, small enough to
 * be searched in the browser by code or name, and "New country" in a dialog. A row opens the
 * country with its provinces. The list is the shared {@link Countries} reference, so a write
 * anywhere updates every select that uses it.
 */
@Component({
  selector: 'fc-countries-page',
  imports: [
    Button,
    CellTemplate,
    CountryEditor,
    DataTable,
    Dialog,
    ErrorState,
    RouterLink,
    TextField,
    TPipe,
  ],
  templateUrl: './countries-page.html',
  styleUrl: './countries-page.css',
})
export class CountriesPage {
  private readonly countries = inject(Countries);
  private readonly api = inject(CountriesApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly search = signal('');
  protected readonly loading = this.countries.loading;
  protected readonly failed = this.countries.failed;
  protected readonly rows = computed(() => {
    const text = plain(this.search().trim());
    return this.countries
      .list()
      .filter((country) => plain(`${country.code} ${country.name}`).includes(text))
      .sort((a, b) => a.name.localeCompare(b.name, 'it'));
  });
  protected readonly columns = computed<TableColumn<Country>[]>(() => [
    {
      key: 'code',
      header: this.i18n.t('COUNTRIES.COLUMN.CODE'),
      cell: (row) => row.code,
      narrow: true,
    },
    { key: 'name', header: this.i18n.t('COUNTRIES.COLUMN.NAME') },
    {
      key: 'areas',
      header: this.i18n.t('COUNTRIES.COLUMN.AREAS'),
      align: 'end',
      cell: (row) => String(row.areas.length),
    },
  ]);
  protected readonly rowKey = (row: Country): string => row.code;

  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly saveError = signal<ApiError | null>(null);
  protected readonly failure = signal<string | null>(null);

  constructor() {
    this.countries.need();
  }

  protected detail(row: Country): string[] {
    return countryRoute(row.code);
  }

  protected reload(): void {
    this.countries.invalidate();
  }

  protected openNew(): void {
    this.saveError.set(null);
    this.failure.set(null);
    this.creating.set(true);
  }

  protected async create(body: CountryBody): Promise<void> {
    this.busy.set(true);
    this.saveError.set(null);
    try {
      const { country } = await this.api.create(body);
      this.creating.set(false);
      this.toast.success(this.i18n.t('COUNTRIES.CREATED', { name: country.name }));
      await this.router.navigate(countryRoute(country.code));
    } catch (error) {
      if (isFieldFailure(error)) {
        this.saveError.set(error);
      } else {
        this.creating.set(false);
        this.failure.set(failureMessage(this.i18n, error));
      }
    } finally {
      this.busy.set(false);
    }
  }
}
