/**
 * Normalises what the user types into an IBAN: letters and digits only, in capitals, in groups
 * of four separated by a space (spaces and other separators are accepted while typing).
 *
 * @param text What the user typed.
 */
export function formatIban(text: string): string {
  const compact = text.replace(/[^0-9a-z]/gi, '').toUpperCase();
  return compact.replace(/(.{4})(?=.)/g, '$1 ');
}

/** The IBAN without spaces, as the server stores it. */
export function compactIban(text: string): string {
  return text.replace(/\s+/g, '').toUpperCase();
}

/**
 * Whether an IBAN passes the ISO 13616 checksum (country, check digits, and the remainder of
 * the rearranged number modulo 97). A hint for the user only: the server decides.
 *
 * @param text IBAN with or without spaces.
 */
export function hasValidIbanChecksum(text: string): boolean {
  const iban = compactIban(text);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return false;
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = String(parseInt(char, 36));
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}
