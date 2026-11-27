import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import {
  ANOMALY_CODES,
  ANOMALY_SOURCES,
  anomalyLabel,
  anomalySourceLabel,
  CHECK_FIELDS,
  CHECK_LINE_CODES,
  checkFieldLabel,
  checkLineLabel,
  conflictKey,
  currencySymbol,
  dateTimeText,
  moneyText,
  receiptNumberText,
  saleReference,
  saleSummary,
  OPERATION_KINDS,
  operationLabel,
  SEND_STATUSES,
  sendStatusLabel,
  sendStatusTone,
  Translate,
} from './sale-labels';
import { ReceiptNumber } from './sale.types';

const dictionary = flattenDictionary(
  JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
);

function has(keys: readonly string[]): void {
  const missing = keys.filter((key) => !dictionary.get(key));
  expect(missing).toEqual([]);
}

const t: Translate = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`);

describe('sale labels', () => {
  it.each([
    ['ANOMALY_CODE', ANOMALY_CODES],
    ['ANOMALY_SOURCE', ANOMALY_SOURCES],
    ['OPERATION', OPERATION_KINDS],
    ['CHECK_FIELD', CHECK_FIELDS],
    ['CHECK_LINE', CHECK_LINE_CODES],
  ] as const)('has the text of every code of %s, the one for no code and the one for any other', (group, codes) => {
    has([...codes, 'NONE', 'UNKNOWN'].map((code) => `SALES.${group}.${code}`));
  });

  it('has the text of every state of sending', () => {
    has(SEND_STATUSES.map((status) => `SALES.SEND_STATUS.${status}`));
  });

  it('has the text of every conflict', () => {
    has(
      [
        'GENERIC',
        'CANCELED',
        'REFUND_EXCEEDS',
        'INVOICED',
        'FISCAL',
        'REFUNDS_LIMIT',
        'DELETED',
        'REFILL_NOT_COVERED',
      ].map((name) => `SALES.ACTION.CONFLICT.${name}`),
    );
  });

  it('labels a known code, an unknown one (with the code) and a missing one', () => {
    expect(anomalyLabel(t, 'cycle')).toBe('SALES.ANOMALY_CODE.cycle');
    expect(anomalyLabel(t, 'brandNew')).toBe('SALES.ANOMALY_CODE.UNKNOWN {"code":"brandNew"}');
    expect(anomalyLabel(t, null)).toBe('SALES.ANOMALY_CODE.NONE');
    expect(anomalySourceLabel(t, 'stock')).toBe('SALES.ANOMALY_SOURCE.stock');
    expect(anomalySourceLabel(t, 'x')).toBe('SALES.ANOMALY_SOURCE.UNKNOWN {"code":"x"}');
    expect(anomalySourceLabel(t, null)).toBe('SALES.ANOMALY_SOURCE.NONE');
    expect(operationLabel(t, 'refund')).toBe('SALES.OPERATION.refund');
    expect(operationLabel(t, 'x')).toBe('SALES.OPERATION.UNKNOWN {"code":"x"}');
    expect(operationLabel(t, null)).toBe('SALES.OPERATION.NONE');
    expect(checkFieldLabel(t, 'tax')).toBe('SALES.CHECK_FIELD.tax');
    expect(checkFieldLabel(t, 'x')).toBe('SALES.CHECK_FIELD.UNKNOWN {"code":"x"}');
    expect(checkLineLabel(t, 'taxMissing')).toBe('SALES.CHECK_LINE.taxMissing');
    expect(checkLineLabel(t, 'x')).toBe('SALES.CHECK_LINE.UNKNOWN {"code":"x"}');
  });

  it('labels a state of sending, and shows an unknown one as it is', () => {
    expect(sendStatusLabel(t, 'delivered')).toBe('SALES.SEND_STATUS.delivered');
    expect(sendStatusLabel(t, 'whatever')).toBe('whatever');
  });

  it('gives every state of sending a tone, neutral for an unknown one', () => {
    expect(SEND_STATUSES.map((status) => sendStatusTone(status))).toEqual([
      'info',
      'warning',
      'info',
      'success',
      'success',
      'danger',
      'danger',
      'danger',
      'danger',
      'danger',
      'success',
      'danger',
      'danger',
    ]);
    expect(sendStatusTone('whatever')).toBe('neutral');
  });

  it('picks the text of the first detail of a 409 it knows, ignoring the position in the field', () => {
    expect(conflictKey([{ field: 'products.3', issue: 'refundExceeds' }])).toBe(
      'SALES.ACTION.CONFLICT.REFUND_EXCEEDS',
    );
    expect(
      conflictKey([
        { field: 'other', issue: 'x' },
        { field: 'canceled', issue: 'canceled' },
        { field: 'status', issue: 'invoiced' },
      ]),
    ).toBe('SALES.ACTION.CONFLICT.CANCELED');
    expect(conflictKey([{ field: 'status', issue: 'invoiced' }])).toBe('SALES.ACTION.CONFLICT.INVOICED');
    expect(conflictKey([{ field: 'fiscalState', issue: 'canceled' }])).toBe('SALES.ACTION.CONFLICT.CANCELED');
    expect(conflictKey([{ field: 'nonFiscal', issue: 'fiscal' }])).toBe('SALES.ACTION.CONFLICT.FISCAL');
    expect(conflictKey([{ field: 'refund', issue: 'refundsLimit' }])).toBe('SALES.ACTION.CONFLICT.REFUNDS_LIMIT');
    expect(conflictKey([{ field: 'timestampId', issue: 'deleted' }])).toBe('SALES.ACTION.CONFLICT.DELETED');
    expect(conflictKey([{ field: 'payments', issue: 'refillNotCovered' }])).toBe(
      'SALES.ACTION.CONFLICT.REFILL_NOT_COVERED',
    );
  });

  it('falls back to the generic text for details it does not know, or none', () => {
    expect(conflictKey([{ field: 'x', issue: 'y' }])).toBe('SALES.ACTION.CONFLICT.GENERIC');
    expect(conflictKey([])).toBe('SALES.ACTION.CONFLICT.GENERIC');
  });
});

describe('texts of the page of a sale', () => {
  it('has every dictionary key the sources of the sale use', () => {
    has([
      ...['NUMBER', 'DATE', 'NONE'].map((k) => `SALES.REFERENCE.${k}`),
      ...['ANOMALIES_ONE', 'ANOMALIES', 'CHECK_DIFFERENCES', 'NOT_SENT'].map((k) => `SALES.BADGE.${k}`),
      ...['INTRO', 'POS', 'SERVER', 'DELTA', 'UNAVAILABLE'].map((k) => `SALES.CHECK.${k}`),
      ...['INTRO', 'NONE', 'TABLE'].map((k) => `SALES.ANOMALIES.${k}`),
      'SALES.OPERATIONS.TABLE',
      'SALES.PRODUCT.TABLE',
      'SALES.REFUND.TABLE',
      'SALES.REREAD_FAILED',
      'SALES.SECTION.ACTIONS',
      'SALES.SECTION.ACTIONS_DESTRUCTIVE',
      ...[
        'GO_BACK',
        'INVOICED_NOTE',
        'FIDELITY_NOTE',
        'SUMMARY',
        'AMOUNT_LABEL',
        'CARD_CODE',
        'CARD_MOVES',
        'NEEDS_FIDELITY',
        'UPDATED',
        'REREADING',
        'INVALID_UNMAPPED',
        'RECEIPT_DATE_HINT',
        'RECEIPT_REPORT_HINT',
        'RECEIPT_NUMBER_HINT',
        'RECEIPT_AMOUNT_HINT',
        'CANCEL_FISCAL',
      ].map((k) => `SALES.ACTION.${k}`),
    ]);
  });

  it('never tells the integrators of the public API about non fiscal sales, quotes or the UM mode', () => {
    const forbidden = /non fiscal|preventiv|\bUM\b|quote/i;
    for (const key of [
      'PUBLIC_API.PERMISSION.SALES_READ.LABEL',
      'PUBLIC_API.PERMISSION.SALES_READ.HINT',
      'PUBLIC_API.KEY.SALES_WARNING',
    ]) {
      const text = dictionary.get(key);
      expect(text, key).toBeTruthy();
      expect(text, key).not.toMatch(forbidden);
    }
  });

  it('writes a receipt number, or the text of a receipt without one', () => {
    expect(receiptNumberText(t, { report: 12, number: 345 })).toBe('12-345');
    expect(receiptNumberText(t, { report: null, number: null })).toBe('SALES.NO_NUMBER');
    expect(receiptNumberText(t, null)).toBe('SALES.NO_NUMBER');
  });

  it('writes a date and time in the language, nothing for none', () => {
    expect(dateTimeText('it', null)).toBe('');
    expect(dateTimeText('it', '2026-11-20T10:30:00.000Z')).toMatch(/2026/);
  });

  it('names a sale by its number, else by its date, else as without number', () => {
    const number: ReceiptNumber = { report: 12, number: 345 };
    expect(saleReference(t, 'it', { number, date: '2026-11-20T10:30:00.000Z' })).toBe('SALES.REFERENCE.NUMBER {"number":"12-345"}');
    const byDate = saleReference(t, 'it', { number: null, date: '2026-11-20T10:30:00.000Z' });
    expect(byDate).toMatch(/^SALES\.REFERENCE\.DATE \{"date":".*2026.*"\}$/);
    expect(saleReference(t, 'it', { number: { report: null, number: null }, date: null })).toBe('SALES.REFERENCE.NONE');
  });

  it('writes an amount in the currency, rounded to the cents', () => {
    expect(moneyText('it', 'EUR', 1.004)).toMatch(/^1,00\s*€$/);
    expect(moneyText('it', 'USD', 2)).toMatch(/^2,00\s*USD$/);
  });

  it('summarizes a sale with its date and total', () => {
    const summary = saleSummary(t, 'it', 'EUR', { date: null, total: 30 });
    expect(summary).toMatch(/^SALES\.ACTION\.SUMMARY \{"date":"","total":"30,00\s*€"\}$/);
  });

  it('gives the symbol of a currency, the code itself when it has none', () => {
    expect(currencySymbol('EUR', 'it')).toBe('€');
    expect(currencySymbol('XTS', 'it')).toBe('XTS');
  });
});
