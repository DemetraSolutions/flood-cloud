import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ITALIAN_PROVINCES } from '../../src/modules/companies/italian-provinces.ts';
import {
  TAX_REGIMES,
  isValidBankCode,
  isValidBic,
  isValidCalendarDate,
  isValidDecimalText,
  isValidIban,
  isValidItalianFiscalCode,
  isValidItalianFiscalCodeOfPerson,
  isValidItalianVatNumber,
  isValidRecipientCode,
  normalizeIban,
} from '../../src/modules/companies/validators.ts';
import { isValidItalianVatDigits } from '../../src/shared/legacy-write/vat.ts';

describe('Italian VAT number', () => {
  // Published numbers of large Italian companies (not personal data) and the invalid neighbours of each.
  const VALID = ['01114601006', '00905811006', '15844561009', '00743110157'];
  it('accepts a number with the right check digit, with or without the IT prefix in any case', () => {
    for (const digits of VALID) {
      assert.ok(isValidItalianVatDigits(digits), digits);
      assert.ok(isValidItalianVatNumber(digits));
      assert.ok(isValidItalianVatNumber(`IT${digits}`));
      assert.ok(isValidItalianVatNumber(`it${digits}`));
    }
  });
  it('refuses a wrong check digit, a wrong length, letters and other prefixes', () => {
    for (const digits of VALID) {
      const wrong = `${digits.slice(0, 10)}${(Number(digits[10]) + 1) % 10}`;
      assert.equal(isValidItalianVatDigits(wrong), false, wrong);
      assert.equal(isValidItalianVatNumber(wrong), false);
    }
    for (const value of ['', '0111460100', '011146010066', 'DE01114601006', 'IT0111460100A', ' 01114601006', 'IT 01114601006']) {
      assert.equal(isValidItalianVatNumber(value), false, value);
    }
    assert.equal(isValidItalianVatDigits('1111111111a'), false);
  });
});

describe('Italian fiscal code', () => {
  it('accepts a company code of eleven digits with the VAT check digit', () => {
    assert.ok(isValidItalianFiscalCode('01114601006'));
    assert.equal(isValidItalianFiscalCode('01114601007'), false);
  });
  it('accepts the published example codes of a person, with the check character', () => {
    for (const code of ['RSSMRA85T10A562S', 'MRTMTT91D08F205J', 'RSSMRA80A01H501U']) {
      assert.ok(isValidItalianFiscalCode(code), code);
      assert.ok(isValidItalianFiscalCodeOfPerson(code));
    }
  });
  it('accepts the homonymy letters in the place of digits when the check character is computed on the letters', () => {
    // RSSMRA85T10A562S with the last digit of the number written as its letter (2 is N): the check character changes with it.
    assert.equal(isValidItalianFiscalCode('RSSMRA85T10A56NH'), true);
    assert.equal(isValidItalianFiscalCode('RSSMRA85T10A56NS'), false);
  });
  it('refuses a wrong check character, a wrong shape, lower case and a wrong length', () => {
    for (const code of ['RSSMRA85T10A562T', 'RSSMRA85T10A562', 'RSSMRA85T10A562SS', 'rssmra85t10a562s', 'RSSMRA85X10A562S', '1SSMRA85T10A562S', 'RSSMRA8ST10A562S', '']) {
      assert.equal(isValidItalianFiscalCode(code), false, code);
    }
  });
});

describe('IBAN', () => {
  const VALID = ['IT60X0542811101000000123456', 'GB82WEST12345698765432', 'DE89370400440532013000', 'FR1420041010050500013M02606', 'CH9300762011623852957'];
  it('normalizes spaces and case', () => {
    assert.equal(normalizeIban(' it60 X054 2811 1010 0000 0123 456 '), 'IT60X0542811101000000123456');
  });
  it('accepts the published example IBANs', () => {
    for (const iban of VALID) {
      assert.ok(isValidIban(iban), iban);
    }
  });
  it('refuses a wrong checksum, a wrong shape and an Italian one of the wrong length or shape', () => {
    for (const iban of ['IT60X0542811101000000123457', 'GB82WEST12345698765433', 'DE89370400440532013001']) {
      assert.equal(isValidIban(iban), false, iban);
    }
    for (const iban of ['', 'IT60', 'it60x0542811101000000123456', '1T60X0542811101000000123456', 'IT6AX0542811101000000123456', 'GB82WEST1234569876543', `GB82${'1'.repeat(31)}`]) {
      assert.equal(isValidIban(iban), false, iban);
    }
    // Italian: the 27 characters with a letter (CIN) after the check digits and ten digits.
    assert.equal(isValidIban('IT60X054281110100000012345'), false);
    assert.equal(isValidIban('IT601054281110100000012345678'), false);
  });
});

describe('the other bank and e-invoice codes', () => {
  it('checks ABI and CAB (five digits)', () => {
    assert.ok(isValidBankCode('05428') && isValidBankCode('11101'));
    for (const code of ['', '0542', '054281', '0542A', ' 5428']) {
      assert.equal(isValidBankCode(code), false, code);
    }
  });
  it('checks BIC (8 or 11 characters, upper case)', () => {
    for (const bic of ['DEUTDEFF', 'DEUTDEFF500', 'BCITITMM', 'UNCRITMMXXX', 'NEDSZAJJ']) {
      assert.ok(isValidBic(bic), bic);
    }
    for (const bic of ['', 'DEUTDEF', 'DEUTDEFF50', 'deutdeff', 'DEUT1EFF', 'DEUTDEFF5000']) {
      assert.equal(isValidBic(bic), false, bic);
    }
  });
  it('checks the recipient code (6 or 7 upper case letters or digits)', () => {
    for (const code of ['0000000', 'ABC1234', 'M5UXCR1', 'KRRH6B9', 'ABC123']) {
      assert.ok(isValidRecipientCode(code), code);
    }
    for (const code of ['', 'ABC12', 'ABC12345', 'abc1234', 'AB-1234']) {
      assert.equal(isValidRecipientCode(code), false, code);
    }
  });
  it('checks the share capital as a decimal text with at most two decimals', () => {
    for (const text of ['0', '10000', '10000.5', '10000.50', '999999999999999.99']) {
      assert.ok(isValidDecimalText(text), text);
    }
    for (const text of ['', '-1', '1,5', '1.234', '1.', '.5', '1e3', '1000000000000000']) {
      assert.equal(isValidDecimalText(text), false, text);
    }
  });
  it('checks calendar dates', () => {
    for (const date of ['2026-11-13', '2024-02-29', '1999-12-31']) {
      assert.ok(isValidCalendarDate(date), date);
    }
    for (const date of ['', '2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '13/11/2026', '2026-11-13T00:00:00Z']) {
      assert.equal(isValidCalendarDate(date), false, date);
    }
  });
  it('lists the tax regimes without RF03 and the provinces of the legacy form plus South Sardinia', () => {
    assert.equal(TAX_REGIMES.length, 18);
    assert.ok(TAX_REGIMES.includes('RF01') && TAX_REGIMES.includes('RF19') && !(TAX_REGIMES as readonly string[]).includes('RF03'));
    assert.equal(new Set(ITALIAN_PROVINCES).size, ITALIAN_PROVINCES.length);
    for (const code of ['MI', 'RM', 'TO', 'SU', 'VS', 'BT', 'MB']) {
      assert.ok((ITALIAN_PROVINCES as readonly string[]).includes(code), code);
    }
    assert.ok(ITALIAN_PROVINCES.every((code) => /^[A-Z]{2}$/.test(code)));
  });
});
