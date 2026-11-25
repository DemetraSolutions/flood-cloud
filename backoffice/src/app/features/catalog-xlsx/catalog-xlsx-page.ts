import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Can } from '../../core/auth/can';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { saveFile } from '../diagnostics/diagnostics-api';
import { checkWorkbook, FileProblem, MAX_IMPORT_BYTES } from '../tobaccos/tobaccos.types';
import { CatalogXlsxApi } from './catalog-xlsx-api';
import { downloadFailureMessage, importFailure, ImportFailure } from './catalog-xlsx-errors';
import {
  ExportReferences,
  ImportOutcome,
  SheetCounts,
  sheetCounts,
  totalCounts,
} from './catalog-xlsx.types';
import { ImportProblems } from './import-problems';
import { XLSX_TOOLS, XlsxToolKey } from './xlsx-tools';

/** Dictionary keys of the messages about a file that cannot be sent. */
const FILE_PROBLEM_KEYS: Readonly<Record<FileProblem, string>> = {
  type: 'CATALOG_XLSX.IMPORT.CLIENT_ERROR.TYPE',
  size: 'CATALOG_XLSX.IMPORT.CLIENT_ERROR.SIZE',
  empty: 'CATALOG_XLSX.IMPORT.CLIENT_ERROR.EMPTY',
};

/** One line of the table of the counts. */
interface CountLine {
  readonly key: string;
  readonly counts: SheetCounts;
}

/** The counts of a sheet, in the order of the columns of the table. */
const COUNT_FIELDS = ['inserted', 'updated', 'removed', 'unchanged'] as const;

/** Today as `YYYY-MM-DD`. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Import / Export of the working group (`/groups/:groupId/tools/<route>`): the model of the XLSX file, the export (ids or names in the columns that accept both) and the all-or-nothing import, which is first
 * checked (`dryRun`) and applied only after a successful check and an explicit confirmation that repeats the counts. A file with problems is shown as a table of sheet, row, column and problem.
 * One page serves the catalog (C6), the contacts and the advanced loyalty cards (K3): the route says which with its `tool` data (`xlsx-tools.ts`), which also names the permission of the import part.
 */
@Component({
  selector: 'fc-catalog-xlsx-page',
  imports: [Button, Can, ConfirmDialog, DataTable, ImportProblems, RouterLink, TPipe],
  templateUrl: './catalog-xlsx-page.html',
  styleUrl: './catalog-xlsx-page.css',
})
export class CatalogXlsxPage {
  private readonly api = inject(CatalogXlsxApi);
  private readonly store = inject(ReferenceStore);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** Route parameter (bound by the router). */
  readonly groupId = input.required<string>();
  /** Which workbook the page is about: the `tool` data of the route (the catalog without it; the router sets an unbound input to `undefined`, so a default value would not hold). */
  readonly tool = input<XlsxToolKey>();

  protected readonly spec = computed(() => XLSX_TOOLS[this.tool() ?? 'catalog']);
  protected readonly maxMegabytes = MAX_IMPORT_BYTES / (1024 * 1024);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Bumped when an answer arrives: the heading of what the last action produced (`data-outcome`) takes the focus. */
  private readonly focusRequests = signal(0);

  // The downloads.
  /** What is being downloaded; one download at a time. */
  protected readonly downloading = signal<'template' | 'export' | null>(null);
  protected readonly downloadError = signal<string | null>(null);
  protected readonly references = signal<ExportReferences>('ids');

  // The import.
  protected readonly file = signal<File | null>(null);
  /** Message about a file that was refused before being sent, `null` when none. */
  protected readonly pickError = signal<string | null>(null);
  protected readonly working = signal<'verify' | 'import' | null>(null);
  /** The counts of the successful check of the chosen file; the import is offered only while it holds. */
  protected readonly verified = signal<ImportOutcome | null>(null);
  /** The counts of the last import that was applied. */
  protected readonly done = signal<ImportOutcome | null>(null);
  protected readonly failure = signal<ImportFailure | null>(null);
  protected readonly confirmOpen = signal(false);
  /** The `Idempotency-Key` of the import of the verified file: the same on every retry of it. */
  private importKey = '';

