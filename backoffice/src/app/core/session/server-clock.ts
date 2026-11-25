import { Service } from '@angular/core';

/**
 * Estimate of the backend clock, used for the `iat` claim of the DPoP proofs: the server rejects
 * proofs whose time differs by more than 60 seconds, and the clock of a device can drift.
 *
 * The offset is the difference between the `Date` header of the latest API response and the local
 * clock; it is refreshed by `serverClockInterceptor` on every response, errors included.
 */
@Service()
export class ServerClock {
  private offsetMs = 0;

  /**
   * Aligns the clock with a `Date` response header. A missing or unparsable value is ignored.
   *
   * @param header Value of the `Date` header, `null` when the response has none.
   */
  observe(header: string | null): void {
    if (header === null) {
      return;
    }
    const serverTime = Date.parse(header);
    if (!Number.isNaN(serverTime)) {
      this.offsetMs = serverTime - Date.now();
    }
  }

  /** Current server time as whole epoch seconds. */
  nowSeconds(): number {
    return Math.floor((Date.now() + this.offsetMs) / 1000);
  }
}
