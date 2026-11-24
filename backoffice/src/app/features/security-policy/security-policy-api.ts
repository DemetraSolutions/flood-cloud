import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { SecurityPolicy, SecurityPolicyChange, VersionedPolicy } from './security-policy.types';

const URL = '/v1/settings/security-policy';

/** Reads and writes the security policy (PSA only). A write presents the version read in `If-Match`. */
@Service()
export class SecurityPolicyApi {
  private readonly http = inject(HttpClient);

  /** The policy with its version. */
  async read(): Promise<VersionedPolicy> {
    return versioned(
      await firstValueFrom(this.http.get<ApiData<SecurityPolicy>>(URL, { observe: 'response' })),
    );
  }

  /**
   * Changes one or both fields; the others stay as they are.
   *
   * @param change Fields to change (at least one).
   * @param etag Version read, sent in `If-Match`.
   * @throws ApiError `412` when the policy changed meanwhile; `409` with the issue `browserRequired`
   *   on `nonBrowserRequests` when the block is turned on from a request that does not look like a browser's.
   */
  async write(change: SecurityPolicyChange, etag: string | null): Promise<VersionedPolicy> {
    return versioned(
      await firstValueFrom(
        this.http.put<ApiData<SecurityPolicy>>(URL, change, {
          headers: etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag }),
          observe: 'response',
        }),
      ),
    );
  }
}

function versioned(response: HttpResponse<ApiData<SecurityPolicy>>): VersionedPolicy {
  return {
    value: (response.body as ApiData<SecurityPolicy>).data,
    etag: response.headers.get('ETag'),
  };
}
