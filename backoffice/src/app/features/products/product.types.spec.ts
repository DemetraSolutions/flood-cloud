import { FAMILIES, FAMILY_ORDER, featuresOf, PRODUCT_FEATURES, productRoute } from './product.types';

describe('product families', () => {
  it('has the four families, in the order of the menu, each with the types of its own', () => {
    expect(FAMILY_ORDER).toEqual(['products', 'services', 'modifiers', 'tgm']);
    expect(FAMILY_ORDER.map((family) => FAMILIES[family].segment)).toEqual([
      'products',
      'services',
      'product-modifiers',
      'tobacco-products',
    ]);
    expect(FAMILIES.products).toMatchObject({ types: ['product', 'exempt'], feature: null, modifier: false });
    expect(FAMILIES.services).toMatchObject({ types: ['service'], feature: 'services', defaultType: 'service' });
    expect(FAMILIES.modifiers).toMatchObject({ feature: 'productsVariants', modifier: true });
    expect(FAMILIES.tgm).toMatchObject({
      types: ['tobaccos', 'games', 'monopoly'],
      feature: 'tobaccosGamesMonopoly',
      defaultType: 'tobaccos',
    });
  });

  it('offers as the default type one of the types of the family', () => {
    for (const family of FAMILY_ORDER) {
      expect(FAMILIES[family].types).toContain(FAMILIES[family].defaultType);
    }
  });
});

describe('featuresOf', () => {
  it('reads every feature a product depends on', () => {
    const asked: string[] = [];
    const features = featuresOf((name) => {
      asked.push(name);
      return name === 'cash' || name === 'media';
    });
    expect(asked).toEqual([...PRODUCT_FEATURES]);
    expect(Object.keys(features)).toEqual([...PRODUCT_FEATURES]);
    expect(features.cash).toBe(true);
    expect(features.media).toBe(true);
    expect(features.warehouse).toBe(false);
  });
});

describe('productRoute', () => {
  it('is the list of the family without a product', () => {
    expect(productRoute('g1', 'services')).toEqual(['/groups', 'g1', 'services']);
    expect(productRoute('g1', 'modifiers')).toEqual(['/groups', 'g1', 'product-modifiers']);
  });

  it('is the page of a new product for null and the page of a product for an id', () => {
    expect(productRoute('g1', 'tgm', null)).toEqual(['/groups', 'g1', 'tobacco-products', 'new']);
    expect(productRoute('g1', 'products', 'p1')).toEqual(['/groups', 'g1', 'products', 'p1']);
  });
});
