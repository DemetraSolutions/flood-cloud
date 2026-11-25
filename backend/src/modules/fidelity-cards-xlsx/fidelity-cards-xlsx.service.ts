import type { WorkbookService } from '../catalog-xlsx/catalog-xlsx.controller.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import { createCardsRepository } from '../fidelity-cards/fidelity-cards.repository.ts';
import { cardVersion } from '../fidelity-cards/fidelity-cards.document.ts';
import { createContactsRepository } from '../contacts/contacts.repository.ts';
import type { CardIndexGuard } from '../fidelity-cards/fidelity-cards.indexes.ts';
import { CARDS_LIST } from '../fidelity-cards/fidelity-cards.schemas.ts';
import { createCardsService } from '../fidelity-cards/fidelity-cards.service.ts';
import { cardTypes } from '../groups/catalogs/card-types.ts';
import type { CardType } from '../groups/catalogs/card-types.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { pointsCollections } from '../groups/catalogs/points-collections.ts';
import type { PointsCollection } from '../groups/catalogs/points-collections.ts';
import { createRecordsXlsxService, RECORDS_EXPORT_BATCH } from '../records-xlsx/records-xlsx.service.ts';
import type { RecordsDomain, RecordsXlsxDeps } from '../records-xlsx/records-xlsx.service.ts';
import { CARDS_SHEET } from './fidelity-cards-xlsx.columns.ts';
import { cardRow } from './fidelity-cards-xlsx.export.ts';
import { applyCards } from './fidelity-cards-xlsx.import.ts';
import type { CardsGraph } from './fidelity-cards-xlsx.import.ts';

/** Prefix of the key of the lock of a group in `common.settings`: one import of the cards at a time for a group, whatever the instance of the server. */
export const CARDS_LOCK_PREFIX = 'CARDS_LOCK:';

/** The collaborators of the workbook of the cards: what the service of the cards is built from. */
export interface CardsXlsxDeps extends RecordsXlsxDeps {
  readonly catalogs: Pick<CatalogsService, 'list'>;
  /** Makes sure the group has the unique index on the code before its first card is written: the import does it before it opens the transaction. */
  readonly indexes: CardIndexGuard;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
}

/**
 * Builds the workbook of the advanced loyalty cards of a group (`doc/Tasks.md` step K3): the sheet `Carte`. The export writes every card (active or not) by code; the import writes through the service of the cards built
 * over the transaction of the import (so the card and its initial movements, of type `import`, are part of it). The import is all or nothing and holds the lock `CARDS_LOCK:<groupId>`.
 *
 * @param deps The collaborators.
 */
export function createCardsXlsxService(deps: CardsXlsxDeps): WorkbookService {
  const { databases, catalogs, versionKey } = deps;
  const reads = createCardsRepository(databases);
  const refsOf = async (access: Parameters<CardsGraph['refs']>[0]) => {
    const [types, collections] = await Promise.all([catalogs.list(cardTypes, access), catalogs.list(pointsCollections, access)]);
    return {
      types: (types as CardType[]).map((type) => ({ id: type.id, name: type.name?.trim() ?? '' })),
      collections: (collections as PointsCollection[]).map((collection) => ({ id: collection.id, name: collection.name?.trim() ?? '' })),
    };
  };
  const domain: RecordsDomain<CardsGraph> = {
    sheet: CARDS_SHEET,
    kind: 'cards',
    fileBase: 'fidelity-cards',
    lockPrefix: CARDS_LOCK_PREFIX,
    audit: { exported: 'fidelityCards.exported', imported: 'fidelityCards.imported', resource: 'fidelityCards', exportedKey: 'cards' },
    count: (principal, access, cap) => reads.countUpTo(principal, access, cap),
    rows: async function* (principal, access, mode) {
      const refs = await refsOf(access);
      let cursor: string | undefined;
      do {
        const params = listParamsOf({ limit: RECORDS_EXPORT_BATCH, sort: 'code', ...(cursor === undefined ? {} : { cursor }) }, CARDS_LIST);
        const { items, page } = await reads.list(principal, access, {}, params);
        for (const document of items) {
          yield cardRow(document, refs.types, refs.collections, mode);
        }
        cursor = page.next ?? undefined;
      } while (cursor !== undefined);
    },
    prepare: (principal, access) => deps.indexes.ensure(principal, access),
    graphOver: (over, log) => {
      const repository = createCardsRepository(over);
      return {
        // The service joins the transaction of the import (`nested`): its writes are part of it, and its entries go to the buffer.
        cards: createCardsService({ repository, contacts: createContactsRepository(over), catalogs, activityLog: log, indexes: deps.indexes, databases: over, nested: true, versionKey, now: deps.now }),
        findByCodes: (principal, access, codes) => repository.findByCodes(principal, access, codes),
        version: (document) => cardVersion(document, versionKey),
        refs: refsOf,
      };
    },
    apply: applyCards,
  };
  return createRecordsXlsxService(domain, deps);
}
