import { FEATURE_NAMES, featureTextKey } from './feature-catalog';

describe('feature catalog', () => {
  it('has the 15 features of the backend', () => {
    expect(FEATURE_NAMES).toHaveLength(15);
  });

  it('builds the dictionary keys from the camel-case names', () => {
    expect(featureTextKey('cash', 'LABEL')).toBe('FEATURE.CASH.LABEL');
    expect(featureTextKey('tobaccosGamesMonopoly', 'DESCRIPTION')).toBe(
      'FEATURE.TOBACCOS_GAMES_MONOPOLY.DESCRIPTION',
    );
  });
});
