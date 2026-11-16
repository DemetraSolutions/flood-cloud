import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_XLSX_LIMITS } from '../../src/shared/xlsx/limits.ts';
import type { XlsxLimits } from '../../src/shared/xlsx/limits.ts';
import { ZIP_MAGIC, openZip } from '../../src/shared/xlsx/zip.ts';
import { zipOf } from '../helpers/xlsx.ts';
import type { TestZipFile, TestZipOptions } from '../helpers/xlsx.ts';

const open = (files: readonly TestZipFile[], options: TestZipOptions = {}, limits: Partial<XlsxLimits> = {}) => openZip(zipOf(files, options), { ...DEFAULT_XLSX_LIMITS, ...limits });
const refused = (reason: string) => ({ name: 'XlsxError', reason });
const A: TestZipFile = { name: 'a.txt', data: 'hello world' };

describe('ZIP reader', () => {
  it('reads deflated, stored and empty entries and folders', () => {
    const zip = open([A, { name: 'b.txt', data: 'stored text', method: 'stored' }, { name: 'empty.txt' }, { name: 'dir/' }]);
    assert.equal(zip.read('a.txt').toString(), 'hello world');
    assert.equal(zip.read('b.txt').toString(), 'stored text');
    assert.equal(zip.read('empty.txt').length, 0);
    assert.equal(zip.has('dir/'), true);
    assert.equal(zip.has('nope'), false);
    assert.equal(ZIP_MAGIC.length, 4);
  });

  it('reads an archive with a comment, and finds the end record even when the comment holds its signature', () => {
    const comment = Buffer.concat([Buffer.from('x'), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(30)]);
    assert.equal(open([A], { comment }).read('a.txt').toString(), 'hello world');
  });

  it('refuses what is not a ZIP archive', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('PK'), Buffer.from('plain text that is long enough to be an end record'), Buffer.concat([ZIP_MAGIC, Buffer.alloc(40)])]) {
      assert.throws(() => openZip(bytes, DEFAULT_XLSX_LIMITS), refused('notZip'));
    }
  });

  it('refuses a file over the size limit', () => {
    assert.throws(() => open([A], {}, { maxFileBytes: 50 }), refused('limit'));
  });

  it('refuses ZIP64 and archives split on several disks', () => {
    assert.throws(() => open([A], { zip64Locator: true }), refused('unsupported'));
    assert.throws(() => open([A], { declaredEntries: 0xffff }), refused('unsupported'));
    assert.throws(() => open([A], { directorySize: 0xffffffff }), refused('unsupported'));
    assert.throws(() => open([A], { directoryOffset: 0xffffffff }), refused('unsupported'));
    assert.throws(() => open([A], { disk: 1 }), refused('unsupported'));
    assert.throws(() => open([A], { directoryDisk: 1 }), refused('unsupported'));
    assert.throws(() => open([A], { entriesOnDisk: 2 }), refused('unsupported'));
    assert.throws(() => open([{ ...A, declared: { size: 0xffffffff } }]), refused('unsupported'));
    assert.throws(() => open([{ ...A, declared: { compressedSize: 0xffffffff } }]), refused('unsupported'));
    assert.throws(() => open([{ ...A, declared: { localOffset: 0xffffffff } }]), refused('unsupported'));
  });

  it('refuses encryption, other compression methods and entries that start on another disk', () => {
    assert.throws(() => open([{ ...A, declared: { flags: 1 } }]), refused('unsupported'));
    assert.throws(() => open([{ ...A, declared: { flags: 0x40 } }]), refused('unsupported'));
    assert.throws(() => open([{ ...A, declared: { method: 99 } }]), refused('unsupported'));
    assert.throws(() => open([{ ...A, declared: { startDisk: 1 } }]), refused('unsupported'));
  });

  it('refuses unsafe and duplicate names', () => {
    for (const name of ['../evil', 'a/../../evil', '/etc/passwd', 'a\\b', 'C:evil', 'a//b', './a', 'a/./b', 'bad\u0001name', 'x'.repeat(300)]) {
      assert.throws(() => open([{ name, data: 'x' }]), refused('unsafe'), name);
    }
    assert.throws(() => open([{ name: '', data: 'x' }]), refused('unsafe'));
    assert.throws(() => open([A, { name: 'a.txt' }]), refused('unsafe'));
    assert.throws(() => open([A, { name: 'A.TXT' }]), refused('unsafe'));
  });

  it('refuses the limits: entries, entry size, total size and compression ratio', () => {
    assert.throws(() => open([A, { name: 'b' }, { name: 'c' }], {}, { maxEntries: 2 }), refused('limit'));
    assert.throws(() => open([A], {}, { maxEntryBytes: 5 }), refused('limit'));
    assert.throws(() => open([A, { name: 'b.txt', data: 'hello world' }], {}, { maxTotalBytes: 20 }), refused('limit'));
    // A real bomb: two million zeros deflate to about two kilobytes.
    assert.throws(() => open([{ name: 'bomb', data: Buffer.alloc(2_000_000) }]), refused('limit'));
    // A directory that declares data inflated from nothing.
    assert.throws(() => open([{ ...A, declared: { compressedSize: 0 } }]), refused('limit'));
    assert.throws(() => open([{ ...A, declared: { size: 100_000 } }]), refused('limit'));
  });

  it('refuses a damaged directory', () => {
    assert.throws(() => open([A], { declaredEntries: 0 }), refused('malformed'));
    assert.throws(() => open([A], { directoryOffset: 0xfffffff0 }), refused('malformed'));
    assert.throws(() => open([A], { directoryOffset: 0 }), refused('malformed'));
    assert.throws(() => open([A], { directorySize: 10 }), refused('malformed'));
    assert.throws(() => open([A], { directorySize: 48 }), refused('malformed'));
    assert.throws(() => open([A], { directoryPadding: 3 }), refused('malformed'));
    assert.throws(() => open([{ name: 'b.txt', data: 'stored', method: 'stored', declared: { compressedSize: 3 } }]), refused('malformed'));
  });

  it('refuses a damaged entry when it is read', () => {
    const missing = open([A]);
    assert.throws(() => missing.read('b.txt'), refused('missing'));
    assert.throws(() => open([{ ...A, declared: { localOffset: 100_000 } }]).read('a.txt'), refused('malformed'));
    assert.throws(() => open([{ ...A, declared: { localOffset: 4 } }]).read('a.txt'), refused('malformed'));
    assert.throws(() => open([{ ...A, localName: 'other.txt' }]).read('a.txt'), refused('malformed'));
    assert.throws(() => open([{ ...A, declared: { compressedSize: 1_000_000 } }]).read('a.txt'), refused('malformed'));
    assert.throws(() => open([{ ...A, declared: { crc: 1 } }]).read('a.txt'), refused('malformed'));
    assert.throws(() => open([{ name: 's.txt', data: 'stored text', method: 'stored', declared: { crc: 1 } }]).read('s.txt'), refused('malformed'));
    // It inflates to more than it declares: stopped by the ceiling.
    const text = 'x'.repeat(1000);
    assert.throws(() => open([{ name: 'a.txt', data: text, declared: { size: 10 } }]).read('a.txt'), refused('limit'));
    // It inflates to less than it declares.
    assert.throws(() => open([{ name: 'a.txt', data: 'short', declared: { size: 50 } }]).read('a.txt'), refused('malformed'));
    // Not a deflate stream at all.
    assert.throws(() => open([{ name: 'a.txt', data: 'not deflated at all', method: 'stored', declared: { method: 8 } }]).read('a.txt'), refused('malformed'));
  });
});
