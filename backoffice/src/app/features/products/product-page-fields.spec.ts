import { formPath, sectionOf } from './product-page';

describe('sectionOf', () => {
  it.each([
    ['barcodes.0.value', 'barcodes'],
    ['prices.1.net', 'prices'],
    ['categoryIds.2', 'categories'],
    ['places.0.placeId', 'availability'],
    ['requiredModifierIds', 'variants'],
    ['modifierIds.1', 'variants'],
    ['excludedModifierIds.0', 'variants'],
    ['modifierCategoryIds', 'variants'],
    ['printStations.x', 'stations'],
    ['counterPrintStations.x.0', 'stations'],
    ['stock.p.s.min', 'stock'],
    ['attributeIds.0', 'attributes'],
    ['components.0.productId', 'composition'],
    ['menu.0.categoryId', 'composition'],
    ['modifierChoices.0', 'composition'],
    ['modularPriceRule', 'composition'],
    ['image', 'media'],
    ['gallery.3', 'media'],
    ['internalFileName', 'media'],
    ['externalUrl', 'media'],
    ['simpleCost', 'margin'],
    ['suppliers.0.contactId', 'suppliers'],
    ['shipping.width', 'shipping'],
    ['code', 'general'],
    ['name.it', 'general'],
    ['isModifier', 'general'],
    ['anything', 'general'],
  ])('puts the field %s in the tab %s', (field, section) => {
    expect(sectionOf(field)).toBe(section);
  });
});

describe('formPath', () => {
  it.each([
    ['places.0.placeId', 'local.places'],
    ['places', 'local.places'],
    ['printStations.x', 'local.stations'],
    ['counterPrintStations.x.0', 'local.stations'],
    ['stock.p.s.min', 'local.stock'],
    ['barcodes.0.value', 'core.barcodes'],
    ['prices.1', 'core.prices'],
    ['components.0.productId', 'core.components'],
    ['menu.0', 'core.menu'],
    ['modifierChoices.2.productIds', 'core.modifierChoices'],
    ['suppliers.0.priceLists.1.id', 'core.suppliers'],
    ['gallery.4', 'core.gallery'],
    ['name', 'core.name.it'],
    ['shortName', 'core.shortName.it'],
    ['description', 'core.description.it'],
    ['shortDescription', 'core.shortDescription.it'],
    ['name.en', 'core.name.en'],
    ['isModifier', 'core.type'],
    ['code', 'core.code'],
    ['availability.pos', 'core.availability.pos'],
    ['toString', 'core.toString'],
  ])('puts the field %s on the path %s', (field, path) => {
    expect(formPath(field, 'it')).toBe(path);
  });

  it('puts a text without a language on the one required', () => {
    expect(formPath('name', 'en')).toBe('core.name.en');
  });
});
