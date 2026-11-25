import { API, backend } from '../../../testing/api';
import {
  PRODUCT_ID_1,
  PRODUCT_ID_2,
  PRODUCT_ID_3,
  trashedProduct,
  TRASHED_NAMELESS,
  TRASHED_PRODUCT,
  TRASHED_SERVICE,
} from '../../../testing/product-list-rows';
import {
  finishTrash,
  GROUP,
  renderTrash,
  result,
  TRASH_ALL,
  trashPage,
} from '../../../testing/trash';

const BULK = `${API}/v1/groups/${GROUP}/trash/products`;
const URL = `/groups/${GROUP}/trash?tab=products`;
const WITH_PRODUCTS = [...TRASH_ALL, 'products:read', 'products:update'];
const PSA = { permissions: WITH_PRODUCTS };

afterEach(finishTrash);

describe('TrashTab: products', () => {
  it('is a tab of the group trash, after the users and before the groups', async () => {
    const { flush, root } = await renderTrash(URL, PSA);
    await flush('products', [TRASHED_PRODUCT]);
    expect([...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent?.trim())).toEqual([
      'TRASH.KIND.COMPANIES',
      'TRASH.KIND.PLACES',
      'TRASH.KIND.USERS',
      'TRASH.KIND.PRODUCTS',
      'TRASH.KIND.GROUPS',
    ]);
    expect(root.querySelector('[role=tab][aria-selected=true]')?.id).toBe('trash-tab-products');
  });

  it('reads the trashed products of every family sorted by name, without a family', async () => {
    const { request, view } = await renderTrash(URL, PSA);
    const req = request('products');
    expect(req.request.url).toBe(`${API}/v1/groups/${GROUP}/products`);
    expect(req.request.params.get('sort')).toBe('name');
    expect(req.request.params.get('trashed')).toBe('true');
    expect(req.request.params.keys().sort()).toEqual(['limit', 'sort', 'trashed']);
    req.flush(trashPage([]));
    await view();
  });

  it('shows name, code, family and date, with a link to the product of its own family', async () => {
    const { flush, cells, root } = await renderTrash(URL, PSA);
    const bare = trashedProduct('665f1c2e9b1d4a0012ab3a04', { name: null, code: null });
    await flush('products', [TRASHED_PRODUCT, TRASHED_SERVICE, TRASHED_NAMELESS, bare]);
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
      'TRASH.COLUMN.SELECT',
      'TRASH.COLUMN.NAME',
      'TRASH.COLUMN.CODE',
      'TRASH.COLUMN.FAMILY',
      'TRASH.COLUMN.TRASHED_AT',
    ]);
    expect(cells(0)).toEqual([
      '',
      'Acqua',
      'C-001',
      'PRODUCTS.FAMILY.PRODUCTS.TITLE',
      '10 nov 2026',
    ]);
    expect(cells(1)).toEqual(['', 'Taglio', '', 'PRODUCTS.FAMILY.SERVICES.TITLE', '—']);
    expect(cells(2)).toEqual([
      '',
      'C-003',
      'C-003',
      'PRODUCTS.FAMILY.TOBACCOS.TITLE',
      '10 nov 2026',
    ]);
    expect(cells(3)[1]).toBe('665f1c2e9b1d4a0012ab3a04');
    expect(
      [...root.querySelectorAll<HTMLAnchorElement>('tbody a')].map((a) => a.getAttribute('href')),
    ).toEqual([
      `/groups/${GROUP}/products/${PRODUCT_ID_1}`,
      `/groups/${GROUP}/services/${PRODUCT_ID_2}`,
      `/groups/${GROUP}/tobacco-products/${PRODUCT_ID_3}`,
      '/groups/' + GROUP + '/products/665f1c2e9b1d4a0012ab3a04',
    ]);
  });

  it('labels each checkbox with the name, the code or the id of the product', async () => {
    const { flush, checkboxes } = await renderTrash(URL, PSA);
    await flush('products', [TRASHED_PRODUCT, TRASHED_NAMELESS]);
    expect(checkboxes().map((box) => box.getAttribute('aria-label'))).toEqual([
      'TRASH.SELECT_ROW {"name":"Acqua"}',
      'TRASH.SELECT_ROW {"name":"C-003"}',
    ]);
  });

  it('explains an empty trash', async () => {
    const { flush, root } = await renderTrash(URL, PSA);
    await flush('products', []);
    expect(root.querySelector('fc-empty-state')?.textContent).toContain('TRASH.EMPTY_TITLE');
  });

  describe('restore', () => {
    it('restores the selected products and reports why some were skipped', async () => {
      const { flush, checkboxes, tick, button, view, request, openDialogs, dialogButton } =
        await renderTrash(URL, PSA);
      await flush('products', [TRASHED_PRODUCT, TRASHED_SERVICE]);
      await tick(checkboxes()[0]);
      await tick(checkboxes()[1]);
      button('TRASH.RESTORE')!.click();
      await view();
      const req = backend().expectOne(`${BULK}/restore`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ ids: [PRODUCT_ID_1, PRODUCT_ID_2] });
      req.flush({
        data: {
          results: [result(PRODUCT_ID_1, 'restored'), result(PRODUCT_ID_2, 'skipped', 'notFound')],
        },
      });
      await view();
      const [dialog] = openDialogs();
      expect(dialog.textContent).toContain('TRASH.SUMMARY.RESTORED {"count":1}');
      expect(dialog.textContent).toContain('TRASH.ISSUE.NOT_FOUND');
      expect(dialog.textContent).toContain('Taglio');
      request('products').flush(trashPage([TRASHED_SERVICE]));
      await view();
      dialogButton('COMMON.CLOSE')!.click();
      await view();
      expect(openDialogs()).toEqual([]);
    });
  });

  describe('delete for good', () => {
    it('confirms, deletes and says which products are still in use', async () => {
      const { flush, selectAll, tick, button, view, request, openDialogs, dialogButton } =
        await renderTrash(URL, PSA);
      await flush('products', [TRASHED_PRODUCT, TRASHED_SERVICE]);
      await tick(selectAll());
      button('TRASH.DELETE.ACTION')!.click();
      await view();
      expect(openDialogs()[0].textContent).toContain('TRASH.DELETE.MESSAGE {"count":2}');
      dialogButton('TRASH.DELETE.ACTION')!.click();
      await view();
      const req = backend().expectOne(`${BULK}/delete`);
      expect(req.request.body).toEqual({ ids: [PRODUCT_ID_1, PRODUCT_ID_2] });
      req.flush({
        data: {
          results: [result(PRODUCT_ID_1, 'deleted'), result(PRODUCT_ID_2, 'skipped', 'referenced')],
        },
      });
      await view();
      const [summary] = openDialogs();
      expect(summary.textContent).toContain('TRASH.SUMMARY.DELETED {"count":1}');
      expect(summary.textContent).toContain('TRASH.ISSUE.REFERENCED_PRODUCTS');
      expect(summary.textContent).toContain('Taglio');
      request('products').flush(trashPage([TRASHED_SERVICE]));
      await view();
    });
  });

  describe('empty the trash', () => {
    it('is for platform administrators: confirms, calls the empty route and ends in the summary', async () => {
      const { flush, button, dialogButton, openDialogs, view, request } = await renderTrash(
        URL,
        PSA,
      );
      await flush('products', [TRASHED_PRODUCT]);
      button('TRASH.EMPTY.ACTION')!.click();
      await view();
      const [dialog] = openDialogs();
      expect(dialog.textContent).toContain(
        'TRASH.EMPTY.MESSAGE_COUNT {"count":1,"kind":"TRASH.KIND.PRODUCTS"}',
      );
      const box = dialog.querySelector<HTMLInputElement>('input[type=checkbox]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      dialogButton('TRASH.EMPTY.START')!.click();
      await view();
      const req = backend().expectOne(`${BULK}/empty`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toBeNull();
      req.flush({
        data: {
          results: [result(PRODUCT_ID_1, 'deleted'), result(PRODUCT_ID_2, 'skipped', 'referenced')],
          remaining: 0,
          next: null,
        },
      });
      await view();
      const [summary] = openDialogs();
      expect(summary.textContent).toContain('TRASH.SUMMARY.DELETED {"count":1}');
      expect(summary.textContent).toContain('TRASH.ISSUE.REFERENCED_PRODUCTS');
      request('products').flush(trashPage([TRASHED_SERVICE]));
      await view();
    });

    it('is not offered to a group administrator', async () => {
      const { flush, tick, checkboxes, button } = await renderTrash(URL, {
        role: 'SA',
        groupId: GROUP,
        permissions: ['products:read', 'products:update'],
      });
      await flush('products', [TRASHED_PRODUCT]);
      await tick(checkboxes()[0]);
      expect(button('TRASH.EMPTY.ACTION')).toBeUndefined();
      expect(button('TRASH.RESTORE')).toBeDefined();
      expect(button('TRASH.DELETE.ACTION')).toBeDefined();
    });
  });

  describe('permissions', () => {
    it('shows the tab with products:read alone, and no action without products:update', async () => {
      const { flush, root, tick, checkboxes, button } = await renderTrash(URL, {
        role: 'CA',
        permissions: ['products:read'],
      });
      await flush('products', [TRASHED_PRODUCT]);
      expect(
        [...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent?.trim()),
      ).toEqual(['TRASH.KIND.PRODUCTS']);
      await tick(checkboxes()[0]);
      expect(button('TRASH.RESTORE')).toBeUndefined();
      expect(button('TRASH.DELETE.ACTION')).toBeUndefined();
    });

    it('hides the tab without products:read', async () => {
      const { flush, root } = await renderTrash(URL, { permissions: TRASH_ALL });
      await flush('companies', []);
      expect(root.querySelector('#trash-tab-products')).toBeNull();
    });
  });
});
