import { ReferenceApi } from '../../core/reference/reference-api';

/** The names of the companies and stores the sales refer to, by id. */
export interface SaleNames {
  readonly companies: Readonly<Record<string, string>>;
  readonly places: Readonly<Record<string, string>>;
}

/**
 * Reads the names of the companies and stores of some sales through the reference reads of the
 * group (kept in memory by the reference store). The names only decorate the sales: when the
 * read fails (for example a user who cannot read the stores) the failure is logged and the
 * result is empty, so the sales are shown with the short ids instead.
 *
 * @param reference The reference reads.
 * @param groupId Group of the sales.
 * @param sales The sales, or whatever carries a company and a store.
 */
export async function loadSaleNames(
  reference: ReferenceApi,
  groupId: string,
  sales: readonly { readonly companyId: string | null; readonly placeId: string | null }[],
): Promise<SaleNames> {
  const ids = (pick: (sale: (typeof sales)[number]) => string | null): string[] =>
    sales.map(pick).filter((id): id is string => id !== null && id !== '');
  const companyIds = ids((sale) => sale.companyId);
  const placeIds = ids((sale) => sale.placeId);
  try {
    const [companies, places] = await Promise.all([
      companyIds.length === 0 ? {} : reference.companyNames(groupId, companyIds),
      placeIds.length === 0 ? {} : reference.placeNames(groupId, placeIds),
    ]);
    return { companies, places };
  } catch (failure) {
    console.warn('Cannot read the names of the companies and stores of the sales', failure);
    return { companies: {}, places: {} };
  }
}
