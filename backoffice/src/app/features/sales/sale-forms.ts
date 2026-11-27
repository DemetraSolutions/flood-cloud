import { AmendBody, FiscalReceiptBody, RefundBody } from './sale-api';
import { SaleDetail, SaleProduct } from './sale.types';

/** Largest amount and counter the server accepts. */
export const MAX_SALE_AMOUNT = 1_000_000_000;
/** Longest code of a loyalty card and of a lottery ticket the server accepts. */
export const CARD_CODE_MAX = 64;
export const LOTTERY_CODE_MAX = 32;

/**
 * The sale may have moved credit of a loyalty card (a card was used or credit was spent): undoing it
 * (cancellation, refund, deletion) may give credit back, which needs the permission to write the cards.
 */
export function movesCreditOf(sale: Pick<SaleDetail, 'fidelityCardUsed' | 'payments'>): boolean {
  return sale.fidelityCardUsed || sale.payments.fidelityCredit > 0;
}

/** Issue of a field of the dialogs (the names of `FORM.ISSUE`). */
export type SaleIssue = 'type' | 'maximum' | 'maxLength' | 'incorrect' | 'required' | 'format';

/** The payments an amendment may change (the credit used cannot be negative). */
export const PAYMENT_FIELDS = ['cash', 'electronic', 'cheque', 'tickets', 'fidelityCredit'] as const;

/** One of the payments an amendment may change. */
export type PaymentField = (typeof PAYMENT_FIELDS)[number];

/** The fields of the fiscal receipt of an amendment, of a refund and of a cancellation (as typed). */
export interface ReceiptForm {
  /** Local date and time (`YYYY-MM-DDTHH:mm`). */
  date: string;
  report: string;
  number: string;
  amount: string;
}

/** An empty fiscal receipt form. */
export const EMPTY_RECEIPT: ReceiptForm = { date: '', report: '', number: '', amount: '' };

/** What the amendment dialog edits, as typed. */
export interface AmendForm extends Record<PaymentField, string> {
  /** The contact of the customer, `null` for none. */
  customerId: string | null;
  cardCode: string;
  receipt: ReceiptForm;
  lottery: string;
}

/** The issues of the fields of a dialog, by field name (`receipt.date`, `payments.cash`, …). */
export type SaleIssues = Readonly<Record<string, string>>;

/** A date as the value of a `datetime-local` field (local time, to the minute); `''` for a missing or invalid one. */
export function localInput(iso: string | null): string {
  const date = iso === null ? new Date(NaN) : new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The instant of the value of a `datetime-local` field, as ISO 8601; `null` when it is not a date. */
export function isoOfInput(text: string): string | null {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An amount of the sale as typed: two decimals. */
function amountText(value: number): string {
  return value.toFixed(2);
}

/** A counter of the fiscal receipt as typed. */
function counterText(value: number | string | null): string {
  return value === null ? '' : String(value);
}

/** The amount typed, `null` when it is not a number with at most two decimals (a comma counts as a point). */
export function parseAmount(text: string): number | null {
  const value = text.trim().replace(',', '.');
  return /^\d+(\.\d{1,2})?$/.test(value) ? Number(value) : null;
}

/** The counter typed, `null` when it is not a whole number. */
export function parseCounter(text: string): number | null {
  const value = text.trim();
  return /^\d{1,10}$/.test(value) ? Number(value) : null;
}

/** The amount typed is empty or fine: its issue, `undefined` when there is none. */
function amountIssue(text: string, max = MAX_SALE_AMOUNT): SaleIssue | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  const value = parseAmount(text);
  if (value === null) {
    return 'type';
  }
  return value > max ? 'maximum' : undefined;
}

/** The counter typed is empty or fine: its issue. */
function counterIssue(text: string): SaleIssue | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  const value = parseCounter(text);
  if (value === null) {
    return 'type';
  }
  return value > MAX_SALE_AMOUNT ? 'maximum' : undefined;
}

/** The issues of the fiscal receipt typed, under `prefix` (`receipt` or `refund.receipt`). */
export function receiptIssues(form: ReceiptForm, prefix: string): SaleIssues {
  const issues: Record<string, SaleIssue> = {};
  const set = (field: string, issue: SaleIssue | undefined): void => {
    if (issue !== undefined) {
      issues[`${prefix}.${field}`] = issue;
    }
  };
  set('date', form.date.trim() !== '' && isoOfInput(form.date) === null ? 'format' : undefined);
  set('report', counterIssue(form.report));
  set('number', counterIssue(form.number));
  set('amount', amountIssue(form.amount));
  return issues;
}

