/** Failure the fake can be told to produce. */
export interface FakeIndexedDbOptions {
  /** `open` fails with an error event. */
  failOpen?: boolean;
  /** Transactions end with this event instead of completing. */
  failTransaction?: 'error' | 'abort';
}

/**
 * Minimal hand-written stand-in for the few IndexedDB calls the key store uses (jsdom has no
 * IndexedDB): `open` with upgrade, one object store keyed by `sessionId`, and `get`, `put`,
 * `delete`, `getAll` in transactions that complete asynchronously.
 */
export class FakeIndexedDb {
  readonly records = new Map<string, unknown>();
  /** How many times `open` ran, how many databases were created. */
  opens = 0;
  upgrades = 0;
  storeCreated: { name: string; keyPath: unknown } | null = null;
  private exists = false;

  constructor(readonly options: FakeIndexedDbOptions = {}) {}

  open(_name: string, _version: number): IDBOpenDBRequest {
    this.opens += 1;
    const request = {
      result: null as unknown,
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
      onupgradeneeded: null as null | (() => void),
    };
    const database = {
      createObjectStore: (name: string, parameters: { keyPath: unknown }) => {
        this.storeCreated = { name, keyPath: parameters.keyPath };
      },
      transaction: () => this.transaction(),
    };
    request.result = database;
    setTimeout(() => {
      if (this.options.failOpen === true) {
        request.onerror?.();
        return;
      }
      if (!this.exists) {
        this.exists = true;
        this.upgrades += 1;
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    }, 0);
    return request as unknown as IDBOpenDBRequest;
  }

  private transaction() {
    const transaction = {
      oncomplete: null as null | (() => void),
      onerror: null as null | (() => void),
      onabort: null as null | (() => void),
    };
    const run = <T>(work: () => T) => {
      const request = { result: undefined as T };
      setTimeout(() => {
        if (this.options.failTransaction === 'error') {
          transaction.onerror?.();
        } else if (this.options.failTransaction === 'abort') {
          transaction.onabort?.();
        } else {
          request.result = work();
          transaction.oncomplete?.();
        }
      }, 0);
      return request;
    };
    const store = {
      get: (key: string) => run(() => this.records.get(key)),
      put: (record: { sessionId: string }) =>
        run(() => {
          this.records.set(record.sessionId, record);
          return record.sessionId;
        }),
      delete: (key: string) => run(() => void this.records.delete(key)),
      getAll: () => run(() => [...this.records.values()]),
    };
    return Object.assign(transaction, { objectStore: () => store });
  }
}
