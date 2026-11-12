import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { Tax } from './catalog.types';
import { TaxEditor } from './tax-editor';

const RATE = 'CATALOG.TAXES.FIELD.RATE';
const DEPARTMENT = 'CATALOG.TAXES.FIELD.DEPARTMENT';
const NATURE = 'CATALOG.TAXES.FIELD.VAT_NATURE';
const DESCRIPTION = 'CATALOG.TAXES.FIELD.DESCRIPTION';
const TAX: Tax = { id: 't1', rate: 22, department: 3, description: 'Ordinaria', vatNature: null };
const render = (inputs: Record<string, unknown> = {}) => renderEditor(TaxEditor, inputs);

afterEach(cleanUpEditor);

describe('TaxEditor: creation', () => {
  it('sends only the rate when nothing else is filled', async () => {
    const { type, submit, saved } = await render();
    await type(RATE, '22');
    await submit();
    expect(saved).toEqual([{ rate: 22 }]);
  });

  it('sends every filled field', async () => {
    const { type, submit, saved } = await render();
    await type(RATE, '0');
    await type(DEPARTMENT, '4');
    await type(DESCRIPTION, '  Esente ');
    await type(NATURE, 'N4');
    await submit();
    expect(saved).toEqual([{ rate: 0, department: 4, description: 'Esente', vatNature: 'N4' }]);
  });

  it('requires the rate', async () => {
    const { submit, saved, error } = await render();
    await submit();
    expect(saved).toEqual([]);
    expect(error(RATE)).toBe('FORM.ISSUE.REQUIRED');
  });

  it.each([
    [RATE, '-1', 'FORM.ISSUE.MINIMUM'],
    [RATE, '100.5', 'FORM.ISSUE.MAXIMUM'],
    [DEPARTMENT, '0', 'FORM.ISSUE.MINIMUM'],
    [DEPARTMENT, '100', 'FORM.ISSUE.MAXIMUM'],
    [DEPARTMENT, '1.5', 'FORM.ISSUE.TYPE'],
  ])('rejects %s = %s', async (label, value, message) => {
    const { type, submit, saved, error } = await render();
    await type(RATE, label === RATE ? value : '10');
    await type(DEPARTMENT, label === DEPARTMENT ? value : '');
    await submit();
    expect(saved).toEqual([]);
    expect(error(label)).toBe(message);
  });

  it('rejects a description longer than 200 characters', async () => {
    const { type, submit, saved, error } = await render();
    await type(RATE, '10');
    await type(DESCRIPTION, 'x'.repeat(201));
    await submit();
    expect(saved).toEqual([]);
    expect(error(DESCRIPTION)).toBe('FORM.ISSUE.MAX_LENGTH');
  });

  it('offers the official natures after an empty choice', async () => {
    const { control } = await render();
    const select = control(NATURE) as HTMLSelectElement;
    expect(select.options[0].textContent?.trim()).toBe('CATALOG.TAXES.FIELD.NO_VAT_NATURE');
    expect(select.options).toHaveLength(21);
    expect(select.options[1].textContent?.trim()).toBe('N1 - Operazioni escluse ex art. 15');
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });

  it('shows the errors of untouched fields once they lose the focus', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span')).toHaveLength(1);
  });
});

describe('TaxEditor: description of the VAT nature', () => {
  it('fills in the official description when the description is empty', async () => {
    const { type, control } = await render();
    await type(NATURE, 'N4');
    expect((control(DESCRIPTION) as HTMLInputElement).value).toBe('Operazioni esenti');
  });

  it('replaces the description of the previous nature', async () => {
    const { type, control } = await render();
    await type(NATURE, 'N4');
    await type(NATURE, 'N1');
    expect((control(DESCRIPTION) as HTMLInputElement).value).toBe('Operazioni escluse ex art. 15');
  });

  it('keeps a description written by the user', async () => {
    const { type, control } = await render();
    await type(DESCRIPTION, 'Mia descrizione');
    await type(NATURE, 'N4');
    expect((control(DESCRIPTION) as HTMLInputElement).value).toBe('Mia descrizione');
    expect((control(NATURE) as HTMLSelectElement).value).toBe('N4');
  });

  it('keeps the description when the nature is cleared', async () => {
    const { type, control } = await render();
    await type(NATURE, 'N4');
    await type(NATURE, '');
    expect((control(DESCRIPTION) as HTMLInputElement).value).toBe('Operazioni esenti');
    expect((control(NATURE) as HTMLSelectElement).value).toBe('');
  });
});

describe('TaxEditor: modification', () => {
  it('cannot be saved without changes', async () => {
    const { save, control, type } = await render({ item: TAX });
    expect((control(RATE) as HTMLInputElement).value).toBe('22');
    expect((control(DEPARTMENT) as HTMLInputElement).value).toBe('3');
    expect(save().disabled).toBe(true);
    await type(RATE, '10');
    expect(save().disabled).toBe(false);
  });

  it('sends only what changed', async () => {
    const { type, submit, saved } = await render({ item: TAX });
    await type(RATE, '10');
    await submit();
    expect(saved).toEqual([{ rate: 10 }]);
  });

  it('sends null for the fields that were emptied', async () => {
    const { type, submit, saved } = await render({
      item: { ...TAX, vatNature: 'N4' },
    });
    await type(DEPARTMENT, '');
    await type(DESCRIPTION, '  ');
    await type(NATURE, '');
    await submit();
    expect(saved).toEqual([{ department: null, description: null, vatNature: null }]);
  });

  it('shows a nature stored outside the official list as it is', async () => {
    const { control } = await render({ item: { ...TAX, vatNature: 'ZZ' } });
    const select = control(NATURE) as HTMLSelectElement;
    expect(select.options).toHaveLength(22);
    expect(select.options[1].textContent?.trim()).toBe('ZZ');
    expect(select.value).toBe('ZZ');
  });

  it('does not add an option for an official nature', async () => {
    const { control } = await render({ item: { ...TAX, vatNature: 'N4' } });
    expect((control(NATURE) as HTMLSelectElement).options).toHaveLength(21);
  });

  it('starts from empty fields when the rate has no optional values', async () => {
    const { control } = await render({
      item: { ...TAX, department: null, description: null },
    });
    expect((control(DEPARTMENT) as HTMLInputElement).value).toBe('');
    expect((control(DESCRIPTION) as HTMLInputElement).value).toBe('');
  });
});

describe('TaxEditor: server errors', () => {
  it('shows the rejection of a field under it', async () => {
    const { error, formError } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'rate', issue: 'maximum' }]),
    });
    expect(error(RATE)).toBe('FORM.ISSUE.MAXIMUM');
    expect(formError()).toBeNull();
  });

  it('shows what fits no field on the form', async () => {
    const { formError } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'rate', issue: 'tooMany' }]),
    });
    expect(formError()).toBeNull();
    const other = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'zzz', issue: 'tooMany' }]),
    });
    expect(other.formError()).toBe('CATALOG.ERROR.TOO_MANY');
  });
});
