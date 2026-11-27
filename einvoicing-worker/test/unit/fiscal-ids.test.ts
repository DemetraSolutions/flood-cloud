import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkFiscalIds, isValidFiscalCode, isValidVatNumber } from '../../src/validation/fiscal-ids.ts';
import { change, ordinary, simplified } from '../helpers/models.ts';

describe('Italian VAT numbers', () => {
  it('accepts numbers with the right check digit', () => {
    for (const code of ['01879020517', '01234567897', '09876543217', '80012345676', '01111111116', '12345678903']) {
      assert.equal(isValidVatNumber(code), true, code);
    }
  });

  it('rejects a wrong check digit, a wrong length and non-digits', () => {
    for (const code of ['01234567890', '01879020518', '0187902051', '018790205170', 'IT01879020517', '0187902051a', '']) {
      assert.equal(isValidVatNumber(code), false, code);
    }
  });

  it('the check digit is computed with doubling of the even positions (digits above 4 give a doubled value above 9)', () => {
    // 9 in an even position doubles to 18 -> 9; this number only checks out with that rule.
    assert.equal(isValidVatNumber('09999999999'), true);
    assert.equal(isValidVatNumber('09999999990'), false);
  });
});

describe('Italian fiscal codes', () => {
  it('accepts the 16-character layout with the right check character, including omocodia', () => {
    for (const code of ['RSSMRA85T10A562S', 'RSSMRA80A01H501U']) {
      assert.equal(isValidFiscalCode(code), true, code);
    }
    // Omocodia: the last digit of the serial (562) replaced by its letter (M stands for 2) changes the check character.
    assert.equal(isValidFiscalCode('RSSMRA85T10A56MF'), true);
    assert.equal(isValidFiscalCode('RSSMRA85T10A56MS'), false);
  });

  it('accepts an 11-digit company code that follows the VAT rules', () => {
    assert.equal(isValidFiscalCode('01879020517'), true);
    assert.equal(isValidFiscalCode('01879020518'), false);
  });

  it('rejects wrong check characters, layouts, lengths and lower case', () => {
    for (const code of ['RSSMRA85T10A562X', 'RSSMRA85T10A562', 'RSSMRA85T10A562SS', 'rssmra85t10a562s', 'RSSMRA85T10A5628', '1SSMRA85T10A562S', 'RSSMRA85F10A562S', '']) {
      assert.equal(isValidFiscalCode(code), false, code);
    }
  });
});

describe('checkFiscalIds', () => {
  const seller = 'FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici';
  const buyer = 'FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici';

  it('reports nothing for valid identifiers', () => {
    assert.deepEqual(checkFiscalIds(ordinary()), []);
    assert.deepEqual(checkFiscalIds(simplified()), []);
  });

  it('reports an Italian VAT number and fiscal codes of seller and buyer, as errors without values', () => {
    const bad = change(ordinary(), {
      [`${seller}.IdFiscaleIVA.IdCodice`]: '01234567890',
      [`${seller}.CodiceFiscale`]: '01234567890',
      [`${buyer}.IdFiscaleIVA`]: { IdPaese: 'IT', IdCodice: '09876543210' },
      [`${buyer}.CodiceFiscale`]: 'RSSMRA80A01H501X',
    });
    const issues = checkFiscalIds(bad);
    assert.deepEqual(issues.map((found) => found.path), [
      `${seller}.IdFiscaleIVA.IdCodice`,
      `${seller}.CodiceFiscale`,
      `${buyer}.IdFiscaleIVA.IdCodice`,
      `${buyer}.CodiceFiscale`,
    ]);
    assert.ok(issues.every((found) => found.code === 'FISCAL_ID' && found.severity === 'error'));
    assert.ok(issues.every((found) => !/0123456|0987654|RSSMRA/.test(found.message)), 'no value in the messages');
  });

  it('never touches identifiers of other countries', () => {
    const foreign = change(ordinary(), {
      [`${seller}.IdFiscaleIVA`]: { IdPaese: 'DE', IdCodice: 'not-checked' },
      [`${seller}.CodiceFiscale`]: 'whatever',
      [`${buyer}.IdFiscaleIVA`]: { IdPaese: 'FR', IdCodice: '1' },
      [`${buyer}.CodiceFiscale`]: 'x',
    });
    assert.deepEqual(checkFiscalIds(foreign), []);
  });

  it('checks the fiscal code of a buyer that has no VAT number (the Italian private customer)', () => {
    const bad = change(ordinary(), { [`${buyer}.CodiceFiscale`]: 'RSSMRA80A01H501X' });
    assert.deepEqual(checkFiscalIds(bad).map((found) => found.path), [`${buyer}.CodiceFiscale`]);
  });

  it('applies the same rules to the simplified format', () => {
    const header = 'FatturaElettronicaHeader';
    const bad = change(simplified(), {
      [`${header}.CedentePrestatore.IdFiscaleIVA.IdCodice`]: '01234567890',
      [`${header}.CedentePrestatore.CodiceFiscale`]: 'abc',
      [`${header}.CessionarioCommittente.IdentificativiFiscali`]: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '09876543210' }, CodiceFiscale: 'abc' },
    });
    assert.deepEqual(checkFiscalIds(bad).map((found) => found.path), [
      `${header}.CedentePrestatore.IdFiscaleIVA.IdCodice`,
      `${header}.CedentePrestatore.CodiceFiscale`,
      `${header}.CessionarioCommittente.IdentificativiFiscali.IdFiscaleIVA.IdCodice`,
      `${header}.CessionarioCommittente.IdentificativiFiscali.CodiceFiscale`,
    ]);
  });
});
