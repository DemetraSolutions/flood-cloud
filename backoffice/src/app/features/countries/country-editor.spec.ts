import { apiError, cleanUpEditor, renderEditor } from '../../../testing/catalog-editor';
import { CountryEditor } from './country-editor';

const CODE = 'COUNTRIES.FIELD.CODE';
const NAME = 'COUNTRIES.FIELD.NAME';
const render = (inputs: Record<string, unknown> = {}) => renderEditor(CountryEditor, inputs);

afterEach(cleanUpEditor);

describe('CountryEditor: creation', () => {
  it('sends the code in upper case and the trimmed name', async () => {
    const { type, submit, saved, control } = await render();
    await type(CODE, 'it');
    expect((control(CODE) as HTMLInputElement).value).toBe('IT');
    await type(NAME, '  Italia  ');
    await submit();
    expect(saved).toEqual([{ code: 'IT', name: 'Italia' }]);
  });

  it('requires both fields', async () => {
    const { submit, saved, error } = await render();
    await submit();
    expect(saved).toEqual([]);
    expect(error(CODE)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('refuses a name of spaces only', async () => {
    const { type, submit, saved, error } = await render();
    await type(CODE, 'IT');
    await type(NAME, '   ');
    await submit();
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    expect(saved).toEqual([]);
  });

  it.each(['I', 'ITA', 'I1', 'I-'])('refuses the code %j', async (code) => {
    const { type, submit, saved, error } = await render();
    await type(NAME, 'Italia');
    await type(CODE, code);
    await submit();
    expect(error(CODE)).toBe('FORM.ISSUE.PATTERN');
    expect(saved).toEqual([]);
  });

  it('refuses a name longer than 100 characters or with a control character', async () => {
    const { type, submit, saved, error } = await render();
    await type(CODE, 'IT');
    await type(NAME, 'a'.repeat(101));
    await submit();
    expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
    await type(NAME, 'a\u0007');
    expect(error(NAME)).toBe('FORM.ISSUE.PATTERN');
    expect(saved).toEqual([]);
  });

  it('shows the errors of the fields once the user has been through them', async () => {
    const { blurAll, error } = await render();
    await blurAll();
    expect(error(CODE)).toBe('FORM.ISSUE.REQUIRED');
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
  });

  it.each([
    ['C0 control', '\u0007'],
    ['DEL', '\u007f'],
    ['C1 control', '\u0085'],
    ['zero-width space', '\u200b'],
    ['word joiner', '\u2060'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['bidi override', '\u202e'],
    ['bidi isolate', '\u2066'],
    ['BOM', '\ufeff'],
    ['left-to-right mark', '\u200e'],
    ['right-to-left mark', '\u200f'],
    ['Arabic letter mark', '\u061c'],
    ['invisible times', '\u2062'],
    ['invisible separator', '\u2064'],
  ])('refuses a name with a %s', async (_class, char) => {
    const { type, submit, saved, error } = await render();
    await type(CODE, 'IT');
    await type(NAME, `Ita${char}lia`);
    await submit();
    expect(error(NAME)).toBe('FORM.ISSUE.PATTERN');
    expect(saved).toEqual([]);
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });

  it('shows the errors of the server on the fields and the rest on the form', async () => {
    const { set, error, formError } = await render();
    await set({
      error: apiError('CONFLICT', [
        { field: 'code', issue: 'taken' },
        { field: 'places.a', issue: 'inUse' },
      ]),
    });
    expect(error(CODE)).toBe('FORM.ISSUE.TAKEN');
    expect(formError()).not.toBeNull();
  });
});

describe('CountryEditor: modification', () => {
  const item = { code: 'IT', name: 'Italia' };

  it('shows the code but does not let it change', async () => {
    const { control } = await render({ item });
    const code = control(CODE) as HTMLInputElement;
    expect(code.value).toBe('IT');
    expect(code.disabled).toBe(true);
  });

  it('cannot be saved without changes, and sends only the name', async () => {
    const { save, type, submit, saved } = await render({ item });
    expect(save().disabled).toBe(true);
    await type(NAME, 'Italy');
    expect(save().disabled).toBe(false);
    await submit();
    expect(saved).toEqual([{ name: 'Italy' }]);
  });
});
