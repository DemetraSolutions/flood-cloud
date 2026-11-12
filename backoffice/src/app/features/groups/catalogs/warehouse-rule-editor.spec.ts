import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { WarehouseRule } from './catalog.types';
import { WarehouseRuleEditor } from './warehouse-rule-editor';

const P = 'CATALOG.WAREHOUSE_RULES.FIELD.';
const TYPE = `${P}TYPE`;
const NAME = `${P}NAME`;
const QUANTITY = `${P}QUANTITY`;
const VALUE = `${P}VALUE`;
const COUNTERPART = `${P}COUNTERPART`;
const USE_LOAD_UNIT = `${P}USE_LOAD_UNIT`;
const CASH_UNLOAD = `${P}CASH_UNLOAD`;
const CASH_LOAD = `${P}CASH_LOAD`;

const LOAD: WarehouseRule = {
  id: 'w1',
  type: 'load',
  name: 'Purchase',
  quantity: '+',
  value: '+',
  useLoadUnit: false,
  counterpart: 'suppliers',
  isDefault: false,
  cashLoad: false,
  cashUnload: false,
};
const UNLOAD: WarehouseRule = {
  ...LOAD,
  id: 'w2',
  type: 'unload',
  name: 'Sale',
  quantity: '-',
  value: '=',
  counterpart: 'customers',
};
const render = (inputs: Record<string, unknown> = {}) => renderEditor(WarehouseRuleEditor, inputs);

afterEach(cleanUpEditor);

describe('WarehouseRuleEditor: creation', () => {
  it('starts as a load from suppliers', async () => {
    const { control, root } = await render();
    expect((control(TYPE) as HTMLSelectElement).value).toBe('load');
    expect((control(QUANTITY) as HTMLSelectElement).value).toBe('+');
    expect((control(VALUE) as HTMLSelectElement).value).toBe('+');
    expect((control(COUNTERPART) as HTMLSelectElement).value).toBe('suppliers');
    expect(root.textContent).toContain(CASH_LOAD);
    expect(root.textContent).not.toContain(USE_LOAD_UNIT);
  });

  it('labels the options of the selects', async () => {
    const { control } = await render();
    const labels = (label: string) =>
      [...(control(label) as HTMLSelectElement).options].map((o) => o.textContent?.trim());
    expect(labels(TYPE)).toEqual([
      'CATALOG.WAREHOUSE_RULES.TYPE.LOAD',
      'CATALOG.WAREHOUSE_RULES.TYPE.UNLOAD',
    ]);
    expect(labels(QUANTITY)).toEqual([
      'CATALOG.WAREHOUSE_RULES.SIGN.KEEP',
      'CATALOG.WAREHOUSE_RULES.SIGN.ADD',
      'CATALOG.WAREHOUSE_RULES.SIGN.SUBTRACT',
    ]);
    expect(labels(COUNTERPART)).toEqual([
      'CATALOG.WAREHOUSE_RULES.COUNTERPART.SUPPLIERS',
      'CATALOG.WAREHOUSE_RULES.COUNTERPART.CUSTOMERS',
      'CATALOG.WAREHOUSE_RULES.COUNTERPART.INDOOR',
    ]);
  });

  it('sends the whole rule without false flags', async () => {
    const { type, submit, saved } = await render();
    await type(NAME, ' Purchase ');
    await submit();
    expect(saved).toEqual([
      { type: 'load', name: 'Purchase', quantity: '+', value: '+', counterpart: 'suppliers' },
    ]);
  });

  it('sends the flag of a load', async () => {
    const { type, check, submit, saved } = await render();
    await type(NAME, 'Return');
    await check(CASH_LOAD, true);
    await submit();
    expect(saved).toEqual([
      {
        type: 'load',
        name: 'Return',
        quantity: '+',
        value: '+',
        counterpart: 'suppliers',
        cashLoad: true,
      },
    ]);
  });

  it('offers the flags of an unload and drops the one of a load when the type changes', async () => {
    const { type, check, submit, saved, root } = await render();
    await type(NAME, 'Sale');
    await check(CASH_LOAD, true);
    await type(TYPE, 'unload');
    expect(root.textContent).not.toContain(CASH_LOAD);
    expect(root.textContent).toContain(USE_LOAD_UNIT);
    await type(QUANTITY, '-');
    await type(VALUE, '=');
    await type(COUNTERPART, 'indoor');
    await check(USE_LOAD_UNIT, true);
    await check(CASH_UNLOAD, true);
    await submit();
    expect(saved).toEqual([
      {
        type: 'unload',
        name: 'Sale',
        quantity: '-',
        value: '=',
        counterpart: 'indoor',
        useLoadUnit: true,
        cashUnload: true,
      },
    ]);
  });

  it('requires a name of at most 100 characters', async () => {
    const { type, submit, saved, error } = await render();
    await submit();
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    await type(NAME, 'x'.repeat(101));
    await submit();
    expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(saved).toEqual([]);
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });

  it('shows the errors of the fields left invalid once they lose the focus', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span')).toHaveLength(1);
  });

  it('marks the flags of an unload as touched on blur too', async () => {
    const { blurAll, type, root } = await render();
    await type(TYPE, 'unload');
    await blurAll();
    expect(root.querySelectorAll('.error span')).toHaveLength(1);
  });
});

