import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import { PRODUCT_REFERENCE_KINDS } from './product-errors';
import { PRODUCT_SECTIONS } from './product-page';
import { FAMILIES, FAMILY_ORDER, CHOICE_PRICE_RULES, MODIFIER_TYPES, MODULAR_PRICE_RULES, ProductType } from './product.types';

/** Keys the pages build at runtime, which the key scan cannot see. */
const dictionary = flattenDictionary(
  JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
);

function has(keys: readonly string[]): void {
  const missing = keys.filter((key) => !dictionary.get(key));
  expect(missing).toEqual([]);
}

const TYPES: readonly ProductType[] = ['product', 'service', 'exempt', 'tobaccos', 'games', 'monopoly'];

describe('product texts', () => {
  it('has the texts of every family', () => {
    has(
      FAMILY_ORDER.flatMap((family) =>
        ['TITLE', 'HINT', 'NEW', 'NEW_TITLE', 'EDIT_TITLE', 'EMPTY'].map((part) => `PRODUCTS.FAMILY.${FAMILIES[family].text}.${part}`),
      ),
    );
  });

  it('has the four texts of the families, as the code names them', () => {
    expect(FAMILY_ORDER.map((family) => FAMILIES[family].text).sort()).toEqual(['MODIFIERS', 'PRODUCTS', 'SERVICES', 'TOBACCOS']);
  });

  it('has the columns of the list', () => {
    has(['SELECT', 'CODE', 'NAME', 'STOCK', 'PRICE', 'LAST_SUPPLIER', 'UPDATED', 'STATE'].map((column) => `PRODUCTS.COLUMN.${column}`));
  });

  it('has the outcomes of the move to the trash', () => {
    has(['NOTFOUND', 'FORBIDDEN', 'ALREADYTRASHED', 'CONFLICT'].map((issue) => `PRODUCTS.TRASH.ISSUE.${issue}`));
  });

  it('has the units of the delivery time of a supplier', () => {
    has(['DAYS', 'MONTHS', 'YEARS'].map((unit) => `PRODUCTS.SUPPLIERS.UNIT_${unit}`));
  });

  it('has the tabs of the page', () => {
    has(PRODUCT_SECTIONS.map((section) => `PRODUCTS.SECTION.${section.toUpperCase()}`));
  });

  it('has the rules of the price of a composable product and of a group of choices', () => {
    has(MODULAR_PRICE_RULES.map((rule) => `PRODUCTS.COMPOSITION.RULE_${rule.toUpperCase()}`));
    has(CHOICE_PRICE_RULES.map((rule) => `PRODUCTS.CHOICES.RULE_${rule.toUpperCase()}`));
  });

  it('has the types of a product and of a modifier', () => {
    has(TYPES.map((type) => `PRODUCTS.TYPE.${type.toUpperCase()}`));
    has(MODIFIER_TYPES.map((type) => `PRODUCTS.MODIFIER.TYPE_${type.toUpperCase()}`));
  });

  it('has the text of each language of the names and the descriptions', () => {
    has(['NAME', 'SHORT_NAME', 'SHORT_DESCRIPTION', 'DESCRIPTION', 'MODIFIER_DESCRIPTION'].map((field) => `PRODUCTS.FIELD.${field}_IN`));
  });

  it('has the text of each kind of reference that stops a deletion', () => {
    has(PRODUCT_REFERENCE_KINDS.map((kind) => `PRODUCTS.REFERENCE.${kind}`));
  });

  it('has the forms of cost and the bases of the margin', () => {
    has(['LAST', 'AVERAGE', 'WEIGHTED_AVERAGE'].map((cost) => `PRODUCTS.STOCK.COST_${cost}`));
    has(['SIMPLE', 'LAST', 'AVERAGE', 'WEIGHTED_AVERAGE'].map((basis) => `PRODUCTS.MARGIN.BASIS_${basis}`));
  });

  it('has the texts the trash needs for the products', () => {
    has(['TRASH.KIND.PRODUCTS', 'TRASH.COLUMN.CODE', 'TRASH.COLUMN.FAMILY', 'TRASH.ISSUE.REFERENCED_PRODUCTS']);
  });

  it('has the entries of the menu', () => {
    has(['PRODUCTS_LIST', 'SERVICES_LIST', 'MODIFIERS_LIST', 'TOBACCO_PRODUCTS_LIST'].map((entry) => `MENU.${entry}`));
  });
});
