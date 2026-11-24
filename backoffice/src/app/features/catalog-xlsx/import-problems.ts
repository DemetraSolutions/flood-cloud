import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiErrorRow } from '../../core/api/api.types';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { saveFile } from '../diagnostics/diagnostics-api';
import { Button } from '../../shared/ui/button/button';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { Select } from '../../shared/ui/select/select';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { problemText } from './catalog-xlsx.types';

/** A problem ready to show: every value is text. */
interface ProblemLine {
  readonly key: string;
  readonly sheet: string;
  readonly row: string;
  readonly column: string;
  readonly text: string;
}

/** Shown for a missing row or column. */
const DASH = '—';

/**
 * The problems of a refused workbook as an accessible table (sheet, row, column, problem), filterable by sheet, with the note for the problems the server did not list and the buttons that copy or save the list as plain text.
 * The sheet, the column and the message come from the file or the server: they are only ever bound as text.
 */
@Component({
  selector: 'fc-import-problems',
  imports: [Button, DataTable, Select, TPipe],
  templateUrl: './import-problems.html',
  styleUrl: './import-problems.css',
})
export class ImportProblems {
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  /** The problems the server listed. */
  readonly rows = input.required<readonly ApiErrorRow[]>();
  /** How many problems the file has, when the server said. */
  readonly errorCount = input<number | null>(null);
  /** Whether there are problems that are not in `rows`. */
  readonly moreErrors = input(false);

  /** The sheet the list is limited to, `''` for all. */
  protected readonly sheet = signal('');

  private readonly lines = computed<ProblemLine[]>(() =>
    this.rows().map((problem, index) => ({
      key: String(index),
      sheet: problem.sheet,
      row: problem.row === null ? DASH : String(problem.row),
      column: problem.column ?? DASH,
      text: problemText(this.i18n, problem),
    })),
  );
  protected readonly sheetOptions = computed(() => [
    { value: '', label: this.i18n.t('CATALOG_XLSX.PROBLEMS.ALL_SHEETS') },
    ...[...new Set(this.rows().map((problem) => problem.sheet))].map((name) => ({
      value: name,
      label: name,
    })),
  ]);
  /** The lines of the chosen sheet; all of them when the sheet is no longer among the problems. */
  protected readonly shown = computed(() => {
    const sheet = this.sheet();
    return this.sheetOptions().some((option) => option.value === sheet) && sheet !== ''
      ? this.lines().filter((line) => line.sheet === sheet)
      : this.lines();
  });
  protected readonly columns = computed<TableColumn<ProblemLine>[]>(() => [
    { key: 'sheet', header: this.i18n.t('CATALOG_XLSX.PROBLEMS.SHEET'), cell: (line) => line.sheet },
    {
      key: 'row',
      header: this.i18n.t('CATALOG_XLSX.PROBLEMS.ROW'),
      align: 'end',
      cell: (line) => line.row,
    },
    { key: 'column', header: this.i18n.t('CATALOG_XLSX.PROBLEMS.COLUMN'), cell: (line) => line.column },
    { key: 'text', header: this.i18n.t('CATALOG_XLSX.PROBLEMS.PROBLEM'), cell: (line) => line.text },
  ]);
  protected readonly rowKey = (line: ProblemLine): string => line.key;
  protected readonly summary = computed(() => {
    const language = this.i18n.language() ?? DEFAULT_LANGUAGE;
    const total = Math.max(this.errorCount() ?? 0, this.rows().length);
    return this.i18n.t(
      total === 1 ? 'CATALOG_XLSX.PROBLEMS.SUMMARY_ONE' : 'CATALOG_XLSX.PROBLEMS.SUMMARY_OTHER',
      { count: formatNumber(total, language) },
    );
  });
  /** "and N more errors not shown": the count of the unlisted ones, or a generic note when the server did not count. */
  protected readonly moreNote = computed(() => {
    const unlisted = (this.errorCount() ?? 0) - this.rows().length;
    return unlisted > 0
      ? this.i18n.t('CATALOG_XLSX.PROBLEMS.MORE', {
          count: formatNumber(unlisted, this.i18n.language() ?? DEFAULT_LANGUAGE),
        })
      : this.i18n.t('CATALOG_XLSX.PROBLEMS.MORE_UNKNOWN');
  });

  /** The list as plain text: one line per problem, the fields separated by tabs, under a header line. */
  private asText(): string {
    const header = ['SHEET', 'ROW', 'COLUMN', 'PROBLEM']
      .map((part) => this.i18n.t(`CATALOG_XLSX.PROBLEMS.${part}`))
      .join('\t');
    const body = this.shown().map((line) => [line.sheet, line.row, line.column, line.text].join('\t'));
    return [header, ...body, ...(this.moreErrors() ? [this.moreNote()] : [])].join('\n');
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.asText());
      this.toast.success(this.i18n.t('CATALOG_XLSX.PROBLEMS.COPIED'));
    } catch {
      this.toast.error(this.i18n.t('CATALOG_XLSX.PROBLEMS.COPY_FAILED'));
    }
  }

  protected save(): void {
    saveFile(new Blob([this.asText()], { type: 'text/plain;charset=utf-8' }), 'catalog-import-problems.txt');
  }
}
