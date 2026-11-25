import { InjectionToken, inject, Service } from '@angular/core';

/** What is persisted for a session: its browser key pair. */
export interface DpopKeyRecord {
  readonly sessionId: string;
  readonly keyPair: CryptoKeyPair;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /**
   * Epoch milliseconds of the last successful refresh by the tab owning the session. Absent in
   * records written by the earlier format: {@link createdAt} then counts as the last use.
   */
  readonly lastUsedAt?: number;
}

/** Storage of {@link DpopKeyRecord}s, one per session id. Every method rejects on failure. */
export interface DpopKeyRecords {
  get(sessionId: string): Promise<DpopKeyRecord | undefined>;
  put(record: DpopKeyRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
  all(): Promise<DpopKeyRecord[]>;
}

const DB_NAME = 'fc-dpop';
const STORE_NAME = 'keys';

/** Records not used for longer than this, whose session lock is free, are orphans (milliseconds). */
export const ORPHAN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** {@link DpopKeyRecords} on IndexedDB: database `fc-dpop`, store `keys` keyed by `sessionId`. */
export class IndexedDbKeyRecords implements DpopKeyRecords {
  private opened: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Cannot open IndexedDB'));
    }).catch((error: unknown) => {
      this.opened = null;
      throw error;
    });
    return this.opened;
  }

  /** Runs one request in a transaction and resolves with its result once the transaction ends. */
  private async run<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(new Error('IndexedDB transaction failed'));
    });
  }

  get(sessionId: string): Promise<DpopKeyRecord | undefined> {
    return this.run<DpopKeyRecord | undefined>('readonly', (store) => store.get(sessionId));
  }

  async put(record: DpopKeyRecord): Promise<void> {
    await this.run('readwrite', (store) => store.put(record));
  }

  async delete(sessionId: string): Promise<void> {
    await this.run('readwrite', (store) => store.delete(sessionId));
  }

  all(): Promise<DpopKeyRecord[]> {
    return this.run<DpopKeyRecord[]>('readonly', (store) => store.getAll());
  }
}

/** Storage used by {@link DpopKeys}; tests replace it. */
export const DPOP_KEY_RECORDS = new InjectionToken<DpopKeyRecords>('DPOP_KEY_RECORDS', {
  providedIn: 'root',
  factory: () => new IndexedDbKeyRecords(),
});

function isKeyPair(value: unknown): value is CryptoKeyPair {
  const pair = value as Partial<CryptoKeyPair> | null | undefined;
  return (
    typeof pair?.privateKey === 'object' &&
    pair.privateKey !== null &&
    typeof pair.publicKey === 'object' &&
    pair.publicKey !== null
  );
}

/**
 * The browser key of the session (D-33): an ECDSA P-256 pair whose private half is not
 * extractable, kept in memory and in IndexedDB so that the session survives a reload. Storage
 * failures are logged (never silent) and leave the key in memory only. Keys, proofs and tokens
 * are never logged.
 */
@Service()
export class DpopKeys {
  private readonly records = inject(DPOP_KEY_RECORDS);
  /** Current key; protected so that tests can substitute a pre-generated pair. */
  protected keyPair: CryptoKeyPair | null = null;

  /** The key signing the requests now, `null` when there is none. */
  current(): CryptoKeyPair | null {
    return this.keyPair;
  }

  /** Generates a new key pair and makes it the current one (not persisted yet). */
  async generate(): Promise<CryptoKeyPair> {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    this.keyPair = keyPair;
    return keyPair;
  }

  /** Stores the current key under the id of the session it now belongs to. */
  async persist(sessionId: string): Promise<void> {
    if (this.keyPair === null) {
      return;
    }
    try {
      const now = Date.now();
      await this.records.put({ sessionId, keyPair: this.keyPair, createdAt: now, lastUsedAt: now });
    } catch {
      console.warn('Cannot persist the browser key: the session will not survive a reload');
    }
  }

  /**
   * Loads the key of a session and makes it the current one.
   *
   * @returns `false` when the key is missing or cannot be read.
   */
  async load(sessionId: string): Promise<boolean> {
    try {
      const record = await this.records.get(sessionId);
      if (record !== undefined && isKeyPair(record.keyPair)) {
        this.keyPair = record.keyPair;
        return true;
      }
    } catch {
      console.warn('Cannot read the browser key');
    }
    return false;
  }

  /**
   * Marks the key of a session as used now, so that the orphan cleanup spares it while the
   * session is alive. Best effort: a failure is logged and never propagated; a missing record
   * is not recreated.
   */
  async touch(sessionId: string): Promise<void> {
    try {
      const record = await this.records.get(sessionId);
      if (record !== undefined) {
        await this.records.put({ ...record, lastUsedAt: Date.now() });
      }
    } catch {
      console.warn('Cannot update the browser key usage');
    }
  }

  /** Drops the key from memory only (the persisted copy, if any, stays). */
  forget(): void {
    this.keyPair = null;
  }

  /** Deletes the persisted key of a session. Best effort: a failure is logged. */
  async remove(sessionId: string): Promise<void> {
    try {
      await this.records.delete(sessionId);
    } catch {
      console.warn('Cannot delete the browser key');
    }
  }

  /**
   * Deletes the keys left behind by sessions that no longer exist: records of another session
   * not used for seven days (last refresh, or creation for records without it) whose session lock is free. Best effort: a failure is logged.
   *
   * @param currentSessionId Session of this page, never touched (`null` when anonymous).
   * @param isFree Whether nobody holds the lock of a session.
   */
  async cleanupOrphans(
    currentSessionId: string | null,
    isFree: (sessionId: string) => Promise<boolean>,
  ): Promise<void> {
    try {
      const now = Date.now();
      for (const record of await this.records.all()) {
        const lastUsedAt = record.lastUsedAt ?? record.createdAt;
        if (record.sessionId === currentSessionId || now - lastUsedAt < ORPHAN_AGE_MS) {
          continue;
        }
        if (await isFree(record.sessionId)) {
          await this.records.delete(record.sessionId);
        }
      }
    } catch {
      console.warn('Cannot clean up the stored browser keys');
    }
  }
}
