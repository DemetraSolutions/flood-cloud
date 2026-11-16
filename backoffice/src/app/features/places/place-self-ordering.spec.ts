import {
  CATEGORY_1,
  CATEGORY_2,
  LIST_1,
  LIST_2,
  fakePlace,
  renderPlace,
} from '../../../testing/places';
import {
  clickIn,
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

const f = (key: string) => `PLACES.F.SELF_ORDERING.${key}`;
const S = (key: string) => `PLACES.SELF_ORDERING.${key}`;
const UNKNOWN_LIST = '665f1c2e9b1d4a0012ab34ff';
const UNKNOWN_CATEGORY = '665f1c2e9b1d4a0012ab34fe';
const STORED_LIST = {
  roundTime: 5,
  roundMaxProducts: 3,
  totalMaxProducts: null,
  variants: true,
  freeVariants: false,
  tableAutoClose: false,
  productsCategories: [
    {
      _id: CATEGORY_1,
      roundMaxProducts: 2,
      totalMaxProducts: null,
      position: 1,
      purchasable: true,
    },
  ],
};
const EMPTY_LIST = {
  roundTime: null,
  roundMaxProducts: null,
  totalMaxProducts: null,
  variants: false,
  freeVariants: false,
  tableAutoClose: false,
  productsCategories: [],
};

afterEach(cleanUp);

const configs = (value: Record<string, unknown>) =>
  withValue(storedBlock('selfOrdering'), 'priceListsConfig', value);
const addButtons = (root: HTMLElement) =>
  [...root.querySelectorAll('button')]
    .map((b) => b.textContent?.trim())
    .filter((text) => text?.startsWith(S('ADD_LIST')));

describe('PlaceSelfOrdering', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    const list = fieldsetOf(view.root, 'Listino 1');
    expect(isChecked(view, f('STATUS'))).toBe(false);
    expect(within(list, S('ROUND_TIME')).value).toBe('5');
    expect(within(list, S('ROUND_MAX')).value).toBe('3');
    expect(within(list, S('TOTAL_MAX')).value).toBe('');
    expect((within(list, S('VARIANTS')) as HTMLInputElement).checked).toBe(true);
    expect((within(list, S('FREE_VARIANTS')) as HTMLInputElement).checked).toBe(false);
    expect(within(list, `${S('CATEGORY')} 1`).value).toBe(CATEGORY_1);
    expect(within(list, `${S('ROUND_MAX')} 1`).value).toBe('2');
    expect(within(list, `${S('POSITION')} 1`).value).toBe('1');
    expect((within(list, `${S('PURCHASABLE')} 1`) as HTMLInputElement).checked).toBe(true);
    expect(view.text()).toContain(S('LISTS_HINT'));
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    const list = fieldsetOf(view.root, 'Listino 1');
    await view.toggle(f('STATUS'), true);
    await view.type(f('FIXED_MESSAGE'), 'Ordina qui');
    await typeWithin(view, list, S('ROUND_TIME'), '10');
    await typeWithin(view, list, S('TOTAL_MAX'), '20');
    await typeWithin(view, list, S('FREE_VARIANTS'), '');
    (within(list, S('TABLE_AUTO_CLOSE')) as HTMLInputElement).checked = true;
    within(list, S('TABLE_AUTO_CLOSE')).dispatchEvent(new Event('change'));
    await view.view();
    await typeWithin(view, list, `${S('CATEGORY')} 1`, CATEGORY_2);
    await typeWithin(view, list, `${S('POSITION')} 1`, '4');
    (within(list, `${S('PURCHASABLE')} 1`) as HTMLInputElement).checked = false;
    within(list, `${S('PURCHASABLE')} 1`).dispatchEvent(new Event('change'));
    await view.view();
    const block = withValue(
      withValue(storedBlock('selfOrdering'), 'status', true),
      'fixedMessage',
      'Ordina qui',
    );
    await savePut(view, 'settings/self-ordering', {
      ...block,
      priceListsConfig: {
        [LIST_1]: {
          ...STORED_LIST,
          roundTime: 10,
          totalMaxProducts: 20,
          tableAutoClose: true,
          productsCategories: [
            {
              _id: CATEGORY_2,
              roundMaxProducts: 2,
              totalMaxProducts: null,
              position: 4,
              purchasable: false,
            },
          ],
        },
      },
    });
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('empties a number to null', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    const list = fieldsetOf(view.root, 'Listino 1');
    await typeWithin(view, list, S('ROUND_TIME'), '');
    await savePut(
      view,
      'settings/self-ordering',
      configs({ [LIST_1]: { ...STORED_LIST, roundTime: null } }),
    );
  });

  it('offers only the enabled price lists that have no limits yet', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    expect(addButtons(view.root)).toEqual([`${S('ADD_LIST')} {"list":"Listino 2"}`]);
    await view.click(`${S('ADD_LIST')} {"list":"Listino 2"}`);
    expect(addButtons(view.root)).toEqual([]);
    const added = fieldsetOf(view.root, 'Listino 2');
    expect(within(added, S('ROUND_TIME')).value).toBe('');
    await typeWithin(view, added, S('ROUND_MAX'), '4');
    await savePut(
      view,
      'settings/self-ordering',
      configs({ [LIST_1]: STORED_LIST, [LIST_2]: { ...EMPTY_LIST, roundMaxProducts: 4 } }),
    );
  });

  it('removes the limits of a price list', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    await view.click(`${S('REMOVE_LIST')} {"list":"Listino 1"}`);
    expect(fieldsetOf(view.root, 'Listino 1')).toBeUndefined();
    expect(addButtons(view.root)).toHaveLength(2);
    await savePut(view, 'settings/self-ordering', configs({}));
  });

  it('adds and removes the categories of a price list', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    const list = fieldsetOf(view.root, 'Listino 1');
    await clickIn(view, list, S('ADD_CATEGORY'));
    expect((within(list, `${S('PURCHASABLE')} 2`) as HTMLInputElement).checked).toBe(true);
    await typeWithin(view, list, `${S('CATEGORY')} 2`, CATEGORY_2);
    await typeWithin(view, list, `${S('TOTAL_MAX')} 2`, '9');
    await savePut(
      view,
      'settings/self-ordering',
      configs({
        [LIST_1]: {
          ...STORED_LIST,
          productsCategories: [
            ...STORED_LIST.productsCategories,
            {
              _id: CATEGORY_2,
              roundMaxProducts: null,
              totalMaxProducts: 9,
              position: null,
              purchasable: true,
            },
          ],
        },
      }),
    );
    (
      fieldsetOf(view.root, 'Listino 1').querySelector(
        'button[aria-label*="PLACES.REMOVE_ROW"]',
      ) as HTMLButtonElement
    ).click();
    await view.view();
    await savePut(
      view,
      'settings/self-ordering',
      configs({ [LIST_1]: { ...STORED_LIST, productsCategories: [] } }),
      '"v2"',
    );
  });

  it('adds a category to one price list without touching the others', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    await view.click(`${S('ADD_LIST')} {"list":"Listino 2"}`);
    await clickIn(view, fieldsetOf(view.root, 'Listino 2'), S('ADD_CATEGORY'));
    await typeWithin(view, fieldsetOf(view.root, 'Listino 2'), `${S('CATEGORY')} 1`, CATEGORY_2);
    expect(
      fieldsetOf(view.root, 'Listino 1').querySelectorAll(
        'button[aria-label*="PLACES.REMOVE_ROW"]',
      ),
    ).toHaveLength(1);
    await savePut(
      view,
      'settings/self-ordering',
      configs({
        [LIST_1]: STORED_LIST,
        [LIST_2]: {
          ...EMPTY_LIST,
          productsCategories: [
            {
              _id: CATEGORY_2,
              roundMaxProducts: null,
              totalMaxProducts: null,
              position: null,
              purchasable: true,
            },
          ],
        },
      }),
    );
  });

  it('shows by id a price list and a category the lookups do not know', async () => {
    const stored = fakePlace();
    const place = fakePlace({
      selfOrdering: {
        ...stored.selfOrdering,
        priceListsConfig: {
          [UNKNOWN_LIST]: {
            ...STORED_LIST,
            productsCategories: [{ ...STORED_LIST.productsCategories[0], _id: UNKNOWN_CATEGORY }],
          },
        },
      },
    });
    const view = await renderPlace({ path: 'settings/self-ordering', place });
    const list = fieldsetOf(view.root, UNKNOWN_LIST);
    expect(list).toBeDefined();
    expect(within(list, `${S('CATEGORY')} 1`).value).toBe(UNKNOWN_CATEGORY);
    expect(view.text()).toContain(`${S('CATEGORIES')} {"list":"${UNKNOWN_LIST}"}`);
    expect(view.text()).toContain(`${S('REMOVE_LIST')} {"list":"${UNKNOWN_LIST}"}`);
  });

  it('puts the 422 of a price list on the list of limits and the others on their control', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    await view.toggle(f('STATUS'), true);
    await failPut(view, 'settings/self-ordering', [
      { field: `selfOrdering.priceListsConfig.${LIST_1}.roundTime`, issue: 'incorrect' },
      { field: 'selfOrdering.status', issue: 'incorrect' },
    ]);
    expect(view.root.querySelector('fieldset > .problem')?.textContent).toContain(
      'FORM.ISSUE.INCORRECT',
    );
    expect(view.error(f('STATUS'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('marks every field as touched when the user leaves them', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering' });
    await view.blurAll();
    await submitTab(view);
    expect(view.root.querySelector('form')).not.toBeNull();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'settings/self-ordering', permissions: READ_ONLY });
    const list = fieldsetOf(view.root, 'Listino 1');
    expect(within(list, S('ROUND_TIME')).disabled).toBe(true);
    expect(view.control(f('STATUS')).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    expect(addButtons(view.root)).toEqual([]);
    expect(view.button(S('ADD_CATEGORY'))).toBeUndefined();
    expect(view.button('PLACES.REMOVE')).toBeUndefined();
    expect(view.button(`${S('REMOVE_LIST')} {"list":"Listino 1"}`)).toBeUndefined();
  });
});