/** The fiscal receipt typed as the body wants it: only the fields that are filled; `null` when none is. */
export function receiptBody(form: ReceiptForm): FiscalReceiptBody | null {
  const body: FiscalReceiptBody = {};
  if (form.date.trim() !== '') {
    body.date = isoOfInput(form.date);
  }
  if (form.report.trim() !== '') {
    body.report = parseCounter(form.report);
  }
  if (form.number.trim() !== '') {
    body.number = parseCounter(form.number);
  }
  if (form.amount.trim() !== '') {
    body.amount = parseAmount(form.amount);
  }
  return Object.keys(body).length === 0 ? null : body;
}

/** The fiscal receipt of a sale as typed. */
export function receiptFormOf(info: SaleDetail['fiscalReceiptInfo']): ReceiptForm {
  return info === null
    ? { ...EMPTY_RECEIPT }
    : {
        date: localInput(info.date),
        report: counterText(info.report),
        number: counterText(info.number),
        amount: amountText(info.amount),
      };
}

/** The amendment form before a sale is loaded into it. */
export const EMPTY_AMEND: AmendForm = {
  cash: '',
  electronic: '',
  cheque: '',
  tickets: '',
  fidelityCredit: '',
  customerId: null,
  cardCode: '',
  receipt: EMPTY_RECEIPT,
  lottery: '',
};

/** The amendment dialog as it opens: the values of the sale (the lottery code is never read, so it starts empty). */
export function amendFormOf(sale: SaleDetail): AmendForm {
  return {
    cash: amountText(sale.payments.cash),
    electronic: amountText(sale.payments.electronic),
    cheque: amountText(sale.payments.cheque),
    tickets: amountText(sale.payments.tickets),
    fidelityCredit: amountText(sale.payments.fidelityCredit),
    customerId: sale.customer?.id ?? null,
    cardCode: sale.fidelityCardCode ?? '',
    receipt: receiptFormOf(sale.fiscalReceiptInfo),
    lottery: '',
  };
}

/**
 * The issues of the amendment typed (no amount is negative). A payment left as the sale had it is
 * never an issue, so a value the form cannot take back (a negative amount of an old sale) does
 * not stop the other changes.
 *
 * @param form The form as typed.
 * @param initial The form as it opened.
 */
export function amendIssues(form: AmendForm, initial: AmendForm): SaleIssues {
  const issues: Record<string, SaleIssue> = {};
  for (const field of PAYMENT_FIELDS) {
    if (form[field] === initial[field]) {
      continue;
    }
    const issue = amountIssue(form[field]);
    if (issue !== undefined) {
      issues[field] = issue;
    } else if (form[field].trim() === '') {
      issues[field] = 'required';
    }
  }
  if (form.cardCode.trim().length > CARD_CODE_MAX) {
    issues['cardCode'] = 'maxLength';
  }
  if (form.lottery.trim().length > LOTTERY_CODE_MAX) {
    issues['lottery'] = 'maxLength';
  }
  return { ...issues, ...receiptIssues(form.receipt, 'receipt') };
}

/** The receipt typed is the one the sale had. */
function sameReceipt(a: ReceiptForm, b: ReceiptForm): boolean {
  return a.date === b.date && a.report === b.report && a.number === b.number && a.amount === b.amount;
}

/**
 * The body of the amendment: only what changed since the dialog opened (a payment that changed
 * numerically, the customer, the card code when the user may read it, the fiscal receipt, the
 * lottery code when something was typed). Empty when nothing changed.
 *
 * @param initial The form as it opened.
 * @param form The form as typed (without issues).
 * @param canReadCard Whether the user can read the cards: without it the code is not known and is never sent.
 */
export function amendBody(initial: AmendForm, form: AmendForm, canReadCard: boolean): AmendBody {
  const body: AmendBody = {};
  const payments: NonNullable<AmendBody['payments']> = {};
  for (const field of PAYMENT_FIELDS) {
    const value = parseAmount(form[field]) as number;
    if (value !== parseAmount(initial[field])) {
      payments[field] = value;
    }
  }
  if (Object.keys(payments).length > 0) {
    body.payments = payments;
  }
  if (form.customerId !== initial.customerId) {
    body.customer = form.customerId === null ? null : { contactId: form.customerId };
  }
  if (canReadCard && form.cardCode.trim() !== initial.cardCode.trim()) {
    body.fidelityCardCode = form.cardCode.trim() === '' ? null : form.cardCode.trim();
  }
  if (!sameReceipt(form.receipt, initial.receipt)) {
    body.fiscalReceiptInfo = receiptBody(form.receipt);
  }
  // The code is never shown, so it opens empty: only a code typed since then is sent.
  if (form.lottery.trim() !== initial.lottery.trim()) {
    body.lotteryCode = form.lottery.trim();
  }
  return body;
}

