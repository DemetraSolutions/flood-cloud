import { crc32, inflateRawSync } from 'node:zlib';
import { XlsxError } from './errors.ts';
import type { XlsxLimits } from './limits.ts';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const END_RECORD_BYTES = 22;
const CENTRAL_ENTRY_BYTES = 46;
const LOCAL_ENTRY_BYTES = 30;
/** The largest comment a ZIP file can have (a 16-bit length). */
const MAX_COMMENT_BYTES = 0xffff;
const MAX_NAME_BYTES = 256;
const STORED = 0;
const DEFLATED = 8;
/** General purpose flags: encrypted, strong encryption, encrypted central directory. */
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
const ZIP64_32 = 0xffffffff;
const ZIP64_16 = 0xffff;

/** The magic bytes a ZIP file (and so an XLSX) starts with: `PK\x03\x04`. */
export const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** An entry of the central directory, validated. */
interface Entry {
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/** A ZIP archive opened for reading: the directory is validated, the entries are inflated one at a time. */
export interface ZipArchive {
  /**
   * Tells whether the archive has an entry.
   *
   * @param name The name of the entry, as written in the archive.
   */
  has(name: string): boolean;
  /**
   * Reads an entry: inflated with a ceiling of its declared size, then checked against that size and its CRC-32.
   *
   * @param name The name of the entry.
   * @returns The content.
   * @throws {XlsxError} `missing` for an unknown entry, `limit` for an entry that inflates to more than it declares, `malformed` for any other damage.
   */
  read(name: string): Buffer;
}

/** A name the archive may hold: relative, forward slashes, no `..` or `.` segment, no drive letter, no control character. */
function isSafeName(name: string): boolean {
  if (name.length === 0 || Buffer.byteLength(name) > MAX_NAME_BYTES || name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f\u007f\\]/.test(name)) {
    return false;
  }
  return !name.split('/').some((segment, index, all) => segment === '..' || segment === '.' || (segment === '' && index !== all.length - 1));
}

function locateEnd(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - END_RECORD_BYTES - MAX_COMMENT_BYTES);
  for (let offset = buffer.length - END_RECORD_BYTES; offset >= lowest; offset -= 1) {
    // The comment length must account for every byte up to the end of the file: a signature inside a comment is not the end record.
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY && offset + END_RECORD_BYTES + buffer.readUInt16LE(offset + 20) === buffer.length) {
      return offset;
    }
  }
  throw new XlsxError('notZip');
}

/**
 * Opens a ZIP archive held in memory, for reading only, and validates all of its central directory before any entry is inflated.
 *
 * Accepted: stored and deflated entries, with sizes of 32 bits. Refused: ZIP64, encryption, a split archive, any other compression method, a name that is absolute, has a `..` segment, a backslash or a control
 * character, a duplicate name (compared without regard to case), a local header that disagrees with the directory, and every limit of {@link XlsxLimits}: file size, number of entries, size of an entry,
 * total size and compression ratio, all of them judged on the declared sizes, which {@link ZipArchive.read} then enforces while inflating.
 *
 * @param buffer The whole file.
 * @param limits The limits.
 * @returns The archive.
 * @throws {XlsxError} With the reason of the first problem found.
 */
export function openZip(buffer: Buffer, limits: XlsxLimits): ZipArchive {
  if (buffer.length > limits.maxFileBytes) {
    throw new XlsxError('limit');
  }
  if (buffer.length < END_RECORD_BYTES || !buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    throw new XlsxError('notZip');
  }
  const end = locateEnd(buffer);
  if (end >= 20 && buffer.readUInt32LE(end - 20) === ZIP64_LOCATOR) {
    throw new XlsxError('unsupported');
  }
  const disk = buffer.readUInt16LE(end + 4);
  const directoryDisk = buffer.readUInt16LE(end + 6);
  const entriesOnDisk = buffer.readUInt16LE(end + 8);
  const entryCount = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount === ZIP64_16 || directorySize === ZIP64_32 || directoryOffset === ZIP64_32) {
    throw new XlsxError('unsupported');
  }
  if (entryCount > limits.maxEntries) {
    throw new XlsxError('limit');
  }
  const directoryEnd = directoryOffset + directorySize;
  if (entryCount === 0 || directoryEnd > end) {
    throw new XlsxError('malformed');
  }
  const entries = new Map<string, Entry>();
  const lowerNames = new Set<string>();
  let total = 0;
  let position = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + CENTRAL_ENTRY_BYTES > directoryEnd || buffer.readUInt32LE(position) !== CENTRAL_ENTRY) {
      throw new XlsxError('malformed');
    }
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const next = position + CENTRAL_ENTRY_BYTES + nameLength + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
    const startDisk = buffer.readUInt16LE(position + 34);
    const localOffset = buffer.readUInt32LE(position + 42);
    if (next > directoryEnd) {
      throw new XlsxError('malformed');
    }
    if ((flags & ENCRYPTION_FLAGS) !== 0 || (method !== STORED && method !== DEFLATED) || startDisk !== 0 || compressedSize === ZIP64_32 || size === ZIP64_32 || localOffset === ZIP64_32) {
      throw new XlsxError('unsupported');
    }
    const name = buffer.toString('utf8', position + CENTRAL_ENTRY_BYTES, position + CENTRAL_ENTRY_BYTES + nameLength);
    if (!isSafeName(name) || lowerNames.has(name.toLowerCase())) {
      throw new XlsxError('unsafe');
    }
    lowerNames.add(name.toLowerCase());
    if (method === STORED && compressedSize !== size) {
      throw new XlsxError('malformed');
    }
    total += size;
    // A directory entry is empty; anything else is held to the size, total and ratio limits on what it declares.
    if (size > limits.maxEntryBytes || total > limits.maxTotalBytes || (size > 0 && (compressedSize === 0 || size / compressedSize > limits.maxRatio))) {
      throw new XlsxError('limit');
    }
    entries.set(name, { method, crc, compressedSize, size, localOffset });
    position = next;
  }
  if (position !== directoryEnd) {
    throw new XlsxError('malformed');
  }
  return {
    has: (name) => entries.has(name),
    read: (name) => {
      const entry = entries.get(name);
      if (entry === undefined) {
        throw new XlsxError('missing');
      }
      const { localOffset } = entry;
      if (localOffset + LOCAL_ENTRY_BYTES > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_ENTRY) {
        throw new XlsxError('malformed');
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const start = localOffset + LOCAL_ENTRY_BYTES + localNameLength + buffer.readUInt16LE(localOffset + 28);
      const stop = start + entry.compressedSize;
      // The name of the local header must be the one of the directory: the two disagreeing is how a reader is made to see another file than the one that was checked.
      if (stop > buffer.length || buffer.toString('utf8', localOffset + LOCAL_ENTRY_BYTES, localOffset + LOCAL_ENTRY_BYTES + localNameLength) !== name) {
        throw new XlsxError('malformed');
      }
      const data = buffer.subarray(start, stop);
      let content: Buffer;
      if (entry.size === 0) {
        content = Buffer.alloc(0);
      } else if (entry.method === STORED) {
        content = Buffer.from(data);
      } else {
        try {
          // The ceiling is what the entry declared: a stream that inflates to more is a bomb, one that inflates to less is damaged.
          content = inflateRawSync(data, { maxOutputLength: entry.size });
        } catch (error) {
          throw new XlsxError((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ? 'limit' : 'malformed');
        }
      }
      if (content.length !== entry.size || crc32(content) !== entry.crc) {
        throw new XlsxError('malformed');
      }
      return content;
    },
  };
}
