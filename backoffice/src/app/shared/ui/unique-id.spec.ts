import { uniqueId } from './unique-id';

describe('uniqueId', () => {
  it('returns different ids with the given prefix', () => {
    const first = uniqueId('fc-x');
    const second = uniqueId('fc-x');
    expect(first).toMatch(/^fc-x-\d+$/);
    expect(second).not.toBe(first);
  });
});
