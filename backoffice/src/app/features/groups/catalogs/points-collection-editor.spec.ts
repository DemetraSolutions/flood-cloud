import { apiError, cleanUpEditor, renderApiEditor } from '../../../../testing/catalog-editor';
import { aPointsCollection } from '../../../../testing/fidelity';
import { fromLocalInput, toLocalInput } from './catalog-fields';
import { PointsCollectionBody, PointsCollectionEditor } from './points-collection-editor';

const F = 'CATALOG.POINTS_COLLECTIONS.FIELD';
const NAME = `${F}.NAME`;
const ENABLED = `${F}.ENABLED`;
const CONVERSION = `${F}.CONVERSION`;
const MIN_AMOUNT = `${F}.MIN_AMOUNT`;
const FROM = `${F}.DATE_FROM`;
const TO = `${F}.DATE_TO`;
const EXPIRATION = `${F}.EXPIRATION`;
const CATALOGUE = `${F}.CATALOGUE`;
const URL = '/v1/groups/g1/fidelity/prize-catalogues';
const CATALOGUES = { data: [{ id: 'cat1', name: 'Gifts', enabled: true, prizes: [] }] };
const ISO = '2026-12-01T10:30:00.000Z';

async function render(inputs: Record<string, unknown> = {}, catalogues: object = CATALOGUES) {
  const rendered = await renderApiEditor<PointsCollectionBody, PointsCollectionEditor>(
    PointsCollectionEditor,
    { groupId: 'g1', ...inputs },
  );
  await rendered.answer(URL, catalogues);
  return rendered;
}

afterEach(cleanUpEditor);

describe('PointsCollectionEditor: creation', () => {
  it('starts enabled and sends only the name and the flag when nothing else is filled', async () => {
    const { type, submit, saved, control } = await render();
    expect((control(ENABLED) as HTMLInputElement).checked).toBe(true);
    await type(NAME, ' Spring ');
    await submit();
    expect(saved).toEqual([{ name: 'Spring', enabled: true }]);
  });

  it('sends the amounts, the dates as ISO and the catalogue', async () => {
    const { type, submit, saved } = await render();
    await type(NAME, 'Spring');
    await type(CONVERSION, '10');
    await type(MIN_AMOUNT, '5.5');
    await type(FROM, toLocalInput(ISO));
    await type(TO, toLocalInput('2026-12-31T10:30:00.000Z'));
    await type(EXPIRATION, toLocalInput('2027-06-30T10:30:00.000Z'));
    await type(CATALOGUE, 'cat1');
    await submit();
    expect(saved).toEqual([
      {
        name: 'Spring',
        enabled: true,
        pointConversion: 10,
        minAmount: 5.5,
        dateFrom: ISO,
        dateTo: '2026-12-31T10:30:00.000Z',
        pointsExpirationDate: '2027-06-30T10:30:00.000Z',
        prizeCatalogueId: 'cat1',
      },
    ]);
  });

  it('uses datetime-local inputs', async () => {
    const { control } = await render();
    expect((control(FROM) as HTMLInputElement).type).toBe('datetime-local');
  });

  it('requires a name, non negative amounts and an end after the start', async () => {
    const { type, submit, saved, error } = await render();
    await submit();
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    await type(NAME, 'Spring');
    await type(CONVERSION, '-1');
    await type(FROM, '2026-12-02T10:00');
    await type(TO, '2026-12-01T10:00');
    await submit();
    expect(error(CONVERSION)).toBe('FORM.ISSUE.MINIMUM');
    expect(error(TO)).toBe('FORM.ISSUE.INCORRECT');
    expect(saved).toEqual([]);
  });

  it('refuses a filled date it cannot read instead of sending it as no date', async () => {
    const { type, submit, saved, error } = await render();
    await type(NAME, 'Spring');
    await type(EXPIRATION, '10000-01-01T00:00');
    await submit();
    expect(error(EXPIRATION)).toBe('FORM.ISSUE.INCORRECT');
    expect(saved).toEqual([]);
  });

  it('says so when the catalogues cannot be read', async () => {
    const rendered = await renderApiEditor<PointsCollectionBody, PointsCollectionEditor>(
      PointsCollectionEditor,
      { groupId: 'g1' },
    );
    await rendered.answer(URL, {}, 500);
    expect(rendered.root.textContent).toContain('CATALOG.POINTS_COLLECTIONS.CATALOGUES_FAILED');
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('PointsCollectionEditor: modification', () => {
  const item = aPointsCollection({
    pointConversion: 10,
    dateFrom: ISO,
    prizeCatalogueId: 'cat1',
  });

  it('cannot be saved without changes and shows the dates in the local time', async () => {
    const { save, control } = await render({ item });
    expect(save().disabled).toBe(true);
    expect((control(FROM) as HTMLInputElement).value).toBe(toLocalInput(ISO));
  });

  it('sends only what changed', async () => {
    const { type, check, submit, saved } = await render({ item });
    await type(NAME, 'Summer');
    await submit();
    await check(ENABLED, false);
    await type(CONVERSION, '20');
    await type(MIN_AMOUNT, '3');
    await type(TO, '2027-01-01T08:00');
    await type(EXPIRATION, '2027-02-01T08:00');
    await type(FROM, '2026-11-01T08:00');
    await type(CATALOGUE, '');
    await submit();
    expect(saved[0]).toEqual({ name: 'Summer' });
    expect(saved[1]).toEqual({
      name: 'Summer',
      enabled: false,
      pointConversion: 20,
      minAmount: 3,
      dateFrom: fromLocalInput('2026-11-01T08:00'),
      dateTo: fromLocalInput('2027-01-01T08:00'),
      pointsExpirationDate: fromLocalInput('2027-02-01T08:00'),
      prizeCatalogueId: null,
    });
  });

  it('empties a field with null', async () => {
    const { type, submit, saved } = await render({ item });
    await type(CONVERSION, '');
    await type(FROM, '');
    await submit();
    expect(saved).toEqual([{ pointConversion: null, dateFrom: null }]);
  });

  it('leaves a stored date the input cannot show as it is', async () => {
    const odd = aPointsCollection({ dateFrom: 'not a date' });
    const { type, submit, saved, control } = await render({ item: odd });
    expect((control(FROM) as HTMLInputElement).value).toBe('');
    await type(NAME, 'Other');
    await submit();
    expect(saved).toEqual([{ name: 'Other' }]);
  });

  it('shows a catalogue that is not in the group any more, to replace it', async () => {
    const { control } = await render({ item: aPointsCollection({ prizeCatalogueId: 'gone' }) });
    expect([...(control(CATALOGUE) as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      '',
      'gone',
      'cat1',
    ]);
  });
});

describe('PointsCollectionEditor: server errors', () => {
  it('shows the rejection of a field under it', async () => {
    const { error, formError } = await render({
      error: apiError('VALIDATION_ERROR', [
        { field: 'dateTo', issue: 'incorrect' },
        { field: 'prizeCatalogueId', issue: 'incorrect' },
      ]),
    });
    expect(error(TO)).toBe('FORM.ISSUE.INCORRECT');
    expect(error(CATALOGUE)).toBe('FORM.ISSUE.INCORRECT');
    expect(formError()).toBeNull();
  });

  it('shows what fits no field on the form', async () => {
    const { formError } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: '(body)', issue: 'tooMany' }]),
    });
    expect(formError()).toBe('CATALOG.ERROR.TOO_MANY');
  });

  it('shows the validation errors of the fields left empty once touched', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBeGreaterThan(0);
  });
});
