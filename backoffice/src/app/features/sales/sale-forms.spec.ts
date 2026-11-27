import { aSaleDetail, aSaleProduct } from '../../../testing/sales';
import {
  AmendForm,
  amendBody,
  amendFormOf,
  amendIssues,
  CARD_CODE_MAX,
  chosenLines,
  EMPTY_AMEND,
  EMPTY_RECEIPT,
  emptyRefundForm,
  isoOfInput,
  localInput,
  LOTTERY_CODE_MAX,
  MAX_SALE_AMOUNT,
  movesCreditOf,
  parseAmount,
  parseCounter,
  parseQuantity,
  ReceiptForm,
  receiptBody,
  receiptFormOf,
  receiptIssues,
  RefundForm,
  refundBody,
  refundIssues,
  returnableLines,
  round3,
} from './sale-forms';

const NOW = new Date('2026-11-27T10:00:00.000Z');

function amendForm(over: Partial<AmendForm> = {}): AmendForm {
  return { ...EMPTY_AMEND, cash: '30.00', electronic: '0.00', cheque: '0.00', tickets: '0.00', fidelityCredit: '0.00', ...over };
}

function receipt(over: Partial<ReceiptForm> = {}): ReceiptForm {
  return { ...EMPTY_RECEIPT, ...over };
}

function refundForm(over: Partial<RefundForm> = {}): RefundForm {
  return { ...emptyRefundForm(), ...over };
}

describe('credit of the cards', () => {
  const payments = { cash: 0, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 0, unpaid: 0 };

  it('moved credit when a card was used or credit was spent, and not otherwise', () => {
    expect(movesCreditOf({ fidelityCardUsed: true, payments })).toBe(true);
    expect(movesCreditOf({ fidelityCardUsed: false, payments: { ...payments, fidelityCredit: 2 } })).toBe(true);
    expect(movesCreditOf({ fidelityCardUsed: false, payments })).toBe(false);
  });
});

describe('dates of the forms', () => {
  it('writes an instant as local date and time to the minute, and nothing for a missing or invalid one', () => {
    const local = new Date(2026, 10, 7, 9, 5, 42);
    expect(localInput(local.toISOString())).toBe('2026-11-07T09:05');
    expect(localInput(null)).toBe('');
    expect(localInput('not a date')).toBe('');
  });

  it('reads the value of the field as an instant, null when it is not a date', () => {
    expect(isoOfInput('2026-11-07T09:05')).toBe(new Date(2026, 10, 7, 9, 5).toISOString());
    expect(isoOfInput('nope')).toBeNull();
  });
});

describe('numbers of the forms', () => {
  it.each([
    ['12', 12],
    ['12.5', 12.5],
    ['12,50', 12.5],
    [' 7.05 ', 7.05],
    ['0', 0],
    ['12.555', null],
    ['-1', null],
    ['', null],
    ['1e3', null],
    ['abc', null],
  ])('reads the amount %j as %j', (text, value) => {
    expect(parseAmount(text)).toBe(value);
  });

  it.each([
    ['12', 12],
    [' 0 ', 0],
    ['1.5', null],
    ['-1', null],
    ['', null],
    ['12345678901', null],
  ])('reads the counter %j as %j', (text, value) => {
    expect(parseCounter(text)).toBe(value);
  });

  it.each([
    ['2', 2],
    ['0,5', 0.5],
    ['1.125', 1.125],
    ['0', null],
    ['0.000', null],
    ['1.1234', null],
    ['-1', null],
    ['x', null],
    ['', null],
  ])('reads the quantity %j as %j', (text, value) => {
    expect(parseQuantity(text)).toBe(value);
  });

  it('removes the noise of the binary arithmetic', () => {
    expect(round3(0.1 + 0.2)).toBe(0.3);
    expect(round3(1.23456)).toBe(1.235);
  });
});

