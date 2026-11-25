import type { Document } from 'mongodb';
import type { ReferenceMode } from '../catalog-xlsx/catalog-xlsx.export.ts';
import type { Named } from '../catalog-xlsx/catalog-xlsx.rules.ts';
import { cardBalance, cardTypeIdOf } from '../fidelity-cards/fidelity-cards.document.ts';
import { isRecord, numberOf, textOf } from '../groups/catalogs/kit.ts';

/**
 * A reference written as an id, or as the name when the references are by name and the name can be read back: a name that has a `:` or a `|` in it would be cut apart in the cell of the points, so the id stays.
 */
function reference(id: string, items: readonly Named[], mode: ReferenceMode): string {
  const name = mode === 'ids' ? undefined : items.find((item) => item.id === id)?.name;
  return name === undefined || name === '' || /[:|]/.test(name) ? id : name;
}

/**
 * The cells of a card in the order of the columns: the code, the type, the credit, the points of the collections that have some (not zero) as `collection : points` separated by ` | `, and `X` when the card is active.
 *
 * @param document The stored card, read with every owned field.
 * @param types The card types of the group.
 * @param collections The points collections of the group.
 * @param mode How the type and the collections are written.
 */
export function cardRow(document: Document, types: readonly Named[], collections: readonly Named[], mode: ReferenceMode): string[] {
  const typeId = cardTypeIdOf(document);
  const balance = cardBalance(document['balance']);
  const stock = isRecord(document['pointsCollections']) ? document['pointsCollections'] : {};
  const points = Object.keys(stock).flatMap((id) => {
    const value = numberOf(stock[id]);
    return value === null || value === 0 ? [] : [`${reference(id, collections, mode)} : ${String(value)}`];
  });
  return [(textOf(document['code']) ?? '').trim(), typeId === null ? '' : reference(typeId, types, mode), balance === null ? '' : String(balance), points.join(' | '), document['status'] === true ? 'X' : ''];
}
