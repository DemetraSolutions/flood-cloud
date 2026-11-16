import { renderPlace, STORAGE } from '../../../testing/places';
import {
  cleanUp,
  failSave,
  isChecked,
  READ_ONLY,
  savePut,
  submitTab,
} from '../../../testing/places-tabs';

const L = (key: string) => `PLACES.STORAGES.${key}`;
const SECOND = { name: 'Magazzino', cash: false, ecommerce: false };
const STORED = { id: STORAGE.id, name: 'Deposito 1', cash: true, ecommerce: false };

afterEach(cleanUp);

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('article.row')];
const within = (row: HTMLElement, label: string) =>
  [...row.querySelectorAll('label')]
    .filter((l) => l.textContent?.trim() === label)
    .map((l) => row.querySelector<HTMLInputElement>(`#${l.htmlFor}`) as HTMLInputElement)[0];

async function addSecond(view: Awaited<ReturnType<typeof renderPlace>>, name = 'Magazzino') {
  await view.click(L('ADD'));
  const row = rows(view.root)[1];
  const field = within(row, L('NAME'));
  field.value = name;
  field.dispatchEvent(new Event('input'));
  await view.view();
  return row;
}

describe('PlaceStorages', () => {
  it('shows the stored storages with the flags (the group has the cash and the app)', async () => {
    const view = await renderPlace({
      path: 'storages',
      features: ['cash', 'customersApp'],
      profile: { role: 'CA', groupId: 'g' },
    });
    const [row] = rows(view.root);
    expect(within(row, L('NAME')).value).toBe('Deposito 1');
    expect(within(row, L('CASH')).checked).toBe(true);
    expect(within(row, L('CASH')).disabled).toBe(true);
    expect(within(row, L('ECOMMERCE')).checked).toBe(false);
    expect(view.text()).toContain(L('RULES'));
  });

  it('hides the flags the group has no module for, unless the user is privileged', async () => {
    const view = await renderPlace({
      path: 'storages',
      features: [],
      profile: { role: 'CA', groupId: 'g' },
    });
    expect(view.root.textContent).not.toContain(L('CASH'));
    expect(view.root.textContent).not.toContain(L('ECOMMERCE'));
  });

  it('shows only the cash flag with the cash module and only the e-commerce with the app', async () => {
    const cash = await renderPlace({
      path: 'storages',
      features: ['cash'],
      profile: { role: 'CA', groupId: 'g' },
    });
    expect(cash.root.textContent).toContain(L('CASH'));
    expect(cash.root.textContent).not.toContain(L('ECOMMERCE'));
  });

  it('shows only the e-commerce flag with the app module', async () => {
    const view = await renderPlace({
      path: 'storages',
      features: ['customersApp'],
      profile: { role: 'CA', groupId: 'g' },
    });
    expect(view.root.textContent).not.toContain(L('CASH'));
    expect(view.root.textContent).toContain(L('ECOMMERCE'));
  });

  it('shows both flags to a platform administrator without modules', async () => {
    const view = await renderPlace({ path: 'storages', features: [] });
    expect(view.root.textContent).toContain(L('CASH'));
    expect(view.root.textContent).toContain(L('ECOMMERCE'));
  });

  it('adds a storage without an id and saves the exact list', async () => {
    const view = await renderPlace({ path: 'storages' });
    await addSecond(view);
    const sent = (await savePut(view, 'storages', { items: [STORED, SECOND] })) as {
      items: object[];
    };
    expect(sent.items[0]).toHaveProperty('id', STORAGE.id);
    expect(sent.items[1]).not.toHaveProperty('id');
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('moves the cash flag to the ticked storage and clears the other', async () => {
    const view = await renderPlace({ path: 'storages' });
    const row = await addSecond(view);
    const box = within(row, L('CASH'));
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await view.view();
    const [first, second] = rows(view.root);
    expect(within(first, L('CASH')).checked).toBe(false);
    expect(within(first, L('CASH')).disabled).toBe(false);
    expect(within(second, L('CASH')).checked).toBe(true);
    expect(within(second, L('CASH')).disabled).toBe(true);
    await savePut(view, 'storages', {
      items: [
        { ...STORED, cash: false },
        { ...SECOND, cash: true },
      ],
    });
  });

  it('keeps at most one storage for the e-commerce: ticking one clears the others, unticking leaves none', async () => {
    const view = await renderPlace({ path: 'storages' });
    await addSecond(view);
    const tick = async (index: number, checked: boolean) => {
      const box = within(rows(view.root)[index], L('ECOMMERCE'));
      box.checked = checked;
      box.dispatchEvent(new Event('change'));
      await view.view();
    };
    await tick(0, true);
    await tick(1, true);
    expect(within(rows(view.root)[0], L('ECOMMERCE')).checked).toBe(false);
    expect(within(rows(view.root)[1], L('ECOMMERCE')).checked).toBe(true);
    await tick(1, false);
    expect(within(rows(view.root)[1], L('ECOMMERCE')).checked).toBe(false);
    await savePut(view, 'storages', { items: [STORED, SECOND] });
  });

  it('removes a storage but never the last one', async () => {
    const view = await renderPlace({ path: 'storages' });
    const remove = () =>
      view.root.querySelectorAll<HTMLButtonElement>('button[aria-label^="PLACES.STORAGES.REMOVE"]');
    expect(remove()[0].disabled).toBe(true);
    await addSecond(view);
    expect(remove()[0].disabled).toBe(false);
    remove()[0].click();
    await view.view();
    expect(rows(view.root)).toHaveLength(1);
    expect(remove()[0].disabled).toBe(true);
    await savePut(view, 'storages', { items: [SECOND] });
  });

  it('does not save a storage without a name', async () => {
    const view = await renderPlace({ path: 'storages' });
    await view.click(L('ADD'));
    await view.click('COMMON.SAVE');
    expect(view.root.querySelector('.error')?.textContent).toBeDefined();
    expect(view.root.textContent).toContain('FORM.ISSUE.REQUIRED');
  });

  it('puts the 422 of the list rules above the rows and the one of a row on its field', async () => {
    const view = await renderPlace({ path: 'storages' });
    await addSecond(view);
    await failSave(view, [
      { field: 'storages.items', issue: 'incorrect' },
      { field: 'storages.items.1.name', issue: 'taken' },
    ]);
    expect(view.root.querySelector('fieldset > [role=alert]')?.textContent).toContain(
      'FORM.ISSUE.INCORRECT',
    );
    expect(view.error(L('NAME'))).toBeDefined();
    expect(view.root.textContent).toContain('FORM.ISSUE.TAKEN');
  });

  it('shows the list read-only with a note when it cannot be changed', async () => {
    const view = await renderPlace({
      path: 'storages',
      place: (await import('../../../testing/places')).fakePlace({
        storages: { items: [STORAGE], editable: false },
      }),
    });
    expect(view.text()).toContain(L('NOT_EDITABLE'));
    expect(view.button(L('ADD'))).toBeUndefined();
    expect(view.root.querySelector('button[aria-label^="PLACES.STORAGES.REMOVE"]')).toBeNull();
    expect(within(rows(view.root)[0], L('NAME')).disabled).toBe(true);
    expect(isChecked(view, L('ECOMMERCE'))).toBe(false);
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'storages', permissions: READ_ONLY });
    expect(within(rows(view.root)[0], L('NAME')).disabled).toBe(true);
    expect(within(rows(view.root)[0], L('ECOMMERCE')).disabled).toBe(true);
    expect(view.button(L('ADD'))).toBeUndefined();
    expect(view.button('COMMON.SAVE')).toBeUndefined();
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'storages' });
    await submitTab(view);
    await view.blurAll();
  });
});
