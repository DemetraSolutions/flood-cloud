import { compactIban, formatIban, hasValidIbanChecksum } from './iban';

describe('iban', () => {
  it('formats what is typed in capitals and groups of four', () => {
    expect(formatIban('it60x0542811101000000123456')).toBe('IT60 X054 2811 1010 0000 0123 456');
    expect(formatIban('IT60 X054-2811.1')).toBe('IT60 X054 2811 1');
    expect(formatIban('')).toBe('');
    expect(formatIban('IT60')).toBe('IT60');
  });

  it('compacts an IBAN written with spaces', () => {
    expect(compactIban('it60 X054 2811 1010 0000 0123 456')).toBe('IT60X0542811101000000123456');
  });

  it('checks the ISO 13616 checksum', () => {
    expect(hasValidIbanChecksum('IT60 X054 2811 1010 0000 0123 456')).toBe(true);
    expect(hasValidIbanChecksum('DE89370400440532013000')).toBe(true);
    expect(hasValidIbanChecksum('IT61X0542811101000000123456')).toBe(false);
    expect(hasValidIbanChecksum('IT60')).toBe(false);
    expect(hasValidIbanChecksum('')).toBe(false);
  });
});
