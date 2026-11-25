import { fidelityCardRoute } from './fidelity-card.types';

describe('fidelityCardRoute', () => {
  it('points to the list, to a card and to the page of a new one', () => {
    expect(fidelityCardRoute('g1')).toEqual(['/groups', 'g1', 'fidelity', 'cards']);
    expect(fidelityCardRoute('g1', 'c1')).toEqual(['/groups', 'g1', 'fidelity', 'cards', 'c1']);
    expect(fidelityCardRoute('g1', null)).toEqual(['/groups', 'g1', 'fidelity', 'cards', 'new']);
  });
});
