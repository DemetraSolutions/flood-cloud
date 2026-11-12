import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { MeasureUnitEditor } from './measure-unit-editor';

const VALUE = 'CATALOG.MEASURE_UNITS.FIELD.VALUE';
const render = (inputs: Record<string, unknown> = {}) => renderEditor(MeasureUnitEditor, inputs);

afterEach(cleanUpEditor);

describe('MeasureUnitEditor', () => {
  it('creates a unit with the trimmed value', async () => {
    const { type, submit, saved } = await render();
    await type(VALUE, ' kg ');
    await submit();
    expect(saved).toEqual([{ value: 'kg' }]);
  });

  it('requires a value', async () => {
    const { submit, saved, error } = await render();
    await submit();
    expect(saved).toEqual([]);
    expect(error(VALUE)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('rejects more than 20 characters', async () => {
    const { type, submit, saved, error } = await render();
    await type(VALUE, 'x'.repeat(21));
    await submit();
    expect(saved).toEqual([]);
    expect(error(VALUE)).toBe('FORM.ISSUE.MAX_LENGTH');
  });

  it('cannot save a modification that changes nothing', async () => {
    const { type, save, control } = await render({ item: { id: 'u1', value: 'kg' } });
    expect((control(VALUE) as HTMLInputElement).value).toBe('kg');
    expect(save().disabled).toBe(true);
    await type(VALUE, ' kg ');
    expect(save().disabled).toBe(true);
    await type(VALUE, 'g');
    expect(save().disabled).toBe(false);
  });

  it('sends the new value of a modification', async () => {
    const { type, submit, saved } = await render({ item: { id: 'u1', value: 'kg' } });
    await type(VALUE, 'g');
    await submit();
    expect(saved).toEqual([{ value: 'g' }]);
  });

  it('shows server errors on the field and on the form', async () => {
    const { error, formError, set } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'value', issue: 'taken' }]),
    });
    expect(error(VALUE)).toBe('FORM.ISSUE.TAKEN');
    await set({ error: apiError('CONFLICT') });
    expect(formError()).toBe('CATALOG.ERROR.CONCURRENT');
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('MeasureUnitEditor: touching the fields', () => {
  it('shows the validation errors of the fields left empty', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBeGreaterThan(0);
  });
});
