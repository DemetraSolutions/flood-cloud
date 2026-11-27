import { Component, computed, effect, ElementRef, inject, Injector, input, model, output, signal, untracked } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { SessionService } from '../../core/session/session.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Icon } from '../../shared/ui/icon/icon';
import { TextField } from '../../shared/ui/text-field/text-field';
import { SaleActionRun } from './sale-action-run';
import { focusFirstProblem, saleDialogText } from './sale-dialog-support';
import { SaleApi } from './sale-api';
import {
  chosenLines,
  emptyRefundForm,
  movesCreditOf,
  ReceiptForm,
  refundBody,
  RefundForm,
  refundIssues,
  returnableLines,
  SaleIssues,
} from './sale-forms';
import { SaleReceiptFields } from './sale-receipt-fields';
import { SaleDetail } from './sale.types';

/** The field of the form a `422` of the refund names (the backend field to the form field). */
const SERVER_FIELDS: Readonly<Record<string, string>> = {
  'value.taxable': 'taxable',
  'value.tax': 'tax',
  'value.total': 'total',
  'fiscalReceiptInfo.date': 'receipt.date',
  'fiscalReceiptInfo.report': 'receipt.report',
  'fiscalReceiptInfo.number': 'receipt.number',
  'fiscalReceiptInfo.amount': 'receipt.amount',
};

/** A refund whose outcome is not known: the key it was sent with, what it was and what the sale was like. */
interface UncertainRefund {
  readonly key: string;
  /** What the refund returned (lines, value, receipt), to tell a retry from another refund. */
  readonly signature: string;
  /** How many refunds the sale had and what they returned: a change means the refund shows. */
  readonly refunds: number;
  readonly returned: number;
}

/**
 * A refund of a sale (`POST …/refunds`, `If-Match`): the lines that can still be returned
 * (`quantity - returned`, only the lines sold), the quantity to return of each, the value (all
 * three amounts or none: the server computes it when it is left out) and the fiscal receipt of the
 * refund. Every send has its own key (`timestampId`), except when the outcome of the last one is
 * not known (no answer, a server error): the next send of the same refund, even after the dialog
 * was closed and opened again, keeps that key, so the server answers `200` with the refund it
 * already has instead of registering a second one. The key is dropped when the sale shows a new
 * refund or when the user changes what is returned.
 * The dialog is locked while the request runs and its fields are disabled; after an uncertain
 * outcome, a `412` or a `409` the page reads the sale again and the dialog cannot send until that
 * read ends. Who cannot write the loyalty cards is warned when the sale used a card.
 */
@Component({
  selector: 'fc-sale-refund-dialog',
  imports: [Button, Dialog, FormError, Icon, SaleReceiptFields, TextField, TPipe],
  templateUrl: './sale-refund-dialog.html',
  styleUrl: './sale-dialog.css',
})
export class SaleRefundDialog {
  private readonly api = inject(SaleApi);
  private readonly i18n = inject(I18nService);
  private readonly session = inject(SessionService);
  private readonly injector = inject(Injector);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private uncertain: UncertainRefund | null = null;
  /** The indexes of the lines of the last body sent, by position in it (what a `422` names). */
  private sent: readonly number[] = [];

  readonly groupId = input.required<string>();
  readonly sale = input.required<SaleDetail>();
  /** Currency of the amounts. */
  readonly currency = input.required<string>();
  /** The page is reading the sale. */
  readonly refreshing = input.required<boolean>();
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** The refund was registered. */
  readonly done = output<void>();
  /** The sale has to be read again. */
  readonly reread = output<void>();

  protected readonly run = new SaleActionRun(this.refreshing, () => this.reread.emit());
  protected readonly text = saleDialogText(this.sale, this.currency);
  protected readonly form = signal<RefundForm>(emptyRefundForm());
  protected readonly touched = signal(false);

