import type { Document, ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { validate } from '../../shared/validation/schema.ts';
import type { SheetCounts } from '../catalog-xlsx/catalog-xlsx.import.ts';
import { decimalOf, recognizeByIdOrName, recognizeFlag, recognizeWhole, referencesOf } from '../catalog-xlsx/catalog-xlsx.rules.ts';
import type { Named } from '../catalog-xlsx/catalog-xlsx.rules.ts';
import { cardBalance, cardTypeIdOf } from '../fidelity-cards/fidelity-cards.document.ts';
import { createCardBody, patchCardBody } from '../fidelity-cards/fidelity-cards.schemas.ts';
import type { CardsService } from '../fidelity-cards/fidelity-cards.service.ts';
import { isRecord, numberOf, textOf } from '../groups/catalogs/kit.ts';
import { RecordErrorCollector } from '../records-xlsx/records-xlsx.errors.ts';
import { RecordRowReader, refuse, reportHeaderProblems, resolved } from '../records-xlsx/records-xlsx.sheet.ts';
import type { RecordsImportInput, RecordsReport } from '../records-xlsx/records-xlsx.service.ts';

/** The card types and the points collections of the group, as the recognition of a reference needs them. */
export interface CardRefs {
  readonly types: readonly Named[];
  readonly collections: readonly Named[];
}

/** The services of the cards an import calls, built over the session of the transaction, and the reads it needs. */
export interface CardsGraph {
  readonly cards: Pick<CardsService, 'create' | 'update'>;
  /** The cards that have some codes, with every owned field. */
  findByCodes(principal: AuthPrincipal, access: GroupAccess, codes: readonly string[]): Promise<Document[]>;
  /** The version of a stored card (the `If-Match` of its next write). */
  version(document: Document): string;
  /** The card types and the points collections of the group. */
  refs(access: GroupAccess): Promise<CardRefs>;
}

/** The column a field the service refuses belongs to, by the path of the field. */
const FIELD_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['code', 'code'],
  ['cardTypeId', 'type'],
  ['enabled', 'enabled'],
  ['initialBalance', 'balance'],
  ['initialPoints', 'points'],
  ['balance', 'balance'],
];

/**
 * The points of a cell of the points: `collection : points` separated by `|`, the collection by id or by name (the points are a whole number, the text after the last `:`). `null` when a part is not valid, a collection is
 * unknown or ambiguous, or comes twice (the problems are recorded on the row).
 */
function pointsOf(rv: RecordRowReader, cell: string, collections: readonly Named[]): Map<string, number> | null {
  const points = new Map<string, number>();
  let valid = true;
  for (const token of referencesOf(cell)) {
    const colon = token.lastIndexOf(':');
    const value = colon === -1 ? null : recognizeWhole(token.slice(colon + 1));
    if (colon <= 0 || value === null) {
      rv.fail('points', 'invalidValue');
      valid = false;
      continue;
    }
    const collection = resolved(rv, 'points', recognizeByIdOrName(token.slice(0, colon), collections));
    if (collection === null) {
      valid = false;
    } else if (points.has(collection.id)) {
      rv.fail('points', 'invalidValue');
      valid = false;
    } else {
      points.set(collection.id, value);
    }
  }
  return valid ? points : null;
}

/**
 * Applies the rows of the sheet of the cards through the service of the cards (the one of the routes), one row after the other inside the transaction of the import. **The code is the key.** A new code creates the card:
 * the type is required, the credit (`SALDO`, only for a prepaid type) and the points (only the collections of the type) are its initial values, each a movement of type `import`, and `STATO` is active when it is left out.
 * An existing code changes only the type and the state; `SALDO` and `PUNTI`, when filled, must be what the card has (the credit and the points change only with the adjustments). A code that comes twice is a problem.
 * A row with a problem writes nothing, and the problems of all the rows are collected.
 *
 * @param input The services, the caller, the group and the sheet.
 * @throws {AppError} `PAYLOAD_TOO_LARGE` when the import runs past its deadline.
 */
