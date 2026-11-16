import { TestBed } from '@angular/core/testing';
import { backend } from '../../../testing/api';
import { CATEGORY_1, CATEGORY_2, LIST_2, fakePlace, renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failPut,
  fieldsetOf,
  isChecked,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  typeWithin,
  withValue,
  within,
} from '../../../testing/places-tabs';
import { I18nService } from '../../core/i18n/i18n.service';
import { languageName } from '../groups/languages';

const f = (key: string) => `PLACES.F.KIOSK.${key}`;
const col = (key: string, row: number) => `PLACES.KIOSK.${key} ${row}`;
const TEXT = (name: string) => `PLACES.KIOSK.TEXT.${name}`;
const NAMES = [
  'TITLE_TEXT',
  'SUB_TITLE_TEXT',
  'START_BUTTON_TEXT',
  'EAT_HERE_TEXT',
  'TAKE_AWAY_TEXT',
];
const lang = (code: string, locale = 'it') => `${languageName(code, locale)} (${code})`;
const NO_GROUP = ['places:read', 'places:update', 'products:read', 'profile:read'];

afterEach(cleanUp);

describe('PlaceKiosk', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'settings/kiosk' });
    expect(view.control(f('MODE')).value).toBe('sale');
    expect(view.control(f('LIST_ID')).value).toBe('');
    expect(view.control(f('BACKGROUND_COLOR')).type).toBe('color');
    expect(view.control(f('IDLE_TIME_ALERT')).type).toBe('number');
    expect(isChecked(view, f('EAT_HERE'))).toBe(false);
    expect(view.control(col('CATEGORY', 1)).value).toBe(CATEGORY_1);
    expect(view.control(col('POSITION', 1)).value).toBe('1');
    for (const name of NAMES) {
      expect(fieldsetOf(view.root, TEXT(name))).toBeDefined();
    }
    const title = fieldsetOf(view.root, TEXT('TITLE_TEXT'));
    expect(within(title, lang('it')).value).toBe('Benvenuti');
    expect(within(title, lang('en')).value).toBe('');
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'settings/kiosk' });
    await view.type(f('MODE'), 'catalog');
    await view.type(f('LIST_ID'), LIST_2);
    await view.type(f('UPSELLING_CATEGORY_ID'), CATEGORY_2);
    await view.toggle(f('EAT_HERE'), true);
    await view.type(f('TEXT_COLOR'), '#112233');
    await view.type(f('IDLE_TIME_ALERT'), '30');
    await view.type(col('CATEGORY', 1), CATEGORY_2);
    await view.type(col('POSITION', 1), '3');
    await typeWithin(view, fieldsetOf(view.root, TEXT('TITLE_TEXT')), lang('en'), 'Welcome');
    await typeWithin(view, fieldsetOf(view.root, TEXT('EAT_HERE_TEXT')), lang('it'), 'Qui');
    let block = withValue(storedBlock('kiosk'), 'mode', 'catalog');
    block = withValue(block, 'listId', LIST_2);
    block = withValue(block, 'upsellingCategoryId', CATEGORY_2);
    block = withValue(block, 'eatHere', true);
    block = withValue(block, 'textColor', '#112233');
    block = withValue(block, 'idleTimeAlert', 30);
    block = withValue(block, 'productsCategories', [{ _id: CATEGORY_2, position: 3 }]);
    block = withValue(block, 'titleText', { it: 'Benvenuti', en: 'Welcome' });
    block = withValue(block, 'eatHereText', { it: 'Qui' });
    await savePut(view, 'settings/kiosk', block);
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('adds and removes categories', async () => {
    const view = await renderPlace({ path: 'settings/kiosk' });
    await view.click('PLACES.KIOSK.ADD_CATEGORY');
    await view.type(col('CATEGORY', 2), CATEGORY_2);
    await savePut(
      view,
      'settings/kiosk',
      withValue(storedBlock('kiosk'), 'productsCategories', [
        { _id: CATEGORY_1, position: 1 },
        { _id: CATEGORY_2, position: null },
      ]),
    );
    (
      view.root.querySelector('button[aria-label*="PLACES.REMOVE_ROW"]') as HTMLButtonElement
    ).click();
    await view.view();
    await savePut(
      view,
      'settings/kiosk',
      withValue(storedBlock('kiosk'), 'productsCategories', []),
      '"v2"',
    );
  });

  it('shows the texts once the dictionary of the interface is loaded', async () => {
    const view = await renderPlace({ path: 'settings/kiosk' });
    const i18n = TestBed.inject(I18nService);
    const loaded = i18n.use('it');
    backend().expectOne('/i18n/it.json').flush({});
    await loaded;
    await view.view();
    const title = fieldsetOf(view.root, TEXT('TITLE_TEXT'));
    expect(within(title, lang('it')).value).toBe('Benvenuti');
    expect(within(title, lang('en')).value).toBe('');
  });

  it('reads the languages with the lookup, so a user who cannot read the group sees them too, plus the stored ones', async () => {
    const stored = fakePlace();
    const place = fakePlace({
      kiosk: { ...stored.kiosk, titleText: { it: 'Ciao', de: 'Hallo' }, eatHereText: {} },
    });
    const view = await renderPlace({ path: 'settings/kiosk', permissions: NO_GROUP, place });
    const title = fieldsetOf(view.root, TEXT('TITLE_TEXT'));
    expect(title.querySelectorAll('input')).toHaveLength(3);
    expect(within(title, lang('de')).value).toBe('Hallo');
    const eat = fieldsetOf(view.root, TEXT('EAT_HERE_TEXT'));
    expect(eat.querySelectorAll('input')).toHaveLength(2);
    expect(within(eat, lang('it')).value).toBe('');
  });

  it('puts the 422 on the controls', async () => {
    const view = await renderPlace({ path: 'settings/kiosk' });
    await view.type(col('POSITION', 1), '9');
    await failPut(view, 'settings/kiosk', [
      { field: 'kiosk.productsCategories.0.position', issue: 'incorrect' },
      { field: 'kiosk.idleTimeAlert', issue: 'incorrect' },
      { field: 'kiosk.mode', issue: 'incorrect' },
    ]);
    expect(view.error(col('POSITION', 1))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(f('IDLE_TIME_ALERT'))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(f('MODE'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'settings/kiosk' });
    await submitTab(view);
    await view.blurAll();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'settings/kiosk', permissions: READ_ONLY });
    expect(view.control(f('MODE')).disabled).toBe(true);
    expect(view.control(col('POSITION', 1)).disabled).toBe(true);
    expect(within(fieldsetOf(view.root, TEXT('TITLE_TEXT')), lang('it')).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    expect(view.button('PLACES.KIOSK.ADD_CATEGORY')).toBeUndefined();
    expect(view.button('PLACES.REMOVE')).toBeUndefined();
  });
});
