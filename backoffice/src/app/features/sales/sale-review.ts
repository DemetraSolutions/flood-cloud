import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { BadgeTone, StatusBadge } from '../../shared/ui/status-badge/status-badge';
import {
  anomalyLabel,
  anomalySourceLabel,
  checkFieldLabel,
  checkLineLabel,
  dateTimeText,
  moneyText,
  operationLabel,
  sendStatusLabel,
  sendStatusTone,
} from './sale-labels';
import { invoiceNotQueued, SaleAnomaly, SaleDetail, SaleOperation } from './sale.types';

/** A row of a table of the review with the key the table tracks it by. */
type Keyed<T> = T & { readonly key: string };

/** A row of the check: the label and the amounts already formatted (`null`: the amount is not available). */
interface CheckRow {
  readonly key: string;
  readonly label: string;
  /** What differs in a line (`''` for a total). */
  readonly difference: string;
  /** What the cash desk sent. */
  readonly pos: string | null;
  /** What the system worked out. */
  readonly server: string | null;
  /** The difference between the two, `null` when one of them is not available. */
  readonly delta: string | null;
}

/** The check of the server as the page shows it. */
interface CheckView {
  readonly tone: BadgeTone;
  /** Dictionary key of the state. */
  readonly state: string;
  readonly checkedAt: string;
  readonly totals: CheckRow[];
  readonly lines: CheckRow[];
  /** The sale has more differences of lines than the ones listed. */
  readonly linesTruncated: boolean;
}

/**
 * The read-only part of the page of a sale that comes from the server: the check it made when the
 * sale was written (it worked the sale out again and compared it with what the cash desk sent:
 * state and differences of totals and lines, with what the cash desk sent, what the system worked
 * out and the gap; an amount that is not available is a dash with a hidden "not available"), the
 * anomalies it recorded (always shown: a label for every code and source, or a line that says none
 * were recorded), the invoice (number with series and year, state of the sending, "not sent" in a
 * warning, the missing document) and the operations of the backend on the sale. The ids of the
 * sections (`sale-check`, `sale-anomalies`, `sale-invoice`) are where the header of the page leads.
 * Amounts are in the given currency (the amounts of the check are in the units of the sale, the
 * currency of the group).
 */
@Component({
  selector: 'fc-sale-review',
  imports: [CellTemplate, DataTable, NgTemplateOutlet, StatusBadge, TPipe],
  templateUrl: './sale-review.html',
  styleUrl: './sale-review.css',
})
export class SaleReview {
  private readonly i18n = inject(I18nService);