export async function applyCards(input: RecordsImportInput<CardsGraph>): Promise<RecordsReport> {
  const { graph, principal, access, client, sheet } = input;
  const errors = new RecordErrorCollector(sheet.sheet.name);
  const counts: SheetCounts = { inserted: 0, updated: 0, removed: 0, unchanged: 0 };
  const report = (): RecordsReport => ({ counts, errors: errors.errors, errorCount: errors.count });
  if (reportHeaderProblems(sheet, errors)) {
    return report();
  }
  if (!sheet.header.fixed.has('code')) {
    // Without the code there is no key: nothing can be read.
    errors.add(null, sheet.sheet.columns.find((column) => column.key === 'code')!.header, 'required');
    return report();
  }
  const refs = await graph.refs(access);
  const seen = new Set<string>();
  for (const row of sheet.rows) {
    if (input.now() > input.deadline) {
      throw new AppError('PAYLOAD_TOO_LARGE', { message: 'The import takes too long: split the file' });
    }
    if (errors.full) {
      break;
    }
    const rv = new RecordRowReader(sheet, row, errors);
    const code = rv.text('code')!;
    if (code === '') {
      rv.fail('code', 'required');
    } else if (seen.has(code)) {
      rv.fail('code', 'duplicateCode');
    } else {
      seen.add(code);
    }
    if (rv.failed) {
      continue;
    }
    // The card the code names, if there is one (the spaces around a stored code do not count).
    const found = await graph.findByCodes(principal, access, [code]);
    if (found.length > 1) {
      // The unique index is on the exact text: two cards may have the same code but for the spaces around it. Never guess which one.
      rv.fail('code', 'conflict');
      continue;
    }
    const card = found[0] ?? null;
    const typeCell = rv.text('type');
    const type = typeCell === undefined || typeCell === '' ? null : resolved(rv, 'type', recognizeByIdOrName(typeCell, refs.types));
    if (card === null && (typeCell === undefined || typeCell === '')) {
      rv.fail('type', 'required');
    }
    const balanceCell = rv.text('balance') ?? '';
    const balance = balanceCell === '' ? null : decimalOf(balanceCell);
    if (balanceCell !== '' && balance === null) {
      rv.fail('balance', 'invalidValue');
    }
    const pointsCell = rv.text('points') ?? '';
    const points = pointsCell === '' ? new Map<string, number>() : pointsOf(rv, pointsCell, refs.collections);
    const stateCell = rv.text('enabled');
    const enabled = stateCell === undefined ? undefined : recognizeFlag(stateCell);
    if (enabled === null) {
      rv.fail('enabled', 'invalidValue');
    }
    if (rv.failed) {
      continue;
    }
    try {
      if (card === null) {
        const initialPoints = [...points!].filter(([, value]) => value > 0).map(([collectionId, value]) => ({ collectionId, points: value }));
        const body = {
          code,
          cardTypeId: type!.id,
          ...(enabled === undefined ? {} : { enabled }),
          ...(balance === null || balance === 0 ? {} : { initialBalance: balance }),
          ...(initialPoints.length === 0 ? {} : { initialPoints }),
        };
        await graph.cards.create(principal, access, validate(createCardBody, body, '(row)'), client, { movementType: 'import' });
        counts.inserted += 1;
        continue;
      }
      // An existing card: the credit and the points of the file must be the ones it has.
      const stock = isRecord(card['pointsCollections']) ? card['pointsCollections'] : {};
      if (balance !== null && balance !== (cardBalance(card['balance']) ?? 0)) {
        rv.fail('balance', 'balanceChange');
      }
      for (const [collectionId, value] of points!) {
        if (value !== (numberOf(stock[collectionId]) ?? 0)) {
          rv.fail('points', 'pointsChange');
        }
      }
      if (rv.failed) {
        continue;
      }
      const body = {
        ...(type === null || type.id === cardTypeIdOf(card) ? {} : { cardTypeId: type.id }),
        ...(enabled === undefined || enabled === (card['status'] === true) ? {} : { enabled }),
      };
      if (Object.keys(body).length === 0) {
        counts.unchanged += 1;
        continue;
      }
      // The body holds only what differs from the stored card, so the write always changes its version.
      await graph.cards.update(principal, access, card['_id'] as ObjectId, graph.version(card), validate(patchCardBody, body, '(row)'), client);
      counts.updated += 1;
    } catch (error) {
      refuse(error, rv, FIELD_COLUMNS);
    }
  }
  return report();
}
