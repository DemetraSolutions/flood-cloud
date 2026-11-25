import { TestBed } from '@angular/core/testing';
import { FakeIndexedDb } from '../../../testing/fake-indexeddb';
import { MemoryKeyRecords, sharedKeyPair } from '../../../testing/dpop';
import {
  DPOP_KEY_RECORDS,
  DpopKeyRecord,
  DpopKeys,
  IndexedDbKeyRecords,
  ORPHAN_AGE_MS,
} from './dpop-key-store';

const DAY = 24 * 60 * 60 * 1000;

function record(sessionId: string, ageMs = 0): DpopKeyRecord {
  return { sessionId, keyPair: sharedKeyPair, createdAt: Date.now() - ageMs };
}

describe('IndexedDbKeyRecords', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores, reads, lists and deletes records, creating the store once', async () => {
    const fake = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    const records = new IndexedDbKeyRecords();
    await records.put(record('a'));
    await records.put(record('b'));
    expect((await records.get('a'))?.sessionId).toBe('a');
    expect(await records.get('zzz')).toBeUndefined();
    expect((await records.all()).map((r) => r.sessionId)).toEqual(['a', 'b']);
    await records.delete('a');
    expect((await records.all()).map((r) => r.sessionId)).toEqual(['b']);
    expect(fake.opens).toBe(1);
    expect(fake.upgrades).toBe(1);
    expect(fake.storeCreated).toEqual({ name: 'keys', keyPath: 'sessionId' });
  });

  it('does not upgrade a database that already exists', async () => {
    const fake = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    await new IndexedDbKeyRecords().all();
    await new IndexedDbKeyRecords().all();
    expect(fake.opens).toBe(2);
    expect(fake.upgrades).toBe(1);
  });

  it('rejects where IndexedDB does not exist, and tries again next time', async () => {
    const records = new IndexedDbKeyRecords();
    await expect(records.all()).rejects.toThrow('IndexedDB is not available');
    vi.stubGlobal('indexedDB', new FakeIndexedDb());
    expect(await records.all()).toEqual([]);
  });

  it('rejects when the database cannot be opened, and tries again next time', async () => {
    const fake = new FakeIndexedDb({ failOpen: true });
    vi.stubGlobal('indexedDB', fake);
    const records = new IndexedDbKeyRecords();
    await expect(records.get('a')).rejects.toThrow('Cannot open IndexedDB');
    fake.options.failOpen = false;
    expect(await records.get('a')).toBeUndefined();
  });

  it.each(['error', 'abort'] as const)('rejects when a transaction ends with %s', async (event) => {
    vi.stubGlobal('indexedDB', new FakeIndexedDb({ failTransaction: event }));
    await expect(new IndexedDbKeyRecords().put(record('a'))).rejects.toThrow(
      'IndexedDB transaction failed',
    );
  });

  it('is the default storage of the key store', () => {
    expect(TestBed.inject(DPOP_KEY_RECORDS)).toBeInstanceOf(IndexedDbKeyRecords);
  });
});

