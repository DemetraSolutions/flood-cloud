import { inject, Service, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { PlacesApi } from '../places/places-api';

/** What a store offers to a category or a product: its print stations, production centers and storages (only the ones the server can identify). */
export interface PlaceSetup {
  readonly stations: readonly { readonly id: string; readonly name: string }[];
  readonly centers: readonly { readonly id: string; readonly name: string }[];
  readonly storages: readonly { readonly id: string; readonly name: string }[];
}

/** The state of the read of the setup of a store. */
export type SetupState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly setup: PlaceSetup };

/**
 * Reads, store by store and only when asked, the print stations and the production centers a
 * category can use (they are part of the store, `GET /v1/groups/{groupId}/places/{placeId}`).
 * Provided by the page of the category, so that every read lives as long as the page. A failed
 * read can be asked again.
 */
@Service()
export class PlaceSetupReader {
  private readonly places = inject(PlacesApi);
  private readonly all = signal<ReadonlyMap<string, SetupState>>(new Map());

  /** The state of every store asked so far, by id. */
  readonly states = this.all.asReadonly();

  /**
   * Starts reading the setup of a store, unless it is being read or was read.
   *
   * @param groupId Group of the store.
   * @param placeId The store.
   */
  load(groupId: string, placeId: string): void {
    const current = this.all().get(placeId);
    if (current !== undefined && current.status !== 'error') {
      return;
    }
    this.put(placeId, { status: 'loading' });
    this.places.read(groupId, placeId).then(
      ({ place }) =>
        this.put(placeId, {
          status: 'ready',
          setup: {
            stations: place.printStations.stations.filter((station) => station.id !== ''),
            centers: place.printStations.productionCenters.filter((center) => center.id !== ''),
            storages: place.storages.items.filter((storage) => storage.id !== ''),
          },
        }),
      (error: unknown) => {
        // Only the code: the error would carry the URL with the ids.
        console.warn(
          'Cannot read the print stations of the store',
          error instanceof ApiError ? error.code : 'unexpected',
        );
        this.put(placeId, { status: 'error' });
      },
    );
  }

  private put(placeId: string, state: SetupState): void {
    this.all.update((current) => new Map(current).set(placeId, state));
  }
}
