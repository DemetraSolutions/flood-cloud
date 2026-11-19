import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ReferenceStore } from '../../core/reference/reference-store';
import { CompanyRecord } from './company.types';

/** A company with the version (`ETag`) the next write must present in `If-Match`. */
export interface VersionedCompany {
  readonly company: CompanyRecord;
  readonly etag: string | null;
}

/**
 * Writes on the companies of a group (`/v1/groups/{groupId}/companies`); reads use
 * `httpResource` in the pages. Every update presents the version of the company in `If-Match`
 * and resolves with the new one. A write that changes what the compact lists show (create,
 * rename, status, trash, restore, delete) makes the reference store read the companies again.
 */
@Service()
export class CompaniesApi {
  private readonly http = inject(HttpClient);
  private readonly store = inject(ReferenceStore);

  /** Base URL of the companies of a group. */
  baseUrl(groupId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/companies`;
  }

  /** URL of one company. */
  companyUrl(groupId: string, companyId: string): string {
    return `${this.baseUrl(groupId)}/${encodeURIComponent(companyId)}`;
  }

  /**
   * Creates a company (`201`).
   *
   * @param groupId Group of the company.
   * @param body The data of the company.
   * @param key The `Idempotency-Key` of this submission (the same one on every retry of it).
   */
  async create(groupId: string, body: object, key: string): Promise<VersionedCompany> {
    const response = await firstValueFrom(
      this.http.post<ApiData<CompanyRecord>>(this.baseUrl(groupId), body, {
        headers: new HttpHeaders({ 'Idempotency-Key': key }),
        observe: 'response',
      }),
    );
    this.store.invalidate(groupId, 'companies');
    return versioned(response);
  }

  /** The unique save: a subset of the fields and whole blocks. */
  async patch(
    groupId: string,
    companyId: string,
    body: object,
    etag: string | null,
    before: CompanyRecord,
  ): Promise<VersionedCompany> {
    return this.write(
      groupId,
      this.http.patch<ApiData<CompanyRecord>>(this.companyUrl(groupId, companyId), body, {
        headers: ifMatch(etag),
        observe: 'response',
      }),
      before,
    );
  }

  /** The current version of a company, to write on a company known only from the list. */
  async version(groupId: string, companyId: string): Promise<string | null> {
    const response = await firstValueFrom(
      this.http.get<ApiData<CompanyRecord>>(this.companyUrl(groupId, companyId), {
        observe: 'response',
      }),
    );
    return response.headers.get('ETag');
  }

  /** Moves a company to the trash. */
  async trash(groupId: string, companyId: string): Promise<void> {
    await this.state(groupId, companyId, 'trash');
  }

  /** Restores a company from the trash. */
  async restore(groupId: string, companyId: string): Promise<void> {
    await this.state(groupId, companyId, 'restore');
  }

  /** Deletes a company for good (`204`; only from the trash). */
  async remove(groupId: string, companyId: string): Promise<void> {
    const etag = await this.version(groupId, companyId);
    await firstValueFrom(
      this.http.delete<void>(this.companyUrl(groupId, companyId), { headers: ifMatch(etag) }),
    );
    this.store.invalidate(groupId, 'companies');
  }

  private async state(
    groupId: string,
    companyId: string,
    action: 'trash' | 'restore',
  ): Promise<void> {
    const etag = await this.version(groupId, companyId);
    await firstValueFrom(
      this.http.post<ApiData<CompanyRecord>>(
        `${this.companyUrl(groupId, companyId)}/${action}`,
        null,
        { headers: ifMatch(etag) },
      ),
    );
    this.store.invalidate(groupId, 'companies');
  }

  private async write(
    groupId: string,
    request: Observable<HttpResponse<ApiData<CompanyRecord>>>,
    before: CompanyRecord,
  ): Promise<VersionedCompany> {
    const result = versioned(await firstValueFrom(request));
    if (result.company.name !== before.name || result.company.status !== before.status) {
      this.store.invalidate(groupId, 'companies');
    }
    return result;
  }
}

function ifMatch(etag: string | null): HttpHeaders {
  return etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag });
}

function versioned(response: HttpResponse<ApiData<CompanyRecord>>): VersionedCompany {
  return {
    company: (response.body as ApiData<CompanyRecord>).data,
    etag: response.headers.get('ETag'),
  };
}