/** A line of a sale with something left to return. */
export interface ReturnableLine {
  readonly product: SaleProduct;
  /** `quantity - returned`, never below zero. */
  readonly left: number;
}

/** The lines that can still be returned: the ones sold (quantity above zero) of which something is left. */
export function returnableLines(sale: Pick<SaleDetail, 'products'>): ReturnableLine[] {
  return sale.products
    .filter((product) => product.quantity > 0)
    .map((product) => ({ product, left: Math.max(0, round3(product.quantity - product.returned)) }))
    .filter((line) => line.left > 0);
}

/** A quantity without the noise of the binary arithmetic (three decimals, as the lines show them). */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The quantity typed, `null` when it is not a number above zero with at most three decimals (a comma counts as a point). */
export function parseQuantity(text: string): number | null {
  const value = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(value)) {
    return null;
  }
  const quantity = Number(value);
  return quantity > 0 ? quantity : null;
}

/** What the refund dialog edits, as typed. */
export interface RefundForm {
  /** Quantity to return of each line, by `index` of the line (`''` for none). */
  quantities: Readonly<Record<number, string>>;
  taxable: string;
  tax: string;
  total: string;
  receipt: ReceiptForm;
}

/** The refund dialog as it opens. */
export function emptyRefundForm(): RefundForm {
  return { quantities: {}, taxable: '', tax: '', total: '', receipt: { ...EMPTY_RECEIPT } };
}

/**
 * The issues of the refund typed: a quantity that is not a number or is above what is left, the value
 * (filled all or not at all) and the fiscal receipt. The lines with no quantity are not part of the refund.
 *
 * @param lines The lines that can be returned.
 * @param form The form as typed.
 */
export function refundIssues(lines: readonly ReturnableLine[], form: RefundForm): SaleIssues {
  const issues: Record<string, SaleIssue> = {};
  for (const line of lines) {
    const text = form.quantities[line.product.index] ?? '';
    if (text.trim() === '') {
      continue;
    }
    const quantity = parseQuantity(text);
    if (quantity === null) {
      issues[`quantity.${line.product.index}`] = 'type';
    } else if (quantity > line.left) {
      issues[`quantity.${line.product.index}`] = 'maximum';
    }
  }
  const value = [form.taxable, form.tax, form.total];
  const filled = value.filter((text) => text.trim() !== '').length;
  for (const [field, text] of [['taxable', form.taxable], ['tax', form.tax], ['total', form.total]] as const) {
    const issue = amountIssue(text);
    if (issue !== undefined) {
      issues[field] = issue;
    } else if (filled > 0 && filled < 3 && text.trim() === '') {
      issues[field] = 'required';
    }
  }
  return { ...issues, ...receiptIssues(form.receipt, 'receipt') };
}

/** The lines the user chose to return: the ones with a quantity typed. */
export function chosenLines(lines: readonly ReturnableLine[], form: RefundForm): ReturnableLine[] {
  return lines.filter((line) => (form.quantities[line.product.index] ?? '').trim() !== '');
}

/**
 * The body of a refund: the lines with a quantity, the value when it was typed (the server computes it
 * otherwise) and the fiscal receipt when something was typed.
 *
 * @param lines The lines that can be returned.
 * @param form The form as typed (without issues).
 * @param timestampId The key of the refund, chosen by the dialog for each send.
 * @param now The instant of the refund.
 */
export function refundBody(
  lines: readonly ReturnableLine[],
  form: RefundForm,
  timestampId: string,
  now: Date,
): RefundBody {
  const body: RefundBody = {
    timestampId,
    date: now.toISOString(),
    products: chosenLines(lines, form).map((line) => ({
      index: line.product.index,
      ...(line.product.productId === null ? {} : { productId: line.product.productId }),
      quantity: parseQuantity(form.quantities[line.product.index] as string) as number,
    })),
  };
  if (form.total.trim() !== '') {
    body.value = {
      taxable: parseAmount(form.taxable) as number,
      tax: parseAmount(form.tax) as number,
      total: parseAmount(form.total) as number,
    };
  }
  const receipt = receiptBody(form.receipt);
  if (receipt !== null) {
    body.fiscalReceiptInfo = receipt;
  }
  return body;
}
