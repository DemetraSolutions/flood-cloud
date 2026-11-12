import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { aPrize, aPrizeCatalogue } from '../../../../testing/fidelity';
import { MAX_PRIZES } from './catalog.types';
import { PrizeCatalogueBody, PrizeCatalogueEditor } from './prize-catalogue-editor';

const NAME = 'CATALOG.PRIZE_CATALOGUES.FIELD.NAME';
const ENABLED = 'CATALOG.PRIZE_CATALOGUES.FIELD.ENABLED';
const PRIZE = 'CATALOG.PRIZE_CATALOGUES.PRIZE_FIELD';

async function render(inputs: Record<string, unknown> = {}) {
  const rendered = await renderEditor<PrizeCatalogueBody, PrizeCatalogueEditor>(
    PrizeCatalogueEditor,
    inputs,
  );
  const { root, fixture } = rendered;
  const prizes = () => [...root.querySelectorAll('fieldset')];
  const field = (index: number, label: string) => {
    const element = [...prizes()[index].querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === `${PRIZE}.${label}`,
    )!;
    return prizes()[index].querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `#${element.htmlFor}`,
    )!;
  };
  const fill = async (index: number, label: string, value: string) => {
    const control = field(index, label);
    control.value = value;
    control.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const press = async (name: string) => {
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!.click();
    await fixture.whenStable();
  };
  return { ...rendered, prizes, field, fill, press };
}

afterEach(cleanUpEditor);

