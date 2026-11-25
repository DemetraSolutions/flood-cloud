import type { ObjectId } from 'mongodb';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';
import type { AdjustmentBody, CreateCardBody, MovementsQuery, PatchCardBody } from '../fidelity-cards/fidelity-cards.schemas.ts';
import type { CardResult, CardsService } from '../fidelity-cards/fidelity-cards.service.ts';
import { groupCallerOf } from '../public-catalog/public-catalog.caller.ts';
import type { PublicCatalogPage, PublicEntry } from '../public-catalog/public-catalog.service.ts';
import { toPublicCard, toPublicCardRow, toPublicMovement } from './public-fidelity-cards.mapper.ts';
import type { PublicCard, PublicCardRow, PublicMovement } from './public-fidelity-cards.mapper.ts';
import { PUBLIC_CARDS_DEFAULT_PAGE } from './public-fidelity-cards.schemas.ts';
import type { PublicCardsQuery } from './public-fidelity-cards.schemas.ts';

/**
 * The advanced loyalty cards of the public API (`doc/Public-API.md`): what an integration with a public key reads (`fidelityCards:read`) and writes (`fidelityCards:write`). Every operation goes through the same service of the
 * backoffice, with all its rules, as a caller built from the key alone: the group is the one of the key and the restrictions of the key to companies and places do not narrow it (the cards have no perimeter of places). The
 * contacts that have a card are named only to a key that also holds `contacts:read`, and a card is given to contacts at its creation only by a key that also holds `contacts:write`. The movements of a key have no user.
 * The API never deletes a card.
 */
export interface PublicFidelityCardsService {
  listCards(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicCardsQuery): Promise<PublicCatalogPage<PublicCardRow>>;
  getCard(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicCard>>;
  /** @throws {AppError} `FORBIDDEN` when the body names contacts and the key does not hold `contacts:write`. */
  createCard(principal: ApiKeyPrincipal, access: GroupAccess, body: CreateCardBody, client: ClientContext): Promise<PublicEntry<PublicCard>>;
  updateCard(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, body: PatchCardBody, client: ClientContext): Promise<PublicEntry<PublicCard>>;
  adjustCard(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, body: AdjustmentBody, client: ClientContext): Promise<PublicEntry<PublicCard>>;
  listMovements(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, query: MovementsQuery): Promise<PublicCatalogPage<PublicMovement>>;
}

/** Collaborators of {@link createPublicFidelityCardsService}: the service of the advanced cards. */
export interface PublicFidelityCardsServiceDeps {
  readonly cards: Pick<CardsService, 'list' | 'get' | 'create' | 'update' | 'adjust' | 'movements'>;
}

/**
 * Builds the advanced cards service of the public API.
 *
 * @param deps The service of the advanced cards.
 */
export function createPublicFidelityCardsService(deps: PublicFidelityCardsServiceDeps): PublicFidelityCardsService {
  const { cards } = deps;
  const readsContacts = (principal: ApiKeyPrincipal): boolean => principal.permissions.has('contacts:read');
  const cardResult = (principal: ApiKeyPrincipal, result: CardResult): PublicEntry<PublicCard> => ({ entity: toPublicCard(result.entity, readsContacts(principal)), version: result.version });
  return {
    listCards: async (principal, access, query) => {
      const withContacts = readsContacts(principal);
      // The search of a key that may not read the contacts looks at the codes alone: the names of the contacts are not a thing it can find out.
      const { items, page } = await cards.list(groupCallerOf(principal), access, { ...query, limit: query.limit ?? PUBLIC_CARDS_DEFAULT_PAGE, ...(withContacts ? {} : { codeOnly: true as const }) });
      return { items: items.map((item) => toPublicCardRow(item, withContacts)), page };
    },
    getCard: async (principal, access, id) => cardResult(principal, await cards.get(groupCallerOf(principal), access, id)),
    createCard: async (principal, access, body, client) => {
      if (body.contactIds !== undefined && !principal.permissions.has('contacts:write')) {
        throw new AppError('FORBIDDEN');
      }
      return cardResult(principal, await cards.create(groupCallerOf(principal), access, body, client));
    },
    updateCard: async (principal, access, id, expected, body, client) => cardResult(principal, await cards.update(groupCallerOf(principal), access, id, expected, body, client)),
    adjustCard: async (principal, access, id, body, client) => cardResult(principal, await cards.adjust(groupCallerOf(principal), access, id, body, client)),
    listMovements: async (principal, access, id, query) => {
      const { items, page } = await cards.movements(groupCallerOf(principal), access, id, query);
      return { items: items.map(toPublicMovement), page };
    },
  };
}
