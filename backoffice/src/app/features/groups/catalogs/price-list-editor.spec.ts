import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { PriceList } from './catalog.types';
import { PriceListEditor } from './price-list-editor';

const NAME = 'CATALOG.PRICE_LISTS.FIELD.NAME';
const ENABLED = 'CATALOG.PRICE_LISTS.FIELD.ENABLED';
const DEFAULT = 'CATALOG.PRICE_LISTS.FIELD.DEFAULT';
const LIST: PriceList = { id: 'p1', name: 'Retail', enabled: true, isDefault: false };

const render = (inputs: Record<string, unknown> = {}) => renderEditor(PriceListEditor, inputs);

afterEach(cleanUpEditor);

describe('PriceListEditor: creation', () => {
  it('starts enabled and not standard', async () => {
    const { control } = await render();
    expect((control(ENABLED) as HTMLInputElement).checked).toBe(true);
    expect((control(DEFAULT) as HTMLInputElement).checked).toBe(false);
  });

  it('sends name and enabled flag, without the standard flag when off', async () => {
    const { type, submit, saved } = await render();
    await type(NAME, '  Wholesale ');
    await submit();
    expect(saved).toEqual([{ name: 'Wholesale', enabled: true }]);
  });

  it('sends the standard flag when it is on', async () => {
    const { type, check, submit, saved } = await render();
    await type(NAME, 'Wholesale');
    await check(ENABLED, false);
    await check(DEFAULT, true);
    await submit();
    expect(saved).toEqual([{ name: 'Wholesale', enabled: false, isDefault: true }]);
  });

  it('requires a name and does not save without it', async () => {
    const { submit, saved, error } = await render();
    await submit();
    expect(saved).toEqual([]);
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('rejects a name longer than 100 characters', async () => {
    const { type, submit, saved, error } = await render();
    await type(NAME, 'x'.repeat(101));
    await submit();
    expect(saved).toEqual([]);
    expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });

  it('disables cancel while saving', async () => {
    const { cancel } = await render({ busy: true });
    expect(cancel().disabled).toBe(true);
  });
});

describe('PriceListEditor: modification', () => {
  it('cannot be saved without changes', async () => {
    const { save, set, type } = await render({ item: LIST });
    expect(save().disabled).toBe(true);
    await type(NAME, 'Retail  ');
    expect(save().disabled).toBe(true);
    await type(NAME, 'Retail 2');
    expect(save().disabled).toBe(false);
    await set({ item: LIST });
  });

  it('sends only what changed', async () => {
    const { type, check, submit, saved } = await render({ item: LIST });
    await type(NAME, 'Outlet');
    await submit();
    await check(ENABLED, false);
    await submit();
    await check(DEFAULT, true);
    await submit();
    expect(saved).toEqual([
      { name: 'Outlet' },
      { name: 'Outlet', enabled: false },
      { name: 'Outlet', enabled: false, isDefault: true },
    ]);
  });

  it('cannot turn the standard flag off on the standard list', async () => {
    const { control } = await render({ item: { ...LIST, isDefault: true } });
    expect((control(DEFAULT) as HTMLInputElement).disabled).toBe(true);
  });

  it('does not send the flag of a list that is already the standard one', async () => {
    const { check, submit, saved } = await render({ item: { ...LIST, isDefault: true } });
    await check(ENABLED, false);
    await submit();
    expect(saved).toEqual([{ enabled: false }]);
  });
});

describe('PriceListEditor: server errors', () => {
  it('shows the rejection of a field under it', async () => {
    const { error, formError } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'name', issue: 'taken' }]),
    });
    expect(error(NAME)).toBe('FORM.ISSUE.TAKEN');
    expect(formError()).toBeNull();
  });

  it('shows the details that fit no field, and errors without details, on the form', async () => {
    const { formError, set } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'zzz', issue: 'last' }]),
    });
    expect(formError()).toBe('CATALOG.ERROR.LAST');
    await set({ error: apiError('CONFLICT') });
    expect(formError()).toBe('CATALOG.ERROR.CONCURRENT');
  });
});

describe('PriceListEditor: touching the fields', () => {
  it('shows the validation errors of the fields left empty', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBeGreaterThan(0);
  });
});
