import { apiError, cleanUpEditor, renderApiEditor } from '../../../../testing/catalog-editor';
import { Role } from '../../../core/session/session.types';
import { aCardType } from '../../../../testing/fidelity';
import { CardTypeBody, CardTypeEditor } from './card-type-editor';

const F = 'CATALOG.CARD_TYPES.FIELD';
const P = 'CATALOG.CARD_TYPES.PREPAID';
const NAME = `${F}.NAME`;
const ENABLED = `${F}.ENABLED`;
const DISCOUNT = `${F}.DISCOUNT`;
const PRICE_LIST = `${F}.PRICE_LIST`;
const PREPAID_ENABLED = `${P}.ENABLED`;
const PREPAID_TYPE = `${P}.TYPE`;
const PREPAID_TAX = `${P}.TAX`;
const POINTS_ENABLED = 'CATALOG.CARD_TYPES.POINTS.ENABLED';
const PRICE_LISTS_URL = '/v1/groups/g1/lookup/price-lists';
const COLLECTIONS_URL = '/v1/groups/g1/fidelity/points-collections';
const LISTS = { data: [{ id: 'pl1', name: 'Retail', enabled: true, isDefault: true }] };
const COLLECTIONS = {
  data: [
    { id: 'co1', name: 'Spring' },
    { id: 'co2', name: 'Winter' },
  ],
};

async function render(
  inputs: Record<string, unknown> = {},
  options: { role?: Role; names?: Record<string, string> } = {},
) {
  const rendered = await renderApiEditor<CardTypeBody, CardTypeEditor>(
    CardTypeEditor,
    { groupId: 'g1', ...inputs },
    options,
  );
  await rendered.answer(PRICE_LISTS_URL, LISTS);
  await rendered.answer(COLLECTIONS_URL, COLLECTIONS);
  return rendered;
}

afterEach(cleanUpEditor);

