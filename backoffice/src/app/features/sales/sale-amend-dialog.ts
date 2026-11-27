import { Component, computed, effect, ElementRef, inject, Injector, input, model, output, signal, untracked } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Icon } from '../../shared/ui/icon/icon';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ContactApi } from '../contacts/contact-api';
import { SaleActionRun } from './sale-action-run';
import { focusFirstProblem, saleDialogText } from './sale-dialog-support';
import { SaleApi } from './sale-api';
import {
  AmendForm,
  amendBody,
  amendFormOf,
  amendIssues,
  CARD_CODE_MAX,
  EMPTY_AMEND,
  LOTTERY_CODE_MAX,
  PAYMENT_FIELDS,
  PaymentField,
  ReceiptForm,
  SaleIssues,
} from './sale-forms';
import { SaleReceiptFields } from './sale-receipt-fields';
import { SaleDetail } from './sale.types';

/** Fewest characters that start the search of a customer. */
export const SALE_CUSTOMER_MIN_CHARS = 3;

/** The field of the form a `422` of the amendment names (the backend field to the form field). */
const SERVER_FIELDS: Readonly<Record<string, string>> = {
  'payments.cash': 'cash',
  'payments.electronic': 'electronic',
  'payments.cheque': 'cheque',
  'payments.tickets': 'tickets',
  'payments.fidelityCredit': 'fidelityCredit',
  customer: 'customer',
  'customer.contactId': 'customer',
  fidelityCardCode: 'cardCode',
  lotteryCode: 'lottery',
  'fiscalReceiptInfo.date': 'receipt.date',
  'fiscalReceiptInfo.report': 'receipt.report',
  'fiscalReceiptInfo.number': 'receipt.number',
  'fiscalReceiptInfo.amount': 'receipt.amount',
};

/**
 * The amendment of a sale (`PATCH`, `If-Match`): the payments (cash, electronic, cheques, vouchers
 * and the credit of the card, none below zero), the customer (a contact chosen with the compact
 * search), the code of the loyalty card (only for whoever can read the cards), the fiscal receipt
 * and the lottery code (never shown: it is only sent when typed). Only the fields that changed are
 * sent. Whoever cannot write the loyalty cards cannot change the credit used or the card (the
 * fields are disabled and the dialog says why). The dialog is locked while the request runs and its
 * fields are disabled; when the outcome is not known (no answer, a server error) or the sale
 * changed (`412`, `409`) the page reads it again and the dialog cannot send until that read ends.
 * When the sale changes under an open dialog (a new `version`) the form starts again from the new
 * data and says so. The page reads the sale again after a success too (`done`).
 */
@Component({
  selector: 'fc-sale-amend-dialog',
  imports: [Button, Dialog, FormError, Icon, SaleReceiptFields, SearchCombobox, TextField, TPipe],
  templateUrl: './sale-amend-dialog.html',
  styleUrl: './sale-dialog.css',
})
export class SaleAmendDialog {
  private readonly api = inject(SaleApi);
  private readonly contacts = inject(ContactApi);
  private readonly i18n = inject(I18nService);
  private readonly session = inject(SessionService);
  private readonly injector = inject(Injector);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The version of the sale the form was loaded from; `null` while the dialog is closed. */
  private loadedVersion: string | null = null;

  readonly groupId = input.required<string>();
  readonly sale = input.required<SaleDetail>();
  /** Currency of the amounts. */
  readonly currency = input.required<string>();
  /** The page is reading the sale. */
  readonly refreshing = input.required<boolean>();
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** The amendment was applied. */
  readonly done = output<void>();
  /** The sale has to be read again. */
  readonly reread = output<void>();

  protected readonly run = new SaleActionRun(this.refreshing, () => this.reread.emit());
  protected readonly text = saleDialogText(this.sale, this.currency);
  protected readonly form = signal<AmendForm>(EMPTY_AMEND);
  protected readonly touched = signal(false);
  protected readonly customerLabel = signal<string | null>(null);
  /** The sale changed while the dialog was open and the form was loaded again. */
  protected readonly updated = signal(false);