describe('PrizeCatalogueEditor: creation', () => {
  it('starts enabled and without prizes', async () => {
    const { control, root } = await render();
    expect((control(ENABLED) as HTMLInputElement).checked).toBe(true);
    expect(root.textContent).toContain('CATALOG.PRIZE_CATALOGUES.NO_PRIZES');
  });

  it('sends the name and an empty list of prizes', async () => {
    const { type, submit, saved } = await render();
    await type(NAME, ' Gifts ');
    await submit();
    expect(saved).toEqual([{ name: 'Gifts', enabled: true, prizes: [] }]);
  });

  it('adds prizes, without an id, with the filled fields', async () => {
    const { type, press, fill, submit, saved, prizes, root } = await render();
    await type(NAME, 'Gifts');
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    expect(prizes()).toHaveLength(1);
    expect(root.textContent).not.toContain('CATALOG.PRIZE_CATALOGUES.NO_PRIZES');
    await fill(0, 'NAME', ' Mug ');
    await fill(0, 'DESCRIPTION', 'White mug');
    await fill(0, 'POINTS', '100');
    await fill(0, 'EXTRA_PRICE', '2.5');
    await fill(0, 'CONDITIONS', 'In store only');
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    await fill(1, 'NAME', 'Pen');
    await submit();
    expect(saved).toEqual([
      {
        name: 'Gifts',
        enabled: true,
        prizes: [
          {
            enabled: true,
            name: 'Mug',
            description: 'White mug',
            pointsValue: 100,
            extraPrice: 2.5,
            redemptionConditions: 'In store only',
          },
          {
            enabled: true,
            name: 'Pen',
            description: null,
            pointsValue: null,
            extraPrice: null,
            redemptionConditions: null,
          },
        ],
      },
    ]);
  });

  it('removes a prize', async () => {
    const { type, press, fill, submit, saved, prizes } = await render();
    await type(NAME, 'Gifts');
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    await fill(0, 'NAME', 'First');
    await fill(1, 'NAME', 'Second');
    await press('CATALOG.PRIZE_CATALOGUES.REMOVE');
    expect(prizes()).toHaveLength(1);
    await submit();
    expect(saved[0].prizes?.map((prize) => prize.name)).toEqual(['Second']);
  });

  it('requires the name of the catalogue and of each prize', async () => {
    const { press, submit, saved, error, prizes } = await render();
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    await submit();
    expect(saved).toEqual([]);
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    expect(prizes()[0].querySelector('.error span')?.textContent?.trim()).toBe(
      'FORM.ISSUE.REQUIRED',
    );
  });

  it('checks the amounts and the lengths of the texts of a prize', async () => {
    const { type, press, fill, submit, saved, prizes } = await render();
    await type(NAME, 'Gifts');
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    await fill(0, 'NAME', 'Mug');
    await fill(0, 'POINTS', '-5');
    await fill(0, 'EXTRA_PRICE', '-1');
    await fill(0, 'DESCRIPTION', 'x'.repeat(1001));
    await fill(0, 'CONDITIONS', 'x'.repeat(1001));
    await submit();
    expect(saved).toEqual([]);
    expect(
      [...prizes()[0].querySelectorAll('.error span')].map((e) => e.textContent?.trim()),
    ).toEqual([
      'FORM.ISSUE.MAX_LENGTH',
      'FORM.ISSUE.MINIMUM',
      'FORM.ISSUE.MINIMUM',
      'FORM.ISSUE.MAX_LENGTH',
    ]);
  });

  it('stops offering prizes at the limit', async () => {
    const full = aPrizeCatalogue({
      prizes: Array.from({ length: MAX_PRIZES }, (_, n) => aPrize({ id: `p${n}`, name: `P${n}` })),
    });
    const { root } = await render({ item: full });
    const add = [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'CATALOG.PRIZE_CATALOGUES.ADD',
    )!;
    expect(add.disabled).toBe(true);
    expect(root.querySelector('[role=status]')?.textContent?.trim()).toContain(
      'CATALOG.LIMIT_REACHED',
    );
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('PrizeCatalogueEditor: modification', () => {
  const item = aPrizeCatalogue({
    prizes: [aPrize({ id: 'a', name: 'Mug', imageSet: true }), aPrize({ id: 'b', name: 'Pen' })],
  });

  it('cannot be saved without changes, and says which prizes have an image', async () => {
    const { save, root } = await render({ item });
    expect(save().disabled).toBe(true);
    expect(root.textContent?.match(/CATALOG\.PRIZE_CATALOGUES\.IMAGE_SET/g)).toHaveLength(1);
  });

  it('sends only the name or the flag when the prizes are untouched', async () => {
    const { type, check, submit, saved } = await render({ item });
    await type(NAME, 'Other');
    await submit();
    await check(ENABLED, false);
    await submit();
    expect(saved).toEqual([{ name: 'Other' }, { name: 'Other', enabled: false }]);
  });

  it('sends the whole list of prizes, existing ones with their id, when one changes', async () => {
    const { fill, submit, saved } = await render({ item });
    await fill(1, 'NAME', 'Pencil');
    await submit();
    expect(saved).toEqual([
      {
        prizes: [
          {
            id: 'a',
            enabled: true,
            name: 'Mug',
            description: null,
            pointsValue: 100,
            extraPrice: null,
            redemptionConditions: null,
          },
          {
            id: 'b',
            enabled: true,
            name: 'Pencil',
            description: null,
            pointsValue: 100,
            extraPrice: null,
            redemptionConditions: null,
          },
        ],
      },
    ]);
  });

  it('leaves out a removed prize and adds a new one without id', async () => {
    const { press, fill, submit, saved } = await render({ item });
    await press('CATALOG.PRIZE_CATALOGUES.REMOVE');
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    await fill(1, 'NAME', 'Cap');
    await submit();
    expect(saved[0].prizes?.map((prize) => [prize.id, prize.name])).toEqual([
      ['b', 'Pen'],
      [undefined, 'Cap'],
    ]);
  });
});

describe('PrizeCatalogueEditor: server errors', () => {
  const item = aPrizeCatalogue();

  it('shows the rejection of a prize field under it', async () => {
    const { prizes, root } = await render({
      item,
      error: apiError('VALIDATION_ERROR', [
        { field: 'prizes.0.name', issue: 'required' },
        { field: 'prizes.0.pointsValue', issue: 'minimum' },
      ]),
    });
    expect(
      [...prizes()[0].querySelectorAll('.error span')].map((e) => e.textContent?.trim()),
    ).toEqual(['FORM.ISSUE.REQUIRED', 'FORM.ISSUE.MINIMUM']);
    expect(root.querySelector('fc-form-error')).toBeNull();
  });

  it('shows a rejection of the list itself above the prizes', async () => {
    const { root } = await render({
      item,
      error: apiError('VALIDATION_ERROR', [{ field: 'prizes', issue: 'tooMany' }]),
    });
    expect(root.querySelector('.prizes fc-form-error')?.textContent?.trim()).toBe(
      'FORM.ISSUE.TOO_MANY',
    );
  });

  it('shows the rejection of the name, and what fits no field, on the form', async () => {
    const { error, formError } = await render({
      error: apiError('VALIDATION_ERROR', [
        { field: 'name', issue: 'required' },
        { field: '(body)', issue: 'tooMany' },
      ]),
    });
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    expect(formError()).toBe('CATALOG.ERROR.TOO_MANY');
  });

  it('shows the validation errors of the fields left empty once touched', async () => {
    const { blurAll, root } = await render();
    await blurAll();
    expect(root.querySelectorAll('.error span').length).toBeGreaterThan(0);
  });

  it('marks the fields of the prizes as touched when left', async () => {
    const { blurAll, press, prizes } = await render();
    await press('CATALOG.PRIZE_CATALOGUES.ADD');
    await blurAll();
    expect(prizes()[0].querySelector('.error span')?.textContent?.trim()).toBe(
      'FORM.ISSUE.REQUIRED',
    );
  });
});