describe('DpopKeys', () => {
  let records: MemoryKeyRecords;
  let keys: DpopKeys;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    records = new MemoryKeyRecords();
    TestBed.configureTestingModule({
      providers: [{ provide: DPOP_KEY_RECORDS, useValue: records }],
    });
    keys = TestBed.inject(DpopKeys);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('generates a P-256 pair whose private key cannot be exported', async () => {
    expect(keys.current()).toBeNull();
    const pair = await keys.generate();
    expect(keys.current()).toBe(pair);
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(pair.privateKey.usages).toEqual(['sign']);
    await expect(crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
    expect((await crypto.subtle.exportKey('jwk', pair.publicKey)).crv).toBe('P-256');
  });

  it('persists the current key under the session id', async () => {
    const pair = await keys.generate();
    await keys.persist('s1');
    expect(records.map.get('s1')?.keyPair).toBe(pair);
    expect(Math.abs((records.map.get('s1')?.createdAt ?? 0) - Date.now())).toBeLessThan(5000);
  });

  it('persists nothing without a key', async () => {
    await keys.persist('s1');
    expect(records.map.size).toBe(0);
  });

  it('keeps the key in memory and warns when it cannot be persisted', async () => {
    const pair = await keys.generate();
    records.failing.add('put');
    await keys.persist('s1');
    expect(keys.current()).toBe(pair);
    expect(warn).toHaveBeenCalledWith(
      'Cannot persist the browser key: the session will not survive a reload',
    );
  });

  it('loads the key of a session, and reports a missing or unreadable one', async () => {
    records.map.set('s1', record('s1'));
    expect(await keys.load('s1')).toBe(true);
    expect(keys.current()).toBe(sharedKeyPair);
    keys.forget();
    expect(keys.current()).toBeNull();
    expect(await keys.load('other')).toBe(false);
    records.map.set('bad', { sessionId: 'bad', keyPair: null as never, createdAt: 0 });
    expect(await keys.load('bad')).toBe(false);
    records.failing.add('get');
    expect(await keys.load('s1')).toBe(false);
    expect(warn).toHaveBeenCalledWith('Cannot read the browser key');
    expect(keys.current()).toBeNull();
  });

  it('marks a key as used now, without recreating a missing record', async () => {
    records.map.set('s1', record('s1', 30 * DAY));
    await keys.touch('s1');
    expect(Math.abs((records.map.get('s1')?.lastUsedAt ?? 0) - Date.now())).toBeLessThan(5000);
    expect(records.map.get('s1')?.createdAt).toBeLessThan(Date.now() - 29 * DAY);
    await keys.touch('gone');
    expect(records.map.has('gone')).toBe(false);
  });

  it('warns, never failing, when the usage cannot be updated', async () => {
    records.map.set('s1', record('s1'));
    records.failing.add('put');
    await keys.touch('s1');
    records.failing.clear();
    records.failing.add('get');
    await keys.touch('s1');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('Cannot update the browser key usage');
  });

  it('deletes the key of a session, warning when it cannot', async () => {
    records.map.set('s1', record('s1'));
    await keys.remove('s1');
    expect(records.map.size).toBe(0);
    records.failing.add('delete');
    await keys.remove('s1');
    expect(warn).toHaveBeenCalledWith('Cannot delete the browser key');
  });

  describe('cleanupOrphans', () => {
    it('deletes only old records of other sessions whose lock is free', async () => {
      records.map.set('current', record('current', 30 * DAY));
      records.map.set('young', record('young', ORPHAN_AGE_MS - DAY));
      records.map.set('locked', record('locked', 30 * DAY));
      records.map.set('orphan', record('orphan', ORPHAN_AGE_MS + DAY));
      const checked: string[] = [];
      await keys.cleanupOrphans('current', (id) => {
        checked.push(id);
        return Promise.resolve(id !== 'locked');
      });
      expect([...records.map.keys()].sort()).toEqual(['current', 'locked', 'young']);
      expect(checked.sort()).toEqual(['locked', 'orphan']);
    });

    it('judges by the last use, not by the creation', async () => {
      records.map.set('active', { ...record('active', 30 * DAY), lastUsedAt: Date.now() - DAY });
      records.map.set('idle', { ...record('idle', 30 * DAY), lastUsedAt: Date.now() - 8 * DAY });
      records.map.set('legacy', record('legacy', 8 * DAY));
      records.map.set('legacy-young', record('legacy-young', DAY));
      await keys.cleanupOrphans(null, () => Promise.resolve(true));
      expect([...records.map.keys()].sort()).toEqual(['active', 'legacy-young']);
    });

    it('cleans up everything old when anonymous', async () => {
      records.map.set('orphan', record('orphan', 30 * DAY));
      await keys.cleanupOrphans(null, () => Promise.resolve(true));
      expect(records.map.size).toBe(0);
    });

    it('warns instead of failing when the storage or a lock check fails', async () => {
      records.failing.add('all');
      await keys.cleanupOrphans(null, () => Promise.resolve(true));
      records.failing.clear();
      records.map.set('orphan', record('orphan', 30 * DAY));
      await keys.cleanupOrphans(null, () => Promise.reject(new Error('locks')));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('Cannot clean up the stored browser keys');
      expect(records.map.size).toBe(1);
    });
  });
});
