import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { CurrencyEditor } from './currency-editor';

const CODE = 'CATALOG.CURRENCIES.FIELD.CODE';
const SYMBOL = 'CATALOG.CURRENCIES.FIELD.SYMBOL';
const render = (inputs: Record<string, unknown> = {}) => renderEditor(CurrencyEditor, inputs);

afterEach(cleanUpEditor);

describe('CurrencyEditor: creation', () => {
  it('sends code and symbol', async () => {
    const { type, submit, saved } = await render();
    await type(CODE, 'USD');
    await type(SYMBOL, '$');
    await submit();
    expect(saved).toEqual([{ code: 'USD', symbol: '$' }]);
  });

  it('requires both fields', async () => {
    const { submit, saved, error } = await render();
    await submit();
    expect(saved).toEqual([]);
    expect(error(CODE)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(SYMBOL)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('accepts only three upper-case letters as code', async () => {
    const { type, submit, saved, error } = await render();
    await type(SYMBOL, '$');
    await type(CODE, 'usd');
    await submit();
    expect(error(CODE)).toBe('FORM.ISSUE.PATTERN');
    await type(CODE, 'USDX');
    expect(error(CODE)).toBe('FORM.ISSUE.PATTERN');
    expect(saved).toEqual([]);
  });

  it('rejects a symbol longer than 8 characters', async () => {
    const { type, submit, saved, error } = await render();
    await type(CODE, 'USD');
    await type(SYMBOL, '123456789');
    await submit();
    expect(error(SYMBOL)).toBe('FORM.ISSUE.MAX_LENGTH');
    expect(saved).toEqual([]);
  });

  it.each(['<', '>', '&', '"', "'", '\u0007'])(
    'rejects the character %j in the symbol',
    async (char) => {
      const { type, submit, saved, error } = await render();
      await type(CODE, 'USD');
      await type(SYMBOL, `a${char}`);
      await submit();
      expect(error(SYMBOL)).toBe('FORM.ISSUE.PATTERN');
      expect(saved).toEqual([]);
    },
  );

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('CurrencyEditor: modification', () => {
  const item = { code: 'EUR', symbol: '€' };

  it('shows the code but does not let it change', async () => {
    const { control } = await render({ item });
    const code = control(CODE) as HTMLInputElement;
    expect(code.value).toBe('EUR');
    expect(code.disabled).toBe(true);
  });

  it('cannot be saved without changes', async () => {
    const { save, type } = await render({ item });
    expect(save().disabled).toBe(true);
    await type(SYMBOL, 'E');
    expect(save().disabled).toBe(false);
  });

  it('sends only the symbol', async () => {
    const { type, submit, saved } = await render({ item });
    await type(SYMBOL, 'E');
    await submit();
    expect(saved).toEqual([{ symbol: 'E' }]);
  });

  it('shows server errors on the field and on the form', async () => {
    const { error, formError, set } = await render({
      item,
      error: apiError('VALIDATION_ERROR', [{ field: 'symbol', issue: 'pattern' }]),
    });
    expect(error(SYMBOL)).toBe('FORM.ISSUE.PATTERN');
    await set({ error: apiError('VALIDATION_ERROR', [{ field: 'x', issue: 'tooMany' }]) });
    expect(formError()).toBe('CATALOG.ERROR.TOO_MANY');
  });
});

describe('CurrencyEditor: touching the fields', () => {
  it('shows the validation errors of the fields left empty', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBeGreaterThan(0);
  });
});
