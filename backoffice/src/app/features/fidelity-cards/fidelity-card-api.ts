import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import { Versioned } from '../product-catalog/product-catalog.types';
import { CardAdjustment, FIDELITY_CARDS_SEGMENT, FidelityCard } from './fidelity-card.types';

/**
 * Reads and writes of the advanced loyalty cards of a group (`/v1/groups/{groupId}/fidelity-cards`);
 * the list and the movements are read with `httpResource` in the page. A modification and a deletion
 * present the version of the card in `If-Match`; a creation and an adjustment present an
 * `Idempotency-Key`.
 */
@Service()
export class FidelityCardApi {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(ProductCatalogApi);

  /** URL of the cards of a group. */
  baseUrl(groupId: string): string {
    return this.catalog.baseUrl(groupId, FIDELITY_CARDS_SEGMENT);
  }

  /** URL of the history of a card. */
  movementsUrl(groupId: string, cardId: string): string {
    return `${this.catalog.itemUrl(groupId, FIDELITY_CARDS_SEGMENT, cardId)}/movements`;
  }

  /** One card with its version. */
  read(groupId: string, cardId: string): Promise<Versioned<FidelityCard>> {
    return this.catalog.read<FidelityCard>(groupId, FIDELITY_CARDS_SEGMENT, cardId);
  }

  /** Creates a card (`201`). */
  create(groupId: string, body: object, key: string): Promise<Versioned<FidelityCard>> {
    return this.catalog.create<FidelityCard>(groupId, FIDELITY_CARDS_SEGMENT, body, key);
  }

  /** Changes the type and the state of a card. */
  update(
    groupId: string,
    cardId: string,
    body: object,
    etag: string | null,
  ): Promise<Versioned<FidelityCard>> {
    return this.catalog.update<FidelityCard>(groupId, FIDELITY_CARDS_SEGMENT, cardId, body, etag);
  }

  /** Deletes a card without history (`204`; `409` when contacts or movements refer to it). */
  async remove(groupId: string, cardId: string, etag: string | null): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(this.catalog.itemUrl(groupId, FIDELITY_CARDS_SEGMENT, cardId), {
        headers: etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag }),
      }),
    );
  }

  /**
   * Moves the credit and the points of a card (`Idempotency-Key` mandatory).
   *
   * @returns The card with its new balances (the version does not change).
   */
  async adjust(
    groupId: string,
    cardId: string,
    body: CardAdjustment,
    key: string,
  ): Promise<FidelityCard> {
    const response = await firstValueFrom(
      this.http.post<ApiData<FidelityCard>>(
        `${this.catalog.itemUrl(groupId, FIDELITY_CARDS_SEGMENT, cardId)}/adjustments`,
        body,
        { headers: new HttpHeaders({ 'Idempotency-Key': key }) },
      ),
    );
    return response.data;
  }
}