describe('WarehouseRuleEditor: modification', () => {
  it('shows the rule and does not let the type change', async () => {
    const { control, save } = await render({ item: LOAD });
    expect((control(NAME) as HTMLInputElement).value).toBe('Purchase');
    expect((control(TYPE) as HTMLSelectElement).disabled).toBe(true);
    expect(save().disabled).toBe(true);
  });

  it('sends only what changed in a load', async () => {
    const { type, check, submit, saved } = await render({ item: LOAD });
    await type(NAME, 'Purchase 2');
    await type(QUANTITY, '=');
    await type(VALUE, '-');
    await type(COUNTERPART, 'indoor');
    await check(CASH_LOAD, true);
    await submit();
    expect(saved).toEqual([
      { name: 'Purchase 2', quantity: '=', value: '-', counterpart: 'indoor', cashLoad: true },
    ]);
  });

  it('sends only what changed in an unload', async () => {
    const { check, submit, saved, save } = await render({
      item: { ...UNLOAD, useLoadUnit: true },
    });
    expect(save().disabled).toBe(true);
    await check(USE_LOAD_UNIT, false);
    await check(CASH_UNLOAD, true);
    await submit();
    expect(saved).toEqual([{ useLoadUnit: false, cashUnload: true }]);
  });

  it('fills in defaults for the values stored outside the allowed ones', async () => {
    const { control, type, submit, saved } = await render({
      item: { ...LOAD, type: null, quantity: null, value: null, counterpart: null },
    });
    expect((control(TYPE) as HTMLSelectElement).value).toBe('load');
    await type(NAME, 'Purchase 2');
    await submit();
    expect(saved).toEqual([
      { name: 'Purchase 2', quantity: '+', value: '+', counterpart: 'suppliers' },
    ]);
  });
});

describe('WarehouseRuleEditor: server errors', () => {
  it('shows the rejection of a field under it', async () => {
    const { error, formError } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'name', issue: 'taken' }]),
    });
    expect(error(NAME)).toBe('FORM.ISSUE.TAKEN');
    expect(formError()).toBeNull();
  });

  it('shows what fits no field, or has no details, on the form', async () => {
    const { formError, set } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'cashLoad', issue: 'taken' }]),
    });
    expect(formError()).toBeNull();
    await set({ error: apiError('VALIDATION_ERROR', [{ field: 'zzz', issue: 'notAllowed' }]) });
    expect(formError()).toBe('CATALOG.ERROR.NOT_ALLOWED');
    await set({ error: apiError('CONFLICT') });
    expect(formError()).toBe('CATALOG.ERROR.CONCURRENT');
  });
});
