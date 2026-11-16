import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ReferenceStore } from '../../core/reference/reference-store';
import { blockBody, toModel } from './place-model';
import { PlaceRecord, PlaceSection } from './place.types';

/** A place with the version (`ETag`) the next write must present in `If-Match`. */
export interface VersionedPlace {
  readonly place: PlaceRecord;
  readonly etag: string | null;
}

/** URL path of the `PUT` of each block, below the place. */
const BLOCK_PATHS: Readonly<Record<Exclude<PlaceSection, 'general'>, string>> = {
  license: 'license',
  openingHours: 'opening-hours',
  cashSettings: 'settings/cash',
  printing: 'settings/printing',
  payments: 'settings/payments',
  tables: 'settings/tables',
  reservations: 'settings/reservations',
  delivery: 'settings/delivery',
  selfOrdering: 'settings/self-ordering',
  kiosk: 'settings/kiosk',
  appointments: 'settings/appointments',
  externalDisplay: 'settings/external-display',
  fidelity: 'settings/fidelity',
  tobacco: 'settings/tobacco',
  media: 'media',
};

/**
 * Writes on the places of a group (`/v1/groups/{groupId}/places`); reads use `httpResource` in
 * the pages. Every update presents the version of the place in `If-Match` and resolves with the
 * new one; the creation and the duplication present an `Idempotency-Key`. A write that changes
 * what the compact lists show (create, duplicate, name, company, status, trash, restore, delete)
 * makes the reference store read the places again.
 */
@Service()
export class PlacesApi {
  private readonly http = inject(HttpClient);
  private readonly store = inject(ReferenceStore);

  /** Base URL of the places of a group. */
  baseUrl(groupId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/places`;
  }

  /** URL of one place. */
  placeUrl(groupId: string, placeId: string): string {
    return `${this.baseUrl(groupId)}/${encodeURIComponent(placeId)}`;
  }

  /**
   * Creates a place (`201`).
   *
   * @param groupId Group of the place.
   * @param body The data of the place.
   * @param key The `Idempotency-Key` of this submission (the same one on every retry of it).
   */
  async create(groupId: string, body: object, key: string): Promise<VersionedPlace> {
    const response = await firstValueFrom(
      this.http.post<ApiData<PlaceRecord>>(this.baseUrl(groupId), body, {
        headers: new HttpHeaders({ 'Idempotency-Key': key }),
        observe: 'response',
      }),
    );
    this.store.invalidate(groupId, 'places');
    return versioned(response);
  }

  /**
   * Duplicates a place (`201`): the copy has everything of the original but the store key.
   *
   * @param groupId Group of the place.
   * @param placeId The place to copy.
   * @param key The `Idempotency-Key` of this action (the same one on every retry of it).
   */
  async duplicate(groupId: string, placeId: string, key: string): Promise<VersionedPlace> {
    const response = await firstValueFrom(
      this.http.post<ApiData<PlaceRecord>>(`${this.placeUrl(groupId, placeId)}/duplicate`, null, {
        headers: new HttpHeaders({ 'Idempotency-Key': key }),
        observe: 'response',
      }),
    );
    this.store.invalidate(groupId, 'places');
    return versioned(response);
  }

  /** The unique save: a subset of the fields and whole blocks. */
  async patch(
    groupId: string,
    placeId: string,
    body: object,
    etag: string | null,
    before: PlaceRecord,
  ): Promise<VersionedPlace> {
    return this.write(
      groupId,
      this.http.patch<ApiData<PlaceRecord>>(this.placeUrl(groupId, placeId), body, {
        headers: ifMatch(etag),
        observe: 'response',
      }),
      before,
    );
  }

  /** Replaces one block of the place. */
  async replace(
    groupId: string,
    placeId: string,
    section: Exclude<PlaceSection, 'general'>,
    body: unknown,
    etag: string | null,
    before: PlaceRecord,
  ): Promise<VersionedPlace> {
    return this.write(
      groupId,
      this.http.put<ApiData<PlaceRecord>>(
        `${this.placeUrl(groupId, placeId)}/${BLOCK_PATHS[section]}`,
        body,
        { headers: ifMatch(etag), observe: 'response' },
      ),
      before,
    );
  }

  /** A place with its version, to write on a place known only from the list. */
  async read(groupId: string, placeId: string): Promise<VersionedPlace> {
    return versioned(
      await firstValueFrom(
        this.http.get<ApiData<PlaceRecord>>(this.placeUrl(groupId, placeId), {
          observe: 'response',
        }),
      ),
    );
  }

  /**
   * Renews the license of a place: its expiration date changes, everything else of the license
   * stays as the server has it (the license is written whole, with the version just read).
   *
   * @param groupId Group of the place.
   * @param placeId The place.
   * @param date The new date (`YYYY-MM-DD`), `null` for none.
   */
  async renew(groupId: string, placeId: string, date: string | null): Promise<VersionedPlace> {
    const current = await this.read(groupId, placeId);
    const model = toModel(current.place);
    const body = blockBody(
      { ...model, license: { ...model.license, expirationDate: date ?? '' } },
      'license',
      current.place,
    );
    return this.replace(groupId, placeId, 'license', body, current.etag, current.place);
  }

  /** Moves a place to the trash. */
  async trash(groupId: string, placeId: string): Promise<void> {
    await this.state(groupId, placeId, 'trash');
  }

  /** Restores a place from the trash. */
  async restore(groupId: string, placeId: string): Promise<void> {
    await this.state(groupId, placeId, 'restore');
  }

  /** Deletes a place for good (`204`; only from the trash). */
  async remove(groupId: string, placeId: string): Promise<void> {
    const { etag } = await this.read(groupId, placeId);
    await firstValueFrom(
      this.http.delete<void>(this.placeUrl(groupId, placeId), { headers: ifMatch(etag) }),
    );
    this.store.invalidate(groupId, 'places');
  }

  private async state(
    groupId: string,
    placeId: string,
    action: 'trash' | 'restore',
  ): Promise<void> {
    const { etag } = await this.read(groupId, placeId);
    await firstValueFrom(
      this.http.post<ApiData<PlaceRecord>>(`${this.placeUrl(groupId, placeId)}/${action}`, null, {
        headers: ifMatch(etag),
      }),
    );
    this.store.invalidate(groupId, 'places');
  }

  private async write(
    groupId: string,
    request: Observable<HttpResponse<ApiData<PlaceRecord>>>,
    before: PlaceRecord,
  ): Promise<VersionedPlace> {
    const result = versioned(await firstValueFrom(request));
    const after = result.place;
    if (
      after.name !== before.name ||
      after.companyId !== before.companyId ||
      after.license.status !== before.license.status ||
      after.trashed !== before.trashed
    ) {
      this.store.invalidate(groupId, 'places');
    }
    return result;
  }
}

function ifMatch(etag: string | null): HttpHeaders {
  return etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag });
}

function versioned(response: HttpResponse<ApiData<PlaceRecord>>): VersionedPlace {
  return {
    place: (response.body as ApiData<PlaceRecord>).data,
    etag: response.headers.get('ETag'),
  };
}