  readonly sale = input.required<SaleDetail>();
  /** Currency of the amounts. */
  readonly currency = input.required<string>();

  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);

  protected readonly check = computed<CheckView | null>(() => {
    const check = this.sale().serverCheck;
    if (check === null) {
      return null;
    }
    const row = (key: string, label: string, difference: string, pos: number | null, server: number | null): CheckRow => ({
      key,
      label,
      difference,
      pos: this.amount(pos),
      server: this.amount(server),
      delta: pos === null || server === null ? null : this.amount(pos - server),
    });
    return {
      tone: check.status === 'ok' ? 'success' : check.status === 'differences' ? 'warning' : 'neutral',
      state: `SALES.CHECK.STATE_${(check.status ?? 'unknown').toUpperCase()}`,
      checkedAt: this.dateTime(check.checkedAt),
      totals: check.totals.map((total, index) =>
        row(String(index), checkFieldLabel(this.t, total.field), '', total.pos, total.server),
      ),
      lines: check.lines.map((line, index) =>
        row(String(index), this.lineName(line.index), checkLineLabel(this.t, line.code), line.pos, line.server),
      ),
      linesTruncated: check.linesTruncated,
    };
  });
  protected readonly anomalies = computed<Keyed<SaleAnomaly>[]>(() =>
    this.sale().anomalies.map((row, index) => ({ ...row, key: String(index) })),
  );
  protected readonly operations = computed<Keyed<SaleOperation>[]>(() =>
    this.sale().operations.map((row, index) => ({ ...row, key: String(index) })),
  );

  protected readonly invoice = computed(() => this.sale().invoice);
  /** The invoice goes through a hub and its sending did not start: the server says it, or the state of the document does. */
  protected readonly notQueued = computed(() => invoiceNotQueued(this.invoice()));
  protected readonly invoiceNumber = computed(() => {
    const invoice = this.invoice();
    if (invoice === null || invoice.number === null) {
      return '';
    }
    const parts = [this.i18n.t('SALES.INVOICE.NUMBER_OF', { number: invoice.number })];
    if (invoice.prefixSuffix !== null && invoice.prefixSuffix !== '') {
      parts.push(this.i18n.t('SALES.INVOICE.SERIES_OF', { series: invoice.prefixSuffix }));
    }
    if (invoice.year !== null) {
      parts.push(this.i18n.t('SALES.INVOICE.YEAR_OF', { year: invoice.year }));
    }
    return parts.join(', ');
  });
  /** The state of sending to show when the invoice is in the queue or has moved on; `null` for no sending and for "not sent", which has its own badge. */
  protected readonly sendStatus = computed(() => {
    const status = this.invoice()?.sendStatus ?? null;
    return status === null || this.notQueued()
      ? null
      : { text: sendStatusLabel(this.t, status), tone: sendStatusTone(status) };
  });
  protected readonly invoiceHasNoSending = computed(
    () => this.invoice() !== null && !this.notQueued() && this.sendStatus() === null,
  );

  protected readonly totalColumns = computed<TableColumn<CheckRow>[]>(() => [
    { key: 'label', header: this.text('SALES.CHECK.FIELD'), cell: (row) => row.label },
    ...this.amountColumns(),
    { key: 'delta', header: this.text('SALES.CHECK.DELTA'), align: 'end' },
  ]);
  protected readonly lineColumns = computed<TableColumn<CheckRow>[]>(() => [
    { key: 'label', header: this.text('SALES.CHECK.LINE'), cell: (row) => row.label },
    { key: 'difference', header: this.text('SALES.CHECK.DIFFERENCE'), cell: (row) => row.difference },
    ...this.amountColumns(),
  ]);
  protected readonly anomalyColumns = computed<TableColumn<Keyed<SaleAnomaly>>[]>(() => [
    { key: 'at', header: this.text('SALES.ANOMALIES.DATE'), hideNarrow: true, cell: (row) => this.dateTime(row.at) },
    { key: 'code', header: this.text('SALES.ANOMALIES.ANOMALY'), cell: (row) => anomalyLabel(this.t, row.code) },
    { key: 'source', header: this.text('SALES.ANOMALIES.SOURCE'), cell: (row) => anomalySourceLabel(this.t, row.source) },
    { key: 'operation', header: this.text('SALES.ANOMALIES.OPERATION'), hideNarrow: true, cell: (row) => operationLabel(this.t, row.operation) },
    { key: 'detail', header: this.text('SALES.ANOMALIES.DETAIL'), cell: (row) => this.anomalyDetail(row) },
  ]);
  protected readonly operationColumns = computed<TableColumn<Keyed<SaleOperation>>[]>(() => [
    { key: 'kind', header: this.text('SALES.OPERATIONS.KIND'), cell: (row) => operationLabel(this.t, row.kind) },
    { key: 'at', header: this.text('SALES.OPERATIONS.DATE'), cell: (row) => this.dateTime(row.at) },
  ]);
  /** What stands for an amount that is not available. */
  protected readonly dash = '—';
  protected readonly rowKey = (row: { readonly key: string }): string => row.key;

  private readonly t = (key: string, params?: Readonly<Record<string, string | number>>): string =>
    this.i18n.t(key, params);

  private text(key: string): string {
    return this.i18n.t(key);
  }

  /** The columns of the amounts of a table of the check: what the cash desk sent and what the system worked out. */
  private amountColumns(): TableColumn<CheckRow>[] {
    return [
      { key: 'pos', header: this.text('SALES.CHECK.POS'), align: 'end' },
      { key: 'server', header: this.text('SALES.CHECK.SERVER'), align: 'end' },
    ];
  }

  /** The name of the line of a position, `#n` followed by the name or the code when the line is among the shown ones. */
  private lineName(index: number): string {
    const product = this.sale().products.find((line) => line.index === index);
    const name = product?.name ?? product?.code ?? '';
    return name === '' ? `#${index + 1}` : `#${index + 1} ${name}`;
  }

  /** What an anomaly adds to its label: the number of the sales a deferred invoice could not gather and the fields out of their domain. */
  private anomalyDetail(row: SaleAnomaly): string {
    const parts: string[] = [];
    if (row.ids.length > 0) {
      parts.push(this.i18n.t('SALES.ANOMALIES.SALES', { count: row.ids.length }));
    }
    if (row.fields.length > 0) {
      parts.push(this.i18n.t('SALES.ANOMALIES.FIELDS', { fields: row.fields.join(', ') }));
    }
    return parts.join('; ');
  }

  /** An amount formatted, `null` when it is not available. */
  private amount(value: number | null): string | null {
    return value === null ? null : moneyText(this.language(), this.currency(), value);
  }

  private dateTime(date: string | null): string {
    return dateTimeText(this.language(), date);
  }
}