describe('fiscal receipt', () => {
  it('has no issue when it is empty or well filled', () => {
    expect(receiptIssues(receipt(), 'receipt')).toEqual({});
    expect(
      receiptIssues(receipt({ date: '2026-11-07T09:05', report: '1', number: '2', amount: '3,50' }), 'receipt'),
    ).toEqual({});
    expect(receiptIssues(receipt({ date: '   ', report: ' ', number: ' ', amount: ' ' }), 'receipt')).toEqual({});
  });

  it('names the issue of each field under the prefix', () => {
    expect(
      receiptIssues(receipt({ date: 'x', report: '1.5', number: 'a', amount: '1.234' }), 'refund.receipt'),
    ).toEqual({
      'refund.receipt.date': 'format',
      'refund.receipt.report': 'type',
      'refund.receipt.number': 'type',
      'refund.receipt.amount': 'type',
    });
    expect(
      receiptIssues(
        receipt({ report: String(MAX_SALE_AMOUNT + 1), number: String(MAX_SALE_AMOUNT), amount: String(MAX_SALE_AMOUNT + 1) }),
        'receipt',
      ),
    ).toEqual({ 'receipt.report': 'maximum', 'receipt.amount': 'maximum' });
  });

  it('turns the fields that are filled into the body, and nothing into null', () => {
    expect(receiptBody(receipt())).toBeNull();
    expect(receiptBody(receipt({ date: ' ', report: ' ', number: ' ', amount: ' ' }))).toBeNull();
    expect(receiptBody(receipt({ date: '2026-11-07T09:05', report: '1', number: '2', amount: '3,5' }))).toEqual({
      date: new Date(2026, 10, 7, 9, 5).toISOString(),
      report: 1,
      number: 2,
      amount: 3.5,
    });
    expect(receiptBody(receipt({ number: '7' }))).toEqual({ number: 7 });
    expect(receiptBody(receipt({ amount: '0' }))).toEqual({ amount: 0 });
  });

  it('writes the receipt of a sale as typed', () => {
    expect(receiptFormOf(null)).toEqual(EMPTY_RECEIPT);
    expect(receiptFormOf(null)).not.toBe(EMPTY_RECEIPT);
    const date = new Date(2026, 10, 7, 9, 5).toISOString();
    expect(receiptFormOf({ date, report: 12, number: '34', amount: 3.5 })).toEqual({
      date: '2026-11-07T09:05',
      report: '12',
      number: '34',
      amount: '3.50',
    });
    expect(receiptFormOf({ date: null, report: null, number: null, amount: 0 })).toEqual({
      date: '',
      report: '',
      number: '',
      amount: '0.00',
    });
  });
});

