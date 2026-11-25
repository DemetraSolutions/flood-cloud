import { readFileSync } from 'node:fs';
import { flattenDictionary } from '../../core/i18n/dictionary';
import { CARD_SECTIONS } from './fidelity-card-page';
import { MOVEMENT_TYPES } from './fidelity-card.types';

/** Keys the pages build at runtime, which the key scan cannot see. */
const dictionary = flattenDictionary(
  JSON.parse(readFileSync(`${process.cwd()}/public/i18n/it.json`, 'utf8')),
);

function has(keys: readonly string[]): void {
  const missing = keys.filter((key) => !dictionary.get(key));
  expect(missing).toEqual([]);
}

describe('fidelity card texts', () => {
  it('has the name of every type of movement and the one for any other', () => {
    has(
      [...MOVEMENT_TYPES, 'other'].map(
        (type) => `FIDELITY_CARDS.MOVEMENT.TYPE_${type.toUpperCase()}`,
      ),
    );
    expect(MOVEMENT_TYPES).toEqual(['manually', 'import', 'sale', 'canceled_sale']);
  });

  it('has the tabs of the page', () => {
    expect(CARD_SECTIONS).toEqual(['general', 'movements']);
    has(CARD_SECTIONS.map((section) => `FIDELITY_CARDS.SECTION.${section.toUpperCase()}`));
  });

  it('has the texts of the state filter', () => {
    has(['LABEL', 'ALL', 'ENABLED', 'DISABLED'].map((key) => `FIDELITY_CARDS.STATE.${key}`));
  });

  it('has the texts of the errors that have their own', () => {
    has([
      'FIDELITY_CARDS.ERROR.BALANCE_NOT_EMPTY',
      'FIDELITY_CARDS.ERROR.KEY_PENDING',
      'FIDELITY_CARDS.ADJUST.AMOUNT_MONEY',
      'FIDELITY_CARDS.ADJUST.AMOUNT_POINTS',
      'FIDELITY_CARDS.ADJUST.AMOUNT_HINT',
      'FIDELITY_CARDS.ADJUST.AMOUNT_HINT_MONEY',
      'FIDELITY_CARDS.ADJUST.UNCERTAIN',
      'FIDELITY_CARDS.FIELD.CUSTOMERS_NO_ACCESS',
    ]);
  });

  it('has the entry of the menu and the text of the references that stop a deletion', () => {
    has(['MENU.FIDELITY_CARDS', 'CATALOG.REFERENCED.FIDELITYCARDS']);
  });
});