  protected readonly lines = computed(() => returnableLines(this.sale()));
  protected readonly clientIssues = computed(() => refundIssues(this.lines(), this.form()));
  protected readonly issues = computed<SaleIssues>(() =>
    this.touched() ? { ...this.run.fields(), ...this.clientIssues() } : this.run.fields(),
  );
  protected readonly chosen = computed(() => chosenLines(this.lines(), this.form()));
  protected readonly valueLabels = computed(() => {
    const label = (key: string): string =>
      this.i18n.t('SALES.ACTION.AMOUNT_LABEL', { label: this.i18n.t(key), symbol: this.text.symbol() });
    return {
      taxable: label('SALES.TOTALS.TAXABLE'),
      tax: label('SALES.TOTALS.TAX'),
      total: label('SALES.TOTALS.TOTAL'),
    };
  });
  /** Credit goes back with a refund of a sale that used a card: the write needs the loyalty cards permission too. */
  protected readonly fidelityMissing = computed(
    () => movesCreditOf(this.sale()) && !this.session.can('fidelity:update'),
  );

  constructor() {
    // Every opening starts clean (the key of an uncertain refund is kept apart).
    effect(() => {
      if (this.open()) {
        untracked(() => {
          this.form.set(emptyRefundForm());
          this.touched.set(false);
          this.run.reset();
        });
      }
    });
  }

  /** The text of the issue of a field of the form, `null` when it has none. */
  protected error(field: string): string | null {
    const issue = this.issues()[field];
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  /** A quantity as the hint of a line shows it. */
  protected quantity(value: number): string {
    return formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE, { maximumFractionDigits: 3 });
  }

  protected setQuantity(index: number, text: string): void {
    this.form.update((form) => ({ ...form, quantities: { ...form.quantities, [index]: text } }));
  }

  protected setValue(field: 'taxable' | 'tax' | 'total', text: string): void {
    this.form.update((form) => ({ ...form, [field]: text }));
  }

  protected setReceipt(receipt: ReceiptForm): void {
    this.form.update((form) => ({ ...form, receipt }));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.touched.set(true);
    if (this.run.blocked()) {
      return;
    }
    if (this.chosen().length === 0 || Object.keys(this.clientIssues()).length > 0) {
      focusFirstProblem(this.injector, this.element.nativeElement);
      return;
    }
    const sale = this.sale();
    const draft = refundBody(this.lines(), this.form(), '', new Date());
    const signature = JSON.stringify([draft.products, draft.value, draft.fiscalReceiptInfo]);
    const key = this.keyOf(signature, sale);
    const body = { ...draft, timestampId: key };
    this.sent = body.products.map((line) => line.index);
    const done = await this.run.run(
      () => this.api.refund(this.groupId(), sale.id, sale.version, sale.nonFiscal, body),
      this.fidelityMissing(),
      (field) => this.fieldOf(field),
    );
    this.uncertain = this.run.uncertain()
      ? { key, signature, refunds: sale.refunds.length, returned: sale.returnedValue }
      : null;
    if (done) {
      this.open.set(false);
      this.done.emit();
    } else {
      focusFirstProblem(this.injector, this.element.nativeElement);
    }
  }

  /** The key of a refund: the one of the uncertain refund when this is the same refund and the sale shows nothing new, otherwise a new one. */
  private keyOf(signature: string, sale: SaleDetail): string {
    const uncertain = this.uncertain;
    if (
      uncertain !== null &&
      uncertain.signature === signature &&
      uncertain.refunds === sale.refunds.length &&
      uncertain.returned === sale.returnedValue
    ) {
      return uncertain.key;
    }
    return `bo-${crypto.randomUUID()}`;
  }

  /** The field of the form a field of the request belongs to: a line by its position in the body or by its index. */
  private fieldOf(field: string): string | undefined {
    if (Object.hasOwn(SERVER_FIELDS, field)) {
      return SERVER_FIELDS[field];
    }
    const position = /^products\.(\d+)\.quantity$/.exec(field);
    if (position !== null) {
      const index = this.sent[Number(position[1])];
      return index === undefined ? undefined : `quantity.${index}`;
    }
    const line = /^quantity\.(\d+)$/.exec(field);
    return line === null ? undefined : `quantity.${line[1]}`;
  }
}