describe('amendment', () => {
  it('opens with the values of the sale, the lottery code always empty', () => {
    const sale = aSaleDetail({
      payments: { cash: 20, electronic: 10.5, cheque: 0, tickets: 0, fidelityCredit: 0, unpaid: 0 },
      fiscalReceiptInfo: null,
    });
    expect(amendFormOf(sale)).toEqual({
      cash: '20.00',
      electronic: '10.50',
      cheque: '0.00',
      tickets: '0.00',
      fidelityCredit: '0.00',
      customerId: sale.customer!.id,
      cardCode: 'CARD1',
      receipt: EMPTY_RECEIPT,
      lottery: '',
    });
    const bare = amendFormOf(aSaleDetail({ customer: null, fidelityCardCode: null }));
    expect(bare.customerId).toBeNull();
    expect(bare.cardCode).toBe('');
  });

  it('has no issue for a form as it opened, whatever it holds', () => {
    const initial = amendForm({ cash: '-5.00', electronic: '' });
    expect(amendIssues(initial, initial)).toEqual({});
  });

  it('names the issues of the payments that changed', () => {
    const initial = amendForm();
    expect(
      amendIssues(
        amendForm({ cash: 'abc', electronic: String(MAX_SALE_AMOUNT + 1), cheque: '', tickets: '1.5', fidelityCredit: '2' }),
        initial,
      ),
    ).toEqual({ cash: 'type', electronic: 'maximum', cheque: 'required' });
    expect(amendIssues(amendForm({ cash: String(MAX_SALE_AMOUNT) }), initial)).toEqual({});
  });

  it('refuses a card code and a lottery code that are too long, and a wrong receipt', () => {
    const initial = amendForm();
    expect(
      amendIssues(
        amendForm({
          cardCode: 'x'.repeat(CARD_CODE_MAX + 1),
          lottery: 'y'.repeat(LOTTERY_CODE_MAX + 1),
          receipt: receipt({ date: 'bad' }),
        }),
        initial,
      ),
    ).toEqual({ cardCode: 'maxLength', lottery: 'maxLength', 'receipt.date': 'format' });
    expect(
      amendIssues(amendForm({ cardCode: 'x'.repeat(CARD_CODE_MAX), lottery: 'y'.repeat(LOTTERY_CODE_MAX) }), initial),
    ).toEqual({});
  });

  it('sends nothing when nothing changed', () => {
    const initial = amendForm({ customerId: 'c1', cardCode: 'A', receipt: receipt({ report: '1' }) });
    expect(amendBody(initial, { ...initial }, true)).toEqual({});
    expect(amendBody(initial, { ...initial, cash: '30,00' }, true)).toEqual({});
  });

  it('sends only the payments that changed numerically', () => {
    const initial = amendForm();
    expect(amendBody(initial, amendForm({ cash: '25', fidelityCredit: '5,5', tickets: '0' }), true)).toEqual({
      payments: { cash: 25, fidelityCredit: 5.5 },
    });
  });

  it('sends the customer chosen, or null to take it away', () => {
    const initial = amendForm({ customerId: 'c1' });
    expect(amendBody(initial, amendForm({ customerId: 'c2' }), true)).toEqual({ customer: { contactId: 'c2' } });
    expect(amendBody(initial, amendForm({ customerId: null }), true)).toEqual({ customer: null });
  });

  it('sends the card code only for whoever can read the cards', () => {
    const initial = amendForm({ cardCode: 'A' });
    expect(amendBody(initial, amendForm({ cardCode: ' B ' }), true)).toEqual({ fidelityCardCode: 'B' });
    expect(amendBody(initial, amendForm({ cardCode: '  ' }), true)).toEqual({ fidelityCardCode: null });
    expect(amendBody(initial, amendForm({ cardCode: 'B' }), false)).toEqual({});
  });

  it('sends the fiscal receipt as it is now, null when it was emptied, and the lottery code when typed', () => {
    const initial = amendForm({ receipt: receipt({ report: '1', number: '2' }) });
    expect(amendBody(initial, amendForm({ receipt: receipt({ report: '1', number: '3' }) }), true)).toEqual({
      fiscalReceiptInfo: { report: 1, number: 3 },
    });
    expect(amendBody(initial, amendForm({ receipt: receipt() }), true)).toEqual({ fiscalReceiptInfo: null });
    for (const field of ['date', 'amount'] as const) {
      const body = amendBody(amendForm(), amendForm({ receipt: receipt({ [field]: field === 'date' ? '2026-11-07T09:05' : '2' }) }), true);
      expect(body.fiscalReceiptInfo).not.toBeUndefined();
    }
    expect(amendBody(amendForm(), amendForm({ lottery: ' ABC ' }), true)).toEqual({ lotteryCode: 'ABC' });
    expect(amendBody(amendForm(), amendForm({ lottery: '   ' }), true)).toEqual({});
  });
});

