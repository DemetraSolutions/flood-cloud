import { apiError, cleanUpEditor, renderApiEditor } from '../../../../testing/catalog-editor';
import { aPromotion } from '../../../../testing/fidelity';
import { Role } from '../../../core/session/session.types';
import { fromLocalInput } from './catalog-fields';
import { PromotionEditor } from './promotion-editor';

const F = 'CATALOG.PROMOTIONS.FIELD';
const NAME = `${F}.NAME`;
const CODE = `${F}.CODE`;
const START = `${F}.START_DATE`;
const END = `${F}.END_DATE`;
const MAX_TOTAL = `${F}.MAX_USES_TOTAL`;
const CURRENCY = `${F}.CURRENCY`;
const AMOUNT_TAX = `${F}.AMOUNT_TAX`;
const SEAT = `${F}.SEAT_EXCLUDED`;
const PRODUCTS_TYPE = `${F}.PRODUCTS_TYPE`;
const PRODUCTS_N = `${F}.PRODUCTS_N`;
const DISCOUNT_TYPE = `${F}.DISCOUNT_TYPE`;
const DISCOUNT_VALUE = `${F}.DISCOUNT_VALUE`;
const VALUE_TYPE = `${F}.DISCOUNT_VALUE_TYPE`;
const FREE = `${F}.FREE_SHIPPING`;
const PLACES = `${F}.PLACES`;
const CUSTOMERS = `${F}.CUSTOMERS`;
const PRODUCTS = `${F}.PRODUCTS`;
const ACTION_PRODUCTS = `${F}.ACTION_PRODUCTS`;
const ACTION_CATEGORIES = `${F}.ACTION_CATEGORIES`;

const render = (
  inputs: Record<string, unknown> = {},
  options: { role?: Role; names?: Record<string, string> } = {},
) =>
  renderApiEditor<Record<string, unknown>, PromotionEditor>(
    PromotionEditor,
    { groupId: 'g1', ...inputs },
    options,
  );

afterEach(cleanUpEditor);

const tabs = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];
const visiblePanels = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[role=tabpanel]')]
    .filter((panel) => !panel.hidden)
    .map((panel) => panel.id);

describe('PromotionEditor: sections', () => {
  it('has four sections that share one form, the first one showing', async () => {
    const { root } = await render();
    expect(tabs(root).map((tab) => tab.textContent?.trim())).toEqual([
      'CATALOG.PROMOTIONS.SECTION.GENERAL',
      'CATALOG.PROMOTIONS.SECTION.CONDITIONS',
      'CATALOG.PROMOTIONS.SECTION.PRODUCTS',
      'CATALOG.PROMOTIONS.SECTION.ACTIONS',
    ]);
    expect(visiblePanels(root)).toEqual(['promotion-panel-general']);
    expect(root.querySelectorAll('form')).toHaveLength(1);
  });

  it('shows the section of the tab chosen', async () => {
    const { root, view } = await render();
    tabs(root)[3].click();
    await view();
    expect(visiblePanels(root)).toEqual(['promotion-panel-actions']);
  });
});

