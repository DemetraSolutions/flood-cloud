import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate, formatMoney, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { abbreviateId } from '../activity-log/activity-log.types';
import { contactRoute } from '../contacts/contact.types';
import { RecordGroup } from '../groups/record-group';
import { SaleNames } from './sale-names';
import {
  badgeText,
  receiptLabel,
  SaleBadge,
  saleBadges,
  SaleDetail,
  SalePayments,
  SaleProduct,
  SaleRefund,
  SaleTotals,
} from './sale.types';

/** A line of the sale with the key the table tracks it by (lines have no identity of their own). */
type Keyed<T> = T & { readonly key: string };

/**
 * The content of the page of a sale (presentation only): its kind and number, date and time,
 * fiscal state, company, store, cash desk, operator, table (only for a group with the `rooms`
 * function) and customer (a link for whoever reads the contacts), the lines of the products (at
 * most 500, with a note when the sale has more), the totals, the payments and the refunds.
 * Amounts are in the given currency; a company or store whose name is not known shows its short id.
 */
@Component({
  selector: 'fc-sale-view',
  imports: [Button, CellTemplate, DataTable, PageHeader, RecordGroup, RouterLink, StatusBadge, TPipe],
  templateUrl: './sale-view.html',
  styleUrl: './sale-view.css',
})
export class SaleView {
  private readonly i18n = inject(I18nService);
  private readonly session = inject(SessionService);
  private readonly features = inject(GroupFeatures);

