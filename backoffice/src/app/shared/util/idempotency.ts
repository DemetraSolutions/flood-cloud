/**
 * Keeps the `Idempotency-Key` of one submission: a UUID generated when the submission starts and
 * reused for every retry of the same request, so that the server answers a request it already
 * handled with the stored response instead of creating the resource twice. A request with a
 * different body is another submission and gets a new key (the server refuses to reuse a key with
 * another body).
 */
export class IdempotencyKey {
  private last: { readonly body: string; readonly key: string } | null = null;

  /**
   * The key for a request.
   *
   * @param body The body of the request (`null` for a request without one).
   * @returns The key of the previous attempt when the body is the same, a new UUID otherwise.
   */
  forBody(body: unknown): string {
    const serialized = JSON.stringify(body ?? null);
    if (this.last === null || this.last.body !== serialized) {
      this.last = { body: serialized, key: crypto.randomUUID() };
    }
    return this.last.key;
  }

  /** The submission succeeded: the next one starts with a new key. */
  reset(): void {
    this.last = null;
  }
}