describe('CardTypeEditor: creation', () => {
  it('starts enabled, without discount, with a multi-use prepaid card switched off', async () => {
    const { control } = await render();
    expect((control(ENABLED) as HTMLInputElement).checked).toBe(true);
    expect((control(DISCOUNT) as HTMLInputElement).value).toBe('0');
    expect((control(PREPAID_ENABLED) as HTMLInputElement).checked).toBe(false);
    expect((control(PREPAID_TYPE) as HTMLSelectElement).value).toBe('multi');
  });

  it('sends the whole card type', async () => {
    const { type, submit, saved } = await render();
    await type(NAME, '  Gold ');
    await submit();
    expect(saved).toEqual([
      {
        name: 'Gold',
        enabled: true,
        discountPercentage: 0,
        priceListId: null,
        prepaid: { enabled: false, type: 'multi', taxPercentage: null },
        pointsCollect: { enabled: false, collectionIds: [] },
        placeIds: [],
      },
    ]);
  });

  it('sends the choices made', async () => {
    const { type, check, pick, submit, saved } = await render();
    await type(NAME, 'Gold');
    await type(DISCOUNT, '12.5');
    await type(PRICE_LIST, 'pl1');
    await check(PREPAID_ENABLED, true);
    await type(PREPAID_TYPE, 'mono');
    await type(PREPAID_TAX, '22');
    await check(POINTS_ENABLED, true);
    await pick('Winter');
    await pick('Centro');
    await submit();
    expect(saved).toEqual([
      {
        name: 'Gold',
        enabled: true,
        discountPercentage: 12.5,
        priceListId: 'pl1',
        prepaid: { enabled: true, type: 'mono', taxPercentage: 22 },
        pointsCollect: { enabled: true, collectionIds: ['co2'] },
        placeIds: ['p1'],
      },
    ]);
  });

  it('offers the price lists of the group', async () => {
    const { control } = await render();
    expect([...(control(PRICE_LIST) as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      '',
      'pl1',
    ]);
  });

  it('says so when the price lists or the collections cannot be read', async () => {
    const rendered = await renderApiEditor<CardTypeBody, CardTypeEditor>(CardTypeEditor, {
      groupId: 'g1',
    });
    await rendered.answer(PRICE_LISTS_URL, {}, 500);
    await rendered.answer(COLLECTIONS_URL, {}, 500);
    expect(rendered.root.textContent).toContain('CATALOG.CARD_TYPES.PRICE_LISTS_FAILED');
    expect(rendered.root.querySelector('[role=alert]')?.textContent?.trim()).toBe(
      'CATALOG.CARD_TYPES.POINTS.LOAD_FAILED',
    );
  });

  it('requires a name and a discount between 0 and 100', async () => {
    const { type, submit, saved, error } = await render();
    await submit();
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    await type(NAME, 'Gold');
    await type(DISCOUNT, '101');
    await submit();
    expect(error(DISCOUNT)).toBe('FORM.ISSUE.MAXIMUM');
    await type(DISCOUNT, '');
    await submit();
    expect(error(DISCOUNT)).toBe('FORM.ISSUE.REQUIRED');
    expect(saved).toEqual([]);
  });

  it('keeps the prepaid tax between 0 and 100, and optional', async () => {
    const { type, submit, saved, error } = await render();
    await type(NAME, 'Gold');
    await type(PREPAID_TAX, '-1');
    await submit();
    expect(error(PREPAID_TAX)).toBe('FORM.ISSUE.MINIMUM');
    await type(PREPAID_TAX, '');
    await submit();
    expect(saved).toHaveLength(1);
  });

  it('refuses more than 500 stores or 50 collections', async () => {
    const ids = (count: number) => Array.from({ length: count }, (_, n) => `id${n}`);
    const item = aCardType({
      placeIds: ids(501),
      pointsCollect: { enabled: true, collectionIds: ids(51) },
    });
    const { type, submit, saved, root } = await render({ item });
    await type(NAME, 'Other');
    await submit();
    expect(saved).toEqual([]);
    expect(root.textContent?.match(/FORM\.ISSUE\.TOO_MANY/g)).toHaveLength(2);
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('CardTypeEditor: modification', () => {
  it('cannot be saved without changes', async () => {
    const { save } = await render({ item: aCardType({ priceListId: 'pl1' }) });
    expect(save().disabled).toBe(true);
  });

  it('sends only what changed', async () => {
    const { type, check, submit, saved } = await render({ item: aCardType() });
    await type(NAME, 'Platinum');
    await submit();
    await check(ENABLED, false);
    await type(DISCOUNT, '7');
    await type(PRICE_LIST, 'pl1');
    await submit();
    expect(saved).toEqual([
      { name: 'Platinum' },
      { name: 'Platinum', enabled: false, discountPercentage: 7, priceListId: 'pl1' },
    ]);
  });

  it('sends the whole prepaid settings when one changes', async () => {
    const item = aCardType({ prepaid: { enabled: true, type: 'mono', taxPercentage: 4 } });
    const { type, submit, saved } = await render({ item });
    await type(PREPAID_TAX, '10');
    await submit();
    await type(PREPAID_TYPE, 'multi');
    await submit();
    expect(saved).toEqual([
      { prepaid: { enabled: true, type: 'mono', taxPercentage: 10 } },
      { prepaid: { enabled: true, type: 'multi', taxPercentage: 10 } },
    ]);
  });

  it('sends the whole points settings when one changes', async () => {
    const item = aCardType({ pointsCollect: { enabled: true, collectionIds: ['co1'] } });
    const { check, pick, submit, saved } = await render({ item });
    await pick('Winter');
    await submit();
    await check(POINTS_ENABLED, false);
    await submit();
    expect(saved).toEqual([
      { pointsCollect: { enabled: true, collectionIds: ['co1', 'co2'] } },
      { pointsCollect: { enabled: false, collectionIds: ['co1', 'co2'] } },
    ]);
  });

  it('sends the list of stores when it changes, and clears the price list with null', async () => {
    const item = aCardType({ placeIds: ['p1'], priceListId: 'pl1' });
    const { type, pick, submit, saved } = await render({ item });
    await pick('Nord');
    await type(PRICE_LIST, '');
    await submit();
    expect(saved).toEqual([{ priceListId: null, placeIds: ['p1', 'p2'] }]);
  });

  it('shows a price list that is not in the group any more, to replace it', async () => {
    const { control } = await render({ item: aCardType({ priceListId: 'gone' }) });
    const options = [...(control(PRICE_LIST) as HTMLSelectElement).options];
    expect(options.map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ['', 'CATALOG.CARD_TYPES.FIELD.NO_PRICE_LIST'],
      ['gone', 'CATALOG.CARD_TYPES.UNKNOWN_PRICE_LIST'],
      ['pl1', 'Retail'],
    ]);
  });

  it('offers "not indicated" for a prepaid card without a stored type', async () => {
    const { control } = await render({ item: aCardType() });
    expect([...(control(PREPAID_TYPE) as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      '',
      'multi',
      'mono',
    ]);
  });

  it('does not offer it when the card has a type', async () => {
    const { control } = await render({
      item: aCardType({ prepaid: { enabled: true, type: 'mono', taxPercentage: null } }),
    });
    expect([...(control(PREPAID_TYPE) as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      'multi',
      'mono',
    ]);
  });

  it('does not send a type for a prepaid card that has none', async () => {
    const { check, submit, saved } = await render({ item: aCardType() });
    await check(PREPAID_ENABLED, true);
    await submit();
    expect(saved).toEqual([{ prepaid: { enabled: true, taxPercentage: null } }]);
  });

  it('names the stores and collections the card type already has', async () => {
    const item = aCardType({
      placeIds: ['p1', 'gone'],
      pointsCollect: { enabled: true, collectionIds: ['co1'] },
    });
    const { chosen, reads } = await render({ item }, { names: { p1: 'Centro' } });
    expect(reads.placeNames).toHaveBeenCalledWith('g1', ['p1', 'gone']);
    expect(chosen('CATALOG.CARD_TYPES.FIELD.PLACES')).toEqual([
      'Centro',
      'REFERENCE_PICKER.UNKNOWN',
    ]);
    expect(chosen('CATALOG.CARD_TYPES.POINTS.COLLECTIONS')).toEqual(['Spring']);
  });
});

describe('CardTypeEditor: stores of a company or store administrator', () => {
  it('explains that the whole group is not allowed and requires a store', async () => {
    const { root, type, submit, saved, error } = await render({}, { role: 'PA' });
    expect(root.querySelector('[role=note]')?.textContent?.trim()).toBe(
      'CATALOG.PLACES_RESTRICTED',
    );
    await type(NAME, 'Gold');
    await submit();
    expect(saved).toEqual([]);
    expect(root.textContent).toContain('FORM.ISSUE.REQUIRED');
    expect(error(NAME)).toBe('');
  });

  it('saves once a store is chosen', async () => {
    const { type, pick, submit, saved } = await render({}, { role: 'CA' });
    await type(NAME, 'Gold');
    await pick('Centro');
    await submit();
    expect(saved).toHaveLength(1);
    expect(saved[0].placeIds).toEqual(['p1']);
  });

  it('only hints that no store means the whole group for those who may', async () => {
    const { root } = await render();
    expect(root.querySelector('[role=note]')).toBeNull();
    expect(root.textContent).toContain('CATALOG.CARD_TYPES.PLACES_HINT');
  });
});

describe('CardTypeEditor: reading only', () => {
  it('disables every field, offers only to close and saves nothing', async () => {
    const { root, saved, submit, cancelled, control } = await render({
      item: aCardType({ placeIds: ['p1'] }),
      readOnly: true,
    });
    for (const label of [NAME, ENABLED, DISCOUNT, PRICE_LIST, PREPAID_ENABLED, POINTS_ENABLED]) {
      expect((control(label) as HTMLInputElement).disabled).toBe(true);
    }
    expect(root.querySelector('button[type=submit]')).toBeNull();
    await submit();
    expect(saved).toEqual([]);
    [...root.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'COMMON.CLOSE')!
      .click();
    expect(cancelled()).toBe(1);
  });
});

describe('CardTypeEditor: server errors', () => {
  it('shows the rejection of a store on the stores field', async () => {
    const { root } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'placeIds.1', issue: 'incorrect' }]),
    });
    expect(root.textContent).toContain('FORM.ISSUE.INCORRECT');
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('shows the nested fields of the prepaid and points settings', async () => {
    const { error } = await render({
      error: apiError('VALIDATION_ERROR', [
        { field: 'prepaid.taxPercentage', issue: 'maximum' },
        { field: 'prepaid.type', issue: 'enum' },
        { field: 'pointsCollect.collectionIds.0', issue: 'incorrect' },
        { field: 'priceListId', issue: 'incorrect' },
      ]),
    });
    expect(error(PREPAID_TAX)).toBe('FORM.ISSUE.MAXIMUM');
    expect(error(PREPAID_TYPE)).toBe('FORM.ISSUE.ENUM');
    expect(error(PRICE_LIST)).toBe('FORM.ISSUE.INCORRECT');
  });

  it('explains a refusal without details on the form', async () => {
    const { formError } = await render({ error: apiError('FORBIDDEN') });
    expect(formError()).toBe('CATALOG.ERROR.FORBIDDEN');
  });

  it('keeps the validation errors of touched fields', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBeGreaterThan(0);
  });
});