describe('PromotionEditor: creation', () => {
  it('sends the defaults with the name', async () => {
    const { type, submit, saved } = await render();
    await type(NAME, ' Happy hour ');
    await submit();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: 'Happy hour',
      enabled: true,
      conditions: { currency: 'EUR', amountTax: 'tax_included', placeIds: [] },
      actions: { discountValueType: 'percentage', freeShipping: false },
    });
    expect(saved[0]['description']).toBeUndefined();
  });

  it('sends everything the user fills in, across the sections', async () => {
    const { type, check, pick, submit, saved } = await render();
    await type(NAME, 'Happy hour');
    await type(CODE, 'HAPPY');
    await pick('Centro', true, PLACES);
    await type(START, '2026-12-01T10:00');
    await type(END, '2026-12-31T10:00');
    await pick('Mario Rossi', true, CUSTOMERS);
    await pick('VIP');
    await type(MAX_TOTAL, '100');
    await type(CURRENCY, 'USD');
    await type(AMOUNT_TAX, 'tax_excluded');
    await check(SEAT, true);
    await type(PRODUCTS_TYPE, 'only_n');
    await type(PRODUCTS_N, '2');
    await pick('Caffè', true, PRODUCTS);
    await pick('Bar', true, 'CATALOG.PROMOTIONS.FIELD.CATEGORIES');
    await type(DISCOUNT_TYPE, 'on_products');
    await type(DISCOUNT_VALUE, '2.5');
    await type(VALUE_TYPE, 'amount');
    await pick('Cornetto', true, ACTION_PRODUCTS);
    await pick('Bar', true, ACTION_CATEGORIES);
    await check(FREE, true);
    await submit();
    expect(saved).toEqual([
      {
        name: 'Happy hour',
        enabled: true,
        code: 'HAPPY',
        conditions: {
          placeIds: ['p1'],
          startDate: fromLocalInput('2026-12-01T10:00'),
          endDate: fromLocalInput('2026-12-31T10:00'),
          customerIds: ['cu1'],
          contactGroupIds: ['cg1'],
          maxUsesTotal: 100,
          currency: 'USD',
          amountTax: 'tax_excluded',
          seatExcluded: true,
          serviceExcluded: false,
          tipExcluded: false,
          deliveryExcluded: false,
          products: { type: 'only_n', n: 2, qt: 1, productIds: ['prod1'] },
          categories: { n: 1, categoryIds: ['cat1'] },
        },
        actions: {
          discountType: 'on_products',
          discountValue: 2.5,
          discountValueType: 'amount',
          productIds: ['prod2'],
          categoryIds: ['cat1'],
          freeShipping: true,
        },
      },
    ]);
  });

  it('offers the choices of the server', async () => {
    const { control } = await render();
    const values = (label: string) =>
      [...(control(label) as HTMLSelectElement).options].map((o) => o.value);
    expect(values(AMOUNT_TAX)).toEqual(['', 'tax_included', 'tax_excluded']);
    expect(values(PRODUCTS_TYPE)).toEqual(['', 'only_n', 'all']);
    expect(values(`${F}.CATEGORIES_TYPE`)).toEqual(['', 'only_n']);
    expect(values(DISCOUNT_TYPE)).toEqual(['', 'on_total', 'on_products', 'on_categories']);
    expect(values(VALUE_TYPE)).toEqual(['percentage', 'amount']);
  });

  it('reads the stores, customers, groups, products and categories of the group', async () => {
    const { reads } = await render();
    expect(reads.places).toHaveBeenCalledWith('g1', { q: '', cursor: null });
    expect(reads.lookup.mock.calls.map((call) => call[1]).sort()).toEqual(
      [
        'contact-groups',
        'customers',
        'product-categories',
        'product-categories',
        'products',
        'products',
      ].sort(),
    );
  });

  it('shows a neutral label for a customer without a name, and lets choose it', async () => {
    const { pick, submit, type, saved } = await render();
    await type(NAME, 'Sale');
    await pick('CATALOG.NO_NAME_CUSTOMER', true, CUSTOMERS);
    await submit();
    expect((saved[0]['conditions'] as { customerIds: string[] }).customerIds).toEqual(['cu2']);
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('PromotionEditor: validation', () => {
  it('requires a name and says in which section there are errors', async () => {
    const { root, submit, saved, view } = await render();
    tabs(root)[3].click();
    await view();
    await submit();
    expect(saved).toEqual([]);
    expect(visiblePanels(root)).toEqual(['promotion-panel-general']);
    expect(tabs(root)[0].querySelector('fc-status-badge')?.textContent?.trim()).toContain(
      'TAB_LIST.ERRORS',
    );
    expect(tabs(root)[1].querySelector('fc-status-badge')).toBeNull();
    expect(root.contains(document.activeElement)).toBe(true);
  });

  it('opens the first section with an error, wherever it is', async () => {
    const { root, type, submit, view } = await render();
    await type(NAME, 'Sale');
    await type(DISCOUNT_VALUE, '150');
    await submit();
    await view();
    expect(visiblePanels(root)).toEqual(['promotion-panel-actions']);
    expect(tabs(root)[3].querySelector('fc-status-badge')).not.toBeNull();
  });

  it('keeps a percentage discount up to 100, an end after the start, and the length of the lists', async () => {
    const ids = Array.from({ length: 501 }, (_, n) => `id${n}`);
    const item = aPromotion({ conditions: { customerIds: ids } });
    const { type, submit, saved, error, root } = await render({ item });
    await type(NAME, 'Other');
    await type(START, '2026-12-02T10:00');
    await type(END, '2026-12-01T10:00');
    await type(CURRENCY, 'eur');
    await submit();
    expect(saved).toEqual([]);
    expect(error(END)).toBe('FORM.ISSUE.INCORRECT');
    expect(error(CURRENCY)).toBe('FORM.ISSUE.PATTERN');
    expect(root.textContent).toContain('FORM.ISSUE.TOO_MANY');
  });

  it('refuses a name or a code that is too long', async () => {
    const { type, submit, saved, error } = await render();
    await type(NAME, 'x'.repeat(201));
    await type(CODE, 'x'.repeat(51));
    await submit();
    expect(saved).toEqual([]);
    expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(error(CODE)).toBe('FORM.ISSUE.MAX_LENGTH');
  });
});

describe('PromotionEditor: modification', () => {
  const item = aPromotion({
    code: 'OLD',
    conditions: {
      placeIds: ['p1'],
      products: { type: 'only_n', n: 1, qt: 1, productIds: ['prod1'] },
    },
    actions: { productIds: ['prod2'] },
  });
  const names = { p1: 'Centro', prod1: 'Caffè', prod2: 'Cornetto' };

  it('cannot be saved without changes', async () => {
    const { save } = await render({ item }, { names });
    expect(save().disabled).toBe(true);
  });

  it('names what the promotion already holds, products of both sections in one read', async () => {
    const { reads, chosen } = await render({ item }, { names });
    expect(reads.placeNames).toHaveBeenCalledWith('g1', ['p1']);
    expect(reads.lookupNames).toHaveBeenCalledWith('g1', 'products', ['prod1', 'prod2']);
    expect(chosen(PLACES)).toEqual(['Centro']);
    expect(chosen(PRODUCTS)).toEqual(['Caffè']);
    expect(chosen(ACTION_PRODUCTS)).toEqual(['Cornetto']);
  });

  it('names the customers, contact groups and categories it already holds', async () => {
    const holding = aPromotion({
      conditions: {
        customerIds: ['cu1', 'cu2'],
        contactGroupIds: ['cg1'],
        categories: { type: 'only_n', n: 1, categoryIds: ['cat1'] },
      },
      actions: { categoryIds: ['cat2'] },
    });
    const { reads, chosen } = await render(
      { item: holding },
      { names: { cu1: 'Mario Rossi', cu2: '', cg1: 'VIP', cat1: 'Bar' } },
    );
    expect(reads.lookupNames).toHaveBeenCalledWith('g1', 'customers', ['cu1', 'cu2']);
    expect(reads.lookupNames).toHaveBeenCalledWith('g1', 'contact-groups', ['cg1']);
    expect(reads.lookupNames).toHaveBeenCalledWith('g1', 'product-categories', ['cat1', 'cat2']);
    expect(chosen(CUSTOMERS)).toEqual(['Mario Rossi', 'CATALOG.NO_NAME_CUSTOMER']);
    expect(chosen(`${F}.CONTACT_GROUPS`)).toEqual(['VIP']);
    expect(chosen(`${F}.CATEGORIES`)).toEqual(['Bar']);
    expect(chosen(ACTION_CATEGORIES)).toEqual(['REFERENCE_PICKER.UNKNOWN']);
  });

  it('sends only the changed fields, nested', async () => {
    const { type, pick, submit, saved } = await render({ item }, { names });
    await type(CODE, '');
    await type(PRODUCTS_N, '3');
    await type(DISCOUNT_VALUE, '15');
    await pick('Nord', true, PLACES);
    await submit();
    expect(saved).toEqual([
      {
        code: null,
        conditions: { placeIds: ['p1', 'p2'], products: { n: 3 } },
        actions: { discountValue: 15 },
      },
    ]);
  });
});

describe('PromotionEditor: stores of a company or store administrator', () => {
  it('explains the perimeter and requires a store', async () => {
    const { root, type, submit, saved, view } = await render({}, { role: 'CA' });
    tabs(root)[1].click();
    await view();
    expect(root.querySelector('[role=note]')?.textContent?.trim()).toBe(
      'CATALOG.PLACES_RESTRICTED',
    );
    await type(NAME, 'Sale');
    await submit();
    expect(saved).toEqual([]);
    expect(visiblePanels(root)).toEqual(['promotion-panel-conditions']);
    expect(tabs(root)[1].querySelector('fc-status-badge')).not.toBeNull();
  });

  it('saves once a store is chosen', async () => {
    const { type, pick, submit, saved } = await render({}, { role: 'PA' });
    await type(NAME, 'Sale');
    await pick('Centro', true, PLACES);
    await submit();
    expect(saved).toHaveLength(1);
  });

  it('only hints that no store means the whole group for the others', async () => {
    const { root } = await render();
    expect(root.querySelector('[role=note]')).toBeNull();
    expect(root.textContent).toContain('CATALOG.PROMOTIONS.PLACES_HINT');
  });
});

describe('PromotionEditor: reading only', () => {
  it('disables the fields, offers only to close and saves nothing', async () => {
    const { root, saved, submit, cancelled, control } = await render({
      item: aPromotion({ code: 'X' }),
      readOnly: true,
    });
    expect((control(NAME) as HTMLInputElement).disabled).toBe(true);
    expect((control(CODE) as HTMLInputElement).disabled).toBe(true);
    expect((control(AMOUNT_TAX) as HTMLSelectElement).disabled).toBe(true);
    expect(root.querySelector('button[type=submit]')).toBeNull();
    await submit();
    expect(saved).toEqual([]);
    [...root.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'COMMON.CLOSE')!
      .click();
    expect(cancelled()).toBe(1);
  });
});

describe('PromotionEditor: server errors', () => {
  it('puts the rejections on their fields and counts them in the tabs', async () => {
    const { root, error } = await render({
      error: apiError('VALIDATION_ERROR', [
        { field: 'conditions.endDate', issue: 'incorrect' },
        { field: 'conditions.products.productIds.2', issue: 'incorrect' },
        { field: 'actions.discountValue', issue: 'incorrect' },
        { field: 'name', issue: 'taken' },
      ]),
    });
    expect(error(NAME)).toBe('FORM.ISSUE.TAKEN');
    expect(error(END)).toBe('FORM.ISSUE.INCORRECT');
    expect(error(DISCOUNT_VALUE)).toBe('FORM.ISSUE.INCORRECT');
    expect(
      tabs(root).map((tab) => tab.querySelector('fc-status-badge')?.textContent?.trim() ?? ''),
    ).toEqual(Array(4).fill('TAB_LIST.ERRORS'));
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('explains a refusal outside the perimeter on the form', async () => {
    const { formError } = await render({ error: apiError('FORBIDDEN') });
    expect(formError()).toBe('CATALOG.ERROR.FORBIDDEN');
  });

  it('shows the errors of the fields touched', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBeGreaterThan(0);
  });
});
