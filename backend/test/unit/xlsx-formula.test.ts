import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeFormula, restoreFormula } from '../../src/shared/xlsx/formula.ts';

const STARTS = ['=', '+', '-', '@', '\t', '\r'];

describe('formula neutralization', () => {
  it('adds an apostrophe to a text a spreadsheet could read as a formula', () => {
    for (const start of STARTS) {
      assert.equal(neutralizeFormula(`${start}SUM(A1)`), `'${start}SUM(A1)`);
      assert.equal(neutralizeFormula(`'${start}x`), `''${start}x`, 'also after an apostrophe');
      assert.equal(neutralizeFormula(`'''${start}x`), `''''${start}x`);
    }
  });

  it('leaves any other text alone', () => {
    for (const text of ['', 'plain', "it's", "'", "''", "'a=b", 'a=b', '1+1', "'quoted'"]) {
      assert.equal(neutralizeFormula(text), text);
    }
  });

  it('restores only an apostrophe that neutralization could have added', () => {
    for (const start of STARTS) {
      assert.equal(restoreFormula(`'${start}x`), `${start}x`);
      assert.equal(restoreFormula(`''${start}x`), `'${start}x`);
    }
    for (const text of ['', "'", 'plain', "'plain", "'a=b", '=x', "''a", 'x\'=']) {
      assert.equal(restoreFormula(text), text);
    }
  });

  it('is an exact round trip for every text', () => {
    const samples = ['', '=A1', "'=A1", "''-1", '+1', '@x', '\tx', '\rx', "'", "'x", 'plain', "a'=", "'''@", ' =x', '日本', "'日本"];
    for (const sample of samples) {
      assert.equal(restoreFormula(neutralizeFormula(sample)), sample);
    }
  });
});

describe('neutralizeFormula: spaces and full-width characters', () => {
  it('neutralizes a formula hidden behind white space, a tab, a carriage return or a full-width sign, and restores it exactly', () => {
    for (const value of [' =1+1', '  +x', '\u00a0-1', '\u2003@x', '\n=1', '\t', '\tabc', '\rabc', '＝1', '＋1', '－1', '＠x', ' ＝1', "'\u00a0=1", "''＝1"]) {
      const written = neutralizeFormula(value);
      assert.equal(written, `'${value}`, JSON.stringify(value));
      assert.equal(restoreFormula(written), value, JSON.stringify(value));
    }
  });

  it('leaves alone what cannot start a formula, and an apostrophe that is not an escape', () => {
    for (const value of ['abc', ' abc', 'a=1', "'abc", "'", '', ' ']) {
      assert.equal(neutralizeFormula(value), value, JSON.stringify(value));
      assert.equal(restoreFormula(value), value, JSON.stringify(value));
    }
  });
});
