import { apiError, cleanUpEditor, renderApiEditor } from '../../../../testing/catalog-editor';
import { aFavoritesList } from '../../../../testing/fidelity';
import { MAX_FAVORITE_PRODUCTS } from './catalog.types';
import { FavoritesBody, FavoritesEditor, orderedProductIds } from './favorites-editor';

const NAME = 'CATALOG.PRODUCT_FAVORITES.FIELD.NAME';
const PRODUCTS = 'CATALOG.PRODUCT_FAVORITES.FIELD.PRODUCTS';

const render = (inputs: Record<string, unknown> = {}, names: Record<string, string> = {}) =>
  renderApiEditor<FavoritesBody, FavoritesEditor>(
    FavoritesEditor,
    { groupId: 'g1', ...inputs },
    { names },
  );

afterEach(cleanUpEditor);

describe('orderedProductIds', () => {
  it('orders by position, keeping the stored order for equal ones and putting those without last', () => {
    expect(
      orderedProductIds([
        { productId: 'x', position: null },
        { productId: 'b', position: 2 },
        { productId: 'a', position: 1 },
        { productId: 'c', position: 2 },
        { productId: 'y', position: null },
      ]),
    ).toEqual(['a', 'b', 'c', 'x', 'y']);
  });
});

describe('FavoritesEditor: creation', () => {
  it('sends the name and the products in the order chosen, with their place as position', async () => {
    const { type, pick, submit, saved, root, view } = await render();
    await type(NAME, ' Bar ');
    await pick('Cornetto');
    await pick('Caffè');
    await submit();
    expect(saved).toEqual([
      {
        name: 'Bar',
        products: [
          { productId: 'prod2', position: 0 },
          { productId: 'prod1', position: 1 },
        ],
      },
    ]);
    expect(root.querySelector('legend')?.textContent).toContain(PRODUCTS);
    await view();
  });

  it('reads the products from the lookup of the group', async () => {
    const { reads } = await render();
    expect(reads.lookup).toHaveBeenCalledWith('g1', 'products', { q: '', cursor: null });
  });

  it('requires a name', async () => {
    const { submit, saved, error } = await render();
    await submit();
    expect(saved).toEqual([]);
    expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('refuses more than 500 products', async () => {
    const item = aFavoritesList({
      products: Array.from({ length: MAX_FAVORITE_PRODUCTS + 1 }, (_, n) => ({
        productId: `p${n}`,
        position: n,
      })),
    });
    const { type, submit, saved, root } = await render({ item });
    await type(NAME, 'Other');
    await submit();
    expect(saved).toEqual([]);
    expect(root.textContent).toContain('FORM.ISSUE.TOO_MANY');
  });

  it('closes on cancel', async () => {
    const { cancel, cancelled } = await render();
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('FavoritesEditor: modification', () => {
  const names = { prod1: 'Caffè', prod2: 'Cornetto' };

  it('lists the products by position with their names, and cannot be saved unchanged', async () => {
    const { chosen, save, reads } = await render({ item: aFavoritesList() }, names);
    expect(reads.lookupNames).toHaveBeenCalledWith('g1', 'products', ['prod2', 'prod1']);
    expect(chosen(PRODUCTS)).toEqual(['Caffè', 'Cornetto']);
    expect(save().disabled).toBe(true);
  });

  it('sends only the name when the products are unchanged', async () => {
    const { type, submit, saved } = await render({ item: aFavoritesList() }, names);
    await type(NAME, 'Cafeteria');
    await submit();
    expect(saved).toEqual([{ name: 'Cafeteria' }]);
  });

  it('sends the whole list of products, in order, when it changes', async () => {
    const { root, view, submit, saved } = await render({ item: aFavoritesList() }, names);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-move="prod1"]')];
    buttons[1].click();
    await view();
    await submit();
    expect(saved).toEqual([
      {
        products: [
          { productId: 'prod2', position: 0 },
          { productId: 'prod1', position: 1 },
        ],
      },
    ]);
  });
});

describe('FavoritesEditor: server errors', () => {
  it('shows the rejection of a product on the products field', async () => {
    const { root, formError } = await render({
      error: apiError('VALIDATION_ERROR', [{ field: 'products.1.productId', issue: 'incorrect' }]),
    });
    expect(root.textContent).toContain('FORM.ISSUE.INCORRECT');
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