  protected readonly busy = computed(() => this.downloading() !== null || this.working() !== null);
  /** The name and the size of the chosen file; read only while a file is chosen. */
  protected readonly fileLabel = computed(() => {
    const file = this.file() as File;
    return this.i18n.t('CATALOG_XLSX.IMPORT.FILE', {
      name: file.name,
      size: formatNumber(
        Math.max(1, Math.round(file.size / 1024)),
        this.i18n.language() ?? DEFAULT_LANGUAGE,
      ),
    });
  });
  /** Whether the checked file changes anything; read only while a check is shown. */
  protected readonly hasChanges = computed(() => {
    const { inserted, updated, removed } = totalCounts(this.verified() as ImportOutcome);
    return inserted + updated + removed > 0;
  });
  protected readonly statusMessage = computed(() => {
    if (this.downloading() !== null) {
      return this.i18n.t('CATALOG_XLSX.DOWNLOADING');
    }
    switch (this.working()) {
      case 'verify':
        return this.i18n.t('CATALOG_XLSX.IMPORT.VERIFYING');
      case 'import':
        return this.i18n.t('CATALOG_XLSX.IMPORT.IMPORTING');
      default:
        return '';
    }
  });
  protected readonly countColumns = computed<TableColumn<CountLine>[]>(() => [
    {
      key: 'sheet',
      header: this.i18n.t('CATALOG_XLSX.COUNTS.SHEET'),
      cell: (line) => this.i18n.t(`${this.spec().prefix}.SHEET.${line.key.toUpperCase()}`),
    },
    ...COUNT_FIELDS.filter((field) => field !== 'removed' || this.spec().showsRemoved).map((field) => ({
      key: field,
      header: this.i18n.t(`CATALOG_XLSX.COUNTS.${field.toUpperCase()}`),
      align: 'end' as const,
      cell: (line: CountLine) => this.number(line.counts[field]),
    })),
  ]);
  protected readonly countRowKey = (line: CountLine): string => line.key;
  /** The counts of the check and of the import, as lines of a table; read only while shown. */
  protected readonly verifiedLines = computed<CountLine[]>(() =>
    sheetCounts(this.verified() as ImportOutcome, this.spec().sheets),
  );
  protected readonly doneLines = computed<CountLine[]>(() =>
    sheetCounts(this.done() as ImportOutcome, this.spec().sheets),
  );
  protected readonly confirmMessage = computed(() => {
    const outcome = this.verified();
    if (outcome === null) {
      return '';
    }
    const total = totalCounts(outcome);
    return this.i18n.t(`${this.spec().prefix}.IMPORT.CONFIRM`, {
      name: (this.file() as File).name,
      inserted: this.number(total.inserted),
      updated: this.number(total.updated),
      removed: this.number(total.removed),
    });
  });

  constructor() {
    afterRenderEffect(() => {
      if (this.focusRequests() > 0) {
        this.host.nativeElement.querySelector<HTMLElement>('[data-outcome]')?.focus();
      }
    });
  }

  protected setReferences(value: ExportReferences): void {
    this.references.set(value);
  }

  protected async downloadTemplate(): Promise<void> {
    const tool = this.spec();
    await this.download(
      'template',
      () => this.api.template(this.groupId(), tool),
      `${tool.fileBase}-model.xlsx`,
    );
  }

  protected async downloadExport(): Promise<void> {
    const references = this.references();
    const tool = this.spec();
    await this.download(
      'export',
      () => this.api.export(this.groupId(), references, tool),
      `${tool.fileBase}_${today()}.xlsx`,
    );
  }

  /** A file was chosen: it is checked here for convenience only; a different file always needs a new check. */
  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    // Cleared so that choosing the same file again fires the event again.
    input.value = '';
    if (chosen === null) {
      return;
    }
    this.verified.set(null);
    this.done.set(null);
    this.failure.set(null);
    const problem = checkWorkbook(chosen);
    this.pickError.set(problem === null ? null : this.i18n.t(FILE_PROBLEM_KEYS[problem]));
    this.file.set(problem === null ? chosen : null);
  }

  /** Sends the file with `dryRun`: nothing is written, the answer is what the import would do or what is wrong. */
  protected async verify(): Promise<void> {
    const file = this.file() as File;
    this.working.set('verify');
    this.verified.set(null);
    this.done.set(null);
    this.failure.set(null);
    try {
      this.verified.set(await this.api.import(this.groupId(), file, crypto.randomUUID(), true, this.spec()));
      this.importKey = crypto.randomUUID();
    } catch (error) {
      this.failure.set(importFailure(this.i18n, error, this.spec().prefix));
    } finally {
      this.working.set(null);
      this.focusRequests.update((count) => count + 1);
    }
  }

  /** The confirmation was closed without confirming. */
  protected onConfirmClosed(): void {
    this.confirmOpen.set(false);
  }

  /** Applies the verified file (all or nothing), then drops the cached catalog lists. */
  protected async applyImport(): Promise<void> {
    const file = this.file() as File;
    this.working.set('import');
    this.failure.set(null);
    try {
      const outcome = await this.api.import(
        this.groupId(),
        file,
        this.importKey,
        false,
        this.spec(),
      );
      this.done.set(outcome);
      this.verified.set(null);
      this.file.set(null);
      for (const kind of this.spec().invalidates) {
        this.store.invalidate(this.groupId(), kind);
      }
      this.toast.success(this.i18n.t('CATALOG_XLSX.IMPORT.DONE'));
    } catch (error) {
      const failure = importFailure(this.i18n, error, this.spec().prefix);
      this.failure.set(failure);
      if (failure.refused) {
        // The catalog changed since the check, or the file is refused now: it has to be checked again.
        this.verified.set(null);
      }
    } finally {
      this.working.set(null);
      this.confirmOpen.set(false);
      this.focusRequests.update((count) => count + 1);
    }
  }

  private async download(
    kind: 'template' | 'export',
    run: () => Promise<Blob>,
    filename: string,
  ): Promise<void> {
    this.downloading.set(kind);
    this.downloadError.set(null);
    try {
      saveFile(await run(), filename);
    } catch (error) {
      this.downloadError.set(downloadFailureMessage(this.i18n, error, this.spec().prefix));
    } finally {
      this.downloading.set(null);
    }
  }

  private number(value: number): string {
    return formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }
}
