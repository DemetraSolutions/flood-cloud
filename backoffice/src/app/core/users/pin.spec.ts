import { PIN_PATTERN } from './pin';

describe('PIN_PATTERN', () => {
  it.each(['123', '1234', '123456', '000'])('accepts %s', (pin) => {
    expect(PIN_PATTERN.test(pin)).toBe(true);
  });

  it.each(['', '12', '1234567', '12a4', ' 123', '123 ', '12.3'])('rejects "%s"', (pin) => {
    expect(PIN_PATTERN.test(pin)).toBe(false);
  });
});