describe('refund', () => {
  const sale = aSaleDetail({
    products: [
      aSaleProduct({ index: 0, quantity: 2, returned: 0.5 }),
      aSaleProduct({ index: 1, productId: null, quantity: 1, returned: 1 }),
      aSaleProduct({ index: 2, quantity: 0, returned: 0 }),
      aSaleProduct({ index: 3, quantity: -1, returned: 0 }),
      aSaleProduct({ index: 4, quantity: 1, returned: 2 }),
      aSaleProduct({ index: 5, productId: null, quantity: 3, returned: 0 }),
    ],
  });
  const lines = returnableLines(sale);

  it('lists the lines sold of which something is left', () => {
    expect(lines.map((line) => [line.product.index, line.left])).toEqual([
      [0, 1.5],
      [5, 3],
    ]);
    expect(returnableLines({ products: [] })).toEqual([]);
  });

  it('starts empty, with a receipt of its own each time', () => {
    const a = emptyRefundForm();
    expect(a).toEqual({ quantities: {}, taxable: '', tax: '', total: '', receipt: EMPTY_RECEIPT });
    expect(a.receipt).not.toBe(emptyRefundForm().receipt);
  });

  it('has no issue for an empty form, and for quantities within what is left', () => {
    expect(refundIssues(lines, refundForm())).toEqual({});
    expect(refundIssues(lines, refundForm({ quantities: { 0: '', 5: '  ' } }))).toEqual({});
    expect(refundIssues(lines, refundForm({ quantities: { 0: '1,5', 5: '3' } }))).toEqual({});
  });

  it('names a quantity that is not a number or is above what is left', () => {
    expect(refundIssues(lines, refundForm({ quantities: { 0: 'x', 5: '3.001' } }))).toEqual({
      'quantity.0': 'type',
      'quantity.5': 'maximum',
    });
    expect(refundIssues(lines, refundForm({ quantities: { 0: '0' } }))).toEqual({ 'quantity.0': 'type' });
  });

  it('wants the three amounts of the value or none', () => {
    expect(refundIssues(lines, refundForm({ taxable: '1', tax: '0,22', total: '1.22' }))).toEqual({});
    expect(refundIssues(lines, refundForm({ taxable: '1' }))).toEqual({ tax: 'required', total: 'required' });
    expect(refundIssues(lines, refundForm({ taxable: '1', total: '2' }))).toEqual({ tax: 'required' });
    expect(refundIssues(lines, refundForm({ taxable: 'x', tax: '1', total: String(MAX_SALE_AMOUNT + 1) }))).toEqual({
      taxable: 'type',
      total: 'maximum',
    });
  });

  it('includes the issues of the fiscal receipt', () => {
    expect(refundIssues(lines, refundForm({ receipt: receipt({ number: 'x' }) }))).toEqual({ 'receipt.number': 'type' });
  });

  it('chooses the lines with a quantity typed', () => {
    expect(chosenLines(lines, refundForm())).toEqual([]);
    expect(chosenLines(lines, refundForm({ quantities: { 0: ' ', 5: '1' } })).map((line) => line.product.index)).toEqual([5]);
  });

  it('builds the body with the chosen lines, the key and the instant', () => {
    expect(refundBody(lines, refundForm({ quantities: { 0: '1', 5: '2,5' } }), 'bo-1', NOW)).toEqual({
      timestampId: 'bo-1',
      date: NOW.toISOString(),
      products: [
        { index: 0, productId: 'p1', quantity: 1 },
        { index: 5, quantity: 2.5 },
      ],
    });
  });

  it('adds the value when typed and the receipt when something is in it', () => {
    const body = refundBody(
      lines,
      refundForm({
        quantities: { 0: '1' },
        taxable: '1',
        tax: '0,22',
        total: '1.22',
        receipt: receipt({ report: '4', number: '5' }),
      }),
      'bo-2',
      NOW,
    );
    expect(body.value).toEqual({ taxable: 1, tax: 0.22, total: 1.22 });
    expect(body.fiscalReceiptInfo).toEqual({ report: 4, number: 5 });
  });
});
