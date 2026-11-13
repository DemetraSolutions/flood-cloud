import type { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createMediaStorage } from '../../src/integrations/gcs/index.ts';
import { startBackoffice } from './backoffice.ts';
import type { Backoffice, BackofficeOptions } from './backoffice.ts';
import { startFakeGcs } from './fake-gcs.ts';
import type { FakeGcs } from './fake-gcs.ts';
import type { TestDatabases } from './mongo.ts';
import { actors } from './users.ts';
import type { Reply } from './users.ts';

/** The bucket name of the tests (a throw-away value, not a real one). */
export const TEST_BUCKET = 'test-media-bucket';

/** One part of a multipart request. */
export interface Part {
  readonly name: string;
  readonly bytes: Buffer | string;
  /** File name; without it the part is a text field. */
  readonly filename?: string;
  /** Declared media type of a file part (never trusted by the server). */
  readonly type?: string;
}

/** The running backoffice of a media test with a fake storage behind it. */
export interface MediaWorld {
  readonly office: Backoffice;
  readonly as: ReturnType<typeof actors>;
  readonly fake: FakeGcs;
  /** `POST /v1/groups/<group index>/media/images` as `actor`, multipart. */
  upload(actor: ObjectId, groupIndex: number, parts: readonly Part[], headers?: Record<string, string>, query?: string): Promise<Reply<any>>;
  /** The `/groups/<id>/media/images` path of a group of the cluster, plus a suffix. */
  path(groupIndex: number, rest?: string): string;
  /** The `files` documents of a group database, oldest first. */
  files(groupIndex: number): Promise<Document[]>;
  close(): Promise<void>;
}

/** A single file part in the field `file`. */
export const filePart = (bytes: Buffer, filename = 'photo.png', type = 'image/png'): Part => ({ name: 'file', bytes, filename, type });

/**
 * Starts the backoffice over a throw-away MongoDB with a fake Google Cloud Storage (or none, or a broken one). The storage is built with the real factory over the metadata
 * token endpoint of the fake, so the whole path of an upload is the real one.
 *
 * @param ctx Throw-away databases.
 * @param options `storage: false` for a disabled storage, plus the backoffice options.
 */
export async function startMediaWorld(ctx: TestDatabases, options: BackofficeOptions & { storage?: boolean } = {}): Promise<MediaWorld> {
  const fake = await startFakeGcs();
  const { storage = true, ...rest } = options;
  const mediaStorage = storage
    ? await createMediaStorage({ kind: 'gcs', bucket: TEST_BUCKET, auth: { mode: 'metadata' } }, { urls: { storage: fake.baseUrl, token: fake.metadataUrl }, sleep: async () => {}, random: () => 0.5 })
    : null;
  let office: Backoffice;
  try {
    office = await startBackoffice(ctx, { ...rest, mediaStorage });
  } catch (error) {
    await fake.close();
    throw error;
  }
  const as = actors(office);
  const path = (groupIndex: number, rest = ''): string => `/groups/${office.cluster.groups[groupIndex]!.groupId.toHexString()}/media/images${rest}`;
  return {
    office,
    as,
    fake,
    path,
    upload: async (actor, groupIndex, parts, headers = {}, query = '') => {
      const form = new FormData();
      for (const part of parts) {
        if (part.filename === undefined) {
          form.append(part.name, String(part.bytes));
        } else {
          form.append(part.name, new Blob([new Uint8Array(Buffer.from(part.bytes))], { type: part.type ?? 'application/octet-stream' }), part.filename);
        }
      }
      const response = await fetch(`${office.app.baseUrl}/v1${path(groupIndex)}${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await as.tokenOf(actor)}`, ...headers },
        body: form,
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
    },
    files: (groupIndex) => ctx.databases.group(office.cluster.groups[groupIndex]!.groupId, 'cluster0').collection('files').find({}).sort({ insertDate: 1 }).toArray(),
    close: async () => {
      await office.close();
      await fake.close();
    },
  };
}
