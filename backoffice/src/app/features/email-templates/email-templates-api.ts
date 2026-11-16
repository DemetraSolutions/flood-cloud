import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { EmailTemplateBody, EmailTemplateRecord, VersionedTemplate } from './email-template.types';

/**
 * Writes on the e-mail templates of a group (`/v1/groups/{groupId}/email-templates`); the list
 * is read with `httpResource` in the page. A modification presents the version of the template
 * in `If-Match` and resolves with the new one; the creation presents an `Idempotency-Key`.
 */
@Service()
export class EmailTemplatesApi {
  private readonly http = inject(HttpClient);

  /** Base URL of the templates of a group. */
  baseUrl(groupId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/email-templates`;
  }

  /** URL of one template. */
  templateUrl(groupId: string, templateId: string): string {
    return `${this.baseUrl(groupId)}/${encodeURIComponent(templateId)}`;
  }

  /** One template with its version. */
  async read(groupId: string, templateId: string): Promise<VersionedTemplate> {
    return versioned(
      await firstValueFrom(
        this.http.get<ApiData<EmailTemplateRecord>>(this.templateUrl(groupId, templateId), {
          observe: 'response',
        }),
      ),
    );
  }

  /**
   * Creates a template (`201`).
   *
   * @param groupId Group of the template.
   * @param body The name, the text and the HTML.
   * @param key The `Idempotency-Key` of this submission (the same one on every retry of it).
   */
  async create(groupId: string, body: EmailTemplateBody, key: string): Promise<VersionedTemplate> {
    return versioned(
      await firstValueFrom(
        this.http.post<ApiData<EmailTemplateRecord>>(this.baseUrl(groupId), body, {
          headers: new HttpHeaders({ 'Idempotency-Key': key }),
          observe: 'response',
        }),
      ),
    );
  }

  /**
   * Changes the given fields of a template (`If-Match` with the version read).
   *
   * @param etag The version the user read, `null` when the response had none.
   */
  async update(
    groupId: string,
    templateId: string,
    body: EmailTemplateBody,
    etag: string | null,
  ): Promise<VersionedTemplate> {
    return versioned(
      await firstValueFrom(
        this.http.patch<ApiData<EmailTemplateRecord>>(this.templateUrl(groupId, templateId), body, {
          headers: etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag }),
          observe: 'response',
        }),
      ),
    );
  }

  /** Deletes a template (`204`; `409` while a place still uses it). */
  async remove(groupId: string, templateId: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.templateUrl(groupId, templateId)));
  }
}

function versioned(response: HttpResponse<ApiData<EmailTemplateRecord>>): VersionedTemplate {
  return {
    template: (response.body as ApiData<EmailTemplateRecord>).data,
    etag: response.headers.get('ETag'),
  };
}