  readonly groupId = input.required<string>();
  readonly sale = input.required<SaleDetail>();
  /** Currency of the amounts. */
  readonly currency = input.required<string>();
  /** Names of the companies and stores, `null` while they are read. */
  readonly names = input.required<SaleNames | null>();
  /** The user asked to go back. */
  readonly back = output<void>();

  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);
  protected readonly hasRooms = computed(() => this.features.enabledFor(this.groupId(), 'rooms'));
  protected readonly canReadContacts = computed(() => this.session.can('contacts:read'));

  protected readonly heading = computed(() => this.numberText(this.sale().number));
  protected readonly badges = computed<SaleBadge[]>(() => saleBadges(this.sale()));
  protected readonly type = computed(() =>
    this.i18n.t(`SALES.TYPE.${this.sale().receiptType?.toUpperCase() ?? 'UNKNOWN'}`),
  );
  protected readonly dateText = computed(() => this.dateTime(this.sale().date));
  protected readonly company = computed(() => this.nameOf('companies', this.sale().companyId));
  protected readonly place = computed(() => this.nameOf('places', this.sale().placeId));
  protected readonly customerRoute = computed(() => {
    const customer = this.sale().customer;
    return customer === null || !this.canReadContacts() ? null : contactRoute(this.groupId(), customer.id);
  });
  protected readonly receiptDate = computed(() => this.dateTime(this.sale().fiscalReceiptInfo?.date ?? null));
  protected readonly receiptNumber = computed(() => receiptLabel(this.sale().fiscalReceiptInfo));
  protected readonly truncated = computed(() => this.sale().productsCount > this.sale().products.length);
  protected readonly paid = computed(() => this.paymentRows(this.sale().payments));
  protected readonly totals = computed(() => this.totalRows(this.sale().totals));

  /**
   * The payments the sale has (the ones that are zero are left out).
   *
   * @param payments The payments of the sale.
   */
  protected paymentRows(payments: SalePayments): { key: string; label: string; value: string }[] {
    return (['cash', 'electronic', 'cheque', 'tickets', 'fidelityCredit', 'unpaid'] as const)
      .filter((key) => payments[key] !== 0)
      .map((key) => ({ key, label: this.i18n.t(`SALES.PAYMENT.${key.toUpperCase()}`), value: this.money(payments[key]) }));
  }

  /**
   * The totals; the discount or surcharge of the whole sale only when there is one.
   *
   * @param totals The totals of the sale.
   */
  protected totalRows(totals: SaleTotals): { key: string; label: string; value: string }[] {
    const rows = [
      { key: 'total', label: this.i18n.t('SALES.TOTALS.TOTAL'), value: this.money(totals.total) },
      { key: 'taxable', label: this.i18n.t('SALES.TOTALS.TAXABLE'), value: this.money(totals.taxable) },
      { key: 'tax', label: this.i18n.t('SALES.TOTALS.TAX'), value: this.money(totals.tax) },
    ];
    const { adjustment, percentage, value } = totals.discount;
    if (adjustment !== null) {
      const percent = percentage > 0 ? ` (${formatNumber(percentage / 100, this.language(), { style: 'percent', maximumFractionDigits: 2 })})` : '';
      rows.push({
        key: 'adjustment',
        label: this.i18n.t(adjustment === 'discount' ? 'SALES.TOTALS.DISCOUNT' : 'SALES.TOTALS.SURCHARGE'),
        value: `${this.money(value)}${percent}`,
      });
    }
    return rows;
  }

  protected readonly lines = computed<Keyed<SaleProduct>[]>(() =>
    this.sale().products.map((product, index) => ({ ...product, key: String(index) })),
  );
  protected readonly refunds = computed<Keyed<SaleRefund>[]>(() =>
    this.sale().refunds.map((refund, index) => ({ ...refund, key: String(index) })),
  );

  protected readonly productColumns = computed<TableColumn<Keyed<SaleProduct>>[]>(() => {
    const col = (key: string) => this.i18n.t(`SALES.PRODUCT.${key}`);
    return [
      { key: 'code', header: col('CODE'), hideNarrow: true, cell: (row) => row.code ?? '' },
      { key: 'name', header: col('NAME') },
      { key: 'quantity', header: col('QUANTITY'), align: 'end', cell: (row) => formatNumber(row.quantity, this.language(), { maximumFractionDigits: 3 }) },
      { key: 'unitPrice', header: col('UNIT_PRICE'), align: 'end', cell: (row) => this.money(row.unitPrice) },
      {
        key: 'discount',
        header: col('DISCOUNT'),
        align: 'end',
        hideNarrow: true,
        cell: (row) => (row.discount === 0 ? '' : formatNumber(row.discount / 100, this.language(), { style: 'percent', maximumFractionDigits: 2 })),
      },
    ];
  });
  protected readonly rowKey = (row: { readonly key: string }): string => row.key;

  protected readonly refundColumns = computed<TableColumn<Keyed<SaleRefund>>[]>(() => {
    const col = (key: string) => this.i18n.t(`SALES.REFUND.${key}`);
    return [
      { key: 'number', header: col('NUMBER'), cell: (row) => this.numberText(row) },
      {
        key: 'date',
        header: col('DATE'),
        cell: (row) => (row.date === null ? '' : formatDate(row.date, this.language(), { dateStyle: 'medium', timeStyle: 'short' })),
      },
      { key: 'amount', header: col('AMOUNT'), align: 'end', cell: (row) => this.money(row.amount) },
    ];
  });

  protected badgeLabel(badge: SaleBadge): string {
    return badgeText((key, params) => this.i18n.t(key, params), badge);
  }

  /** `report-number`, or a text for a receipt without numbers. */
  protected numberText(value: Parameters<typeof receiptLabel>[0]): string {
    return receiptLabel(value) || this.i18n.t('SALES.NO_NUMBER');
  }

  private dateTime(date: string | null): string {
    return date === null ? '' : formatDate(date, this.language(), { dateStyle: 'medium', timeStyle: 'short' });
  }

  private money(value: number): string {
    return formatMoney(Math.round(value * 100), this.currency(), this.language());
  }

  /** The name of a company or store, its short id when it is not among the known names, `''` while they are read. */
  private nameOf(kind: keyof SaleNames, id: string | null): string {
    const names = this.names();
    if (id === null || names === null) {
      return '';
    }
    return names[kind][id] ?? abbreviateId(id);
  }
}
