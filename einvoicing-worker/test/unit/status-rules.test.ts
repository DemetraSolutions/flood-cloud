import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NormalizedStatus } from '../../src/providers/types.ts';
import { dispositionOf, formatOf, KEPT_ERRORS, nextStatusDelay } from '../../src/engine/status-rules.ts';
import type { Disposition, InvoiceFormat } from '../../src/engine/status-rules.ts';

const ALL: NormalizedStatus[] = ['takingCharge', 'sent', 'processingError', 'rejected', 'delivered', 'notDelivered', 'deliveryImpossible', 'accepted', 'refused', 'effectiveDate'];

describe('formatOf', () => {
  it('FSM10 for TD07-TD09 whatever the counterpart says, otherwise the counterpart choice, FPR12 by default', () => {
    const record = (tipo: unknown, format: unknown) => ({ fattura_elettronica: { tipo }, counterpart: { fattura_elettronica: { formato_trasmissione: format } } });
    assert.equal(formatOf(record('TD07', 'FPA12')), 'FSM10');
    assert.equal(formatOf(record('TD09', 'FPR12')), 'FSM10');
    assert.equal(formatOf(record('TD01', 'FPA12')), 'FPA12');
    assert.equal(formatOf(record('TD04', 'FPR12')), 'FPR12');
    assert.equal(formatOf(record('TD01', '')), 'FPR12');
    assert.equal(formatOf(record(7, 7)), 'FPR12');
    assert.equal(formatOf({}), 'FPR12');
    assert.equal(formatOf({ fattura_elettronica: {}, counterpart: {} }), 'FPR12');
  });
});

describe('dispositionOf', () => {
  const expected: Record<InvoiceFormat, Record<NormalizedStatus, Disposition>> = {
    FPR12: { takingCharge: 'continue', sent: 'continue', processingError: 'keep', rejected: 'keep', delivered: 'delete', notDelivered: 'delete', deliveryImpossible: 'delete', accepted: 'delete', refused: 'keep', effectiveDate: 'delete' },
    FSM10: { takingCharge: 'continue', sent: 'continue', processingError: 'keep', rejected: 'keep', delivered: 'delete', notDelivered: 'delete', deliveryImpossible: 'delete', accepted: 'delete', refused: 'keep', effectiveDate: 'delete' },
    FPA12: { takingCharge: 'continue', sent: 'continue', processingError: 'keep', rejected: 'keep', delivered: 'continue', notDelivered: 'continue', deliveryImpossible: 'delete', accepted: 'delete', refused: 'keep', effectiveDate: 'delete' },
  };

  for (const format of Object.keys(expected) as InvoiceFormat[]) {
    it(`has the terminal set of ${format}`, () => {
      for (const status of ALL) {
        assert.equal(dispositionOf(status, format), expected[format][status], `${format} ${status}`);
      }
    });
  }

  it('describes the three kept states for "Documenti in errore"', () => {
    assert.deepEqual(Object.keys(KEPT_ERRORS).sort(), ['processingError', 'refused', 'rejected']);
    assert.equal(KEPT_ERRORS.rejected.errorCode, 'SDI_REJECTED');
    assert.equal(KEPT_ERRORS.processingError.errorCode, 'PROCESSING_ERROR');
    assert.equal(KEPT_ERRORS.refused.errorCode, 'REFUSED');
  });
});

describe('nextStatusDelay', () => {
  it('is 5, 15, 30 minutes, 1, 2, 4, 8 hours, then 12 hours for ever', () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 50].map((answers) => nextStatusDelay(answers) / 60_000);
    assert.deepEqual(minutes, [5, 15, 30, 60, 120, 240, 480, 720, 720, 720]);
  });
});
