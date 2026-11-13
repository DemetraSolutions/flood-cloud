import { withCurrent } from './company-options';

describe('withCurrent', () => {
  const options = [{ value: 'a', label: 'A' }];

  it('keeps the options when the value is among them or empty', () => {
    expect(withCurrent(options, 'a', () => 'x')).toEqual(options);
    expect(withCurrent(options, '', () => 'x')).toEqual(options);
  });

  it('adds the stored value with its own label when the options lack it', () => {
    expect(withCurrent(options, 'b', (value) => `other ${value}`)).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'other b' },
    ]);
  });
});
