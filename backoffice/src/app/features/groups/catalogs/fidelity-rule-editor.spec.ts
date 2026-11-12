import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { FidelityCardRule } from './catalog.types';
import { FidelityRuleEditor } from './fidelity-rule-editor';

const POINT = 'CATALOG.FIDELITY_CARD_RULES.FIELD.POINT_VALUE';
const DISCOUNT = 'CATALOG.FIDELITY_CARD_RULES.FIELD.DISCOUNT';
const RULE: FidelityCardRule = { currency: 'EUR', pointValue: 0.5, discountPercentage: 10 };
const EMPTY: FidelityCardRule = { currency: 'EUR', pointValue: null, discountPercentage: null };
const render = (inputs: Record<string, unknown> = {}) => renderEditor(FidelityRuleEditor, inputs);

afterEach(cleanUpEditor);

describe('FidelityRuleEditor', () => {
  it('shows the current values', async () => {
    const { control } = await render({ item: RULE });
    expect((control(POINT) as HTMLInputElement).value).toBe('0.5');
    expect((control(DISCOUNT) as HTMLInputElement).value).toBe('10');
  });

  it('cannot be saved without changes', async () => {
    const { save, type } = await render({ item: RULE });
    expect(save().disabled).toBe(true);
    await type(POINT, '1');
    expect(save().disabled).toBe(false);
  });

  it('cannot be saved without an element and without values', async () => {
    const { save, type } = await render();
    expect(save().disabled).toBe(true);
    await type(DISCOUNT, '5');
    expect(save().disabled).toBe(false);
  });

  it('sends both values', async () => {
    const { type, submit, saved } = await render({ item: RULE });
    await type(POINT, '2');
    await submit();
    expect(saved).toEqual([{ pointValue: 2, discountPercentage: 10 }]);
  });

  it('sends null for an emptied value', async () => {
    const { type, submit, saved } = await render({ item: RULE });
    await type(POINT, '');
    await type(DISCOUNT, '');
    await submit();
    expect(saved).toEqual([{ pointValue: null, discountPercentage: null }]);
  });

  it('detects a change of the discount alone and starts from empty values', async () => {
    const { control, save, type } = await render({ item: EMPTY });
    expect((control(POINT) as HTMLInputElement).value).toBe('');
    expect(save().disabled).toBe(true);
    await type(DISCOUNT, '3');
    expect(save().disabled).toBe(false);
  });

  it('rejects out-of-range values', async () => {
    const { type, submit, saved, error } = await render({ item: RULE });
    await type(POINT, '-1');
    await type(DISCOUNT, '101');
    await submit();
    expect(saved).toEqual([]);
    expect(error(POINT)).toBe('FORM.ISSUE.MINIMUM');
    expect(error(DISCOUNT)).toBe('FORM.ISSUE.MAXIMUM');
  });

  it('shows server errors on the fields and on the form', async () => {
    const { error, formError, set } = await render({
      item: RULE,
      error: apiError('VALIDATION_ERROR', [{ field: 'pointValue', issue: 'minimum' }]),
    });
    expect(error(POINT)).toBe('FORM.ISSUE.MINIMUM');
    await set({ error: apiError('CONFLICT') });
    expect(formError()).toBe('CATALOG.ERROR.CONCURRENT');
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render({ item: RULE });
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('FidelityRuleEditor: touching the fields', () => {
  it('shows the validation errors of the fields left invalid', async () => {
    const { blurAll, type, root } = await render({ item: RULE });
    await type(POINT, '-1');
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBe(1);
  });
});
