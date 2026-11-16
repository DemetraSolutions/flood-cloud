import { ReferenceItem } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { loadAll, MAX_LOOKUP_PAGES } from './lookup-loader';

const item = (n: number): ReferenceItem => ({ id: `id${n}`, name: `N${n}` }) as ReferenceItem;

function storeOf(pages: { data: ReferenceItem[]; next: string | null }[]) {
  const page = vi.fn();
  for (const { data, next } of pages) {
    page.mockResolvedValueOnce({ data, page: { limit: 100, next } });
  }
  return { page, store: { page } as unknown as ReferenceStore };
}

describe('loadAll', () => {
  it('reads one page', async () => {
    const { page, store } = storeOf([{ data: [item(1), item(2)], next: null }]);
    expect(await loadAll(store, 'g1', 'companies')).toEqual([item(1), item(2)]);
    expect(page).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledWith('g1', 'companies', { limit: 100, cursor: null });
  });

  it('follows the cursor through several pages', async () => {
    const { page, store } = storeOf([
      { data: [item(1)], next: 'c1' },
      { data: [item(2)], next: 'c2' },
      { data: [item(3)], next: null },
    ]);
    expect(await loadAll(store, 'g1', 'places')).toEqual([item(1), item(2), item(3)]);
    expect(page.mock.calls.map((call) => call[2])).toEqual([
      { limit: 100, cursor: null },
      { limit: 100, cursor: 'c1' },
      { limit: 100, cursor: 'c2' },
    ]);
  });

  it('stops at the page limit even if the server keeps returning a cursor', async () => {
    const page = vi.fn().mockImplementation(async () => ({
      data: [item(1)],
      page: { limit: 100, next: 'more' },
    }));
    const store = { page } as unknown as ReferenceStore;
    const items = await loadAll(store, 'g1', 'product-categories');
    expect(page).toHaveBeenCalledTimes(MAX_LOOKUP_PAGES);
    expect(items).toHaveLength(MAX_LOOKUP_PAGES);
  });

  it('propagates a failed read', async () => {
    const page = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(loadAll({ page } as unknown as ReferenceStore, 'g1', 'companies')).rejects.toThrow(
      'boom',
    );
  });
});