  private readonly initial = signal<AmendForm>(EMPTY_AMEND);
  protected readonly paymentFields = PAYMENT_FIELDS;
  protected readonly minChars = SALE_CUSTOMER_MIN_CHARS;
  protected readonly cardMax = CARD_CODE_MAX;
  protected readonly lotteryMax = LOTTERY_CODE_MAX;
  protected readonly canReadCard = computed(() => this.session.can('fidelity:read'));
  protected readonly canReadContacts = computed(() => this.session.can('contacts:read'));
  /** Credit and cards move with the loyalty write permission. */
  protected readonly canWriteFidelity = computed(() => this.session.can('fidelity:update'));
  protected readonly paymentLabels = computed(() =>
    PAYMENT_FIELDS.map((field) => ({
      field,
      label: this.i18n.t('SALES.ACTION.AMOUNT_LABEL', {
        label: this.i18n.t(`SALES.PAYMENT.${field.toUpperCase()}`),
        symbol: this.text.symbol(),
      }),
    })),
  );
  protected readonly clientIssues = computed(() => amendIssues(this.form(), this.initial()));
  /** The issues shown: the ones the server named and, once the user tried to send, the ones of the form. */
  protected readonly issues = computed<SaleIssues>(() =>
    this.touched() ? { ...this.run.fields(), ...this.clientIssues() } : this.run.fields(),
  );
  protected readonly body = computed(() =>
    amendBody(this.initial(), this.form(), this.canReadCard()),
  );
  protected readonly changed = computed(() => Object.keys(this.body()).length > 0);
  protected readonly customerName = computed(
    () => this.customerLabel() ?? this.sale().customer?.displayName ?? null,
  );

  constructor() {
    // Every opening starts from the values of the sale; a sale that changes while the dialog is
    // open (another version) loads the form again.
    effect(() => {
      const open = this.open();
      const version = this.sale().version;
      untracked(() => {
        if (!open) {
          this.loadedVersion = null;
          return;
        }
        if (this.loadedVersion === null) {
          this.load();
          this.updated.set(false);
          this.run.reset();
        } else if (version !== this.loadedVersion) {
          this.load();
          this.updated.set(true);
        }
        this.loadedVersion = version;
      });
    });
  }

  /** The text of the issue of a field of the form, `null` when it has none. */
  protected error(field: string): string | null {
    const issue = this.issues()[field];
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected setPayment(field: PaymentField, text: string): void {
    this.form.update((form) => ({ ...form, [field]: text }));
  }

  protected setCard(text: string): void {
    this.form.update((form) => ({ ...form, cardCode: text }));
  }

  protected setLottery(text: string): void {
    this.form.update((form) => ({ ...form, lottery: text }));
  }

  protected setReceipt(receipt: ReceiptForm): void {
    this.form.update((form) => ({ ...form, receipt }));
  }

  protected readonly searchCustomers = (text: string): Promise<readonly SearchOption[]> =>
    this.contacts.searchContacts(this.groupId(), text);

  protected chooseCustomer(option: SearchOption | null): void {
    this.customerLabel.set(option?.label ?? null);
    this.form.update((form) => ({ ...form, customerId: option?.value ?? null }));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.touched.set(true);
    if (this.run.blocked()) {
      return;
    }
    if (Object.keys(this.clientIssues()).length > 0 || !this.changed()) {
      focusFirstProblem(this.injector, this.element.nativeElement);
      return;
    }
    const sale = this.sale();
    const done = await this.run.run(
      () => this.api.amend(this.groupId(), sale.id, sale.version, sale.nonFiscal, this.body()),
      false,
      fieldOf,
    );
    if (done) {
      this.open.set(false);
      this.done.emit();
    } else {
      focusFirstProblem(this.injector, this.element.nativeElement);
    }
  }

  /** Puts the values of the sale in the form. */
  private load(): void {
    const start = amendFormOf(this.sale());
    this.initial.set(start);
    this.form.set(start);
    this.touched.set(false);
    this.customerLabel.set(null);
  }
}

/** The field of the form a field of the request belongs to. */
function fieldOf(field: string): string | undefined {
  return Object.hasOwn(SERVER_FIELDS, field) ? SERVER_FIELDS[field] : undefined;
}
