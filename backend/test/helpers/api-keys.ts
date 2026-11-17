import { createHash, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { BackofficeOptions } from './backoffice.ts';
import type { TestDatabases } from './mongo.ts';
import { startStoreWorld } from './store-keys.ts';
import type { StoreWorld } from './store-keys.ts';
import type { Reply } from './users.ts';

/** A key made by a test: its id and its secret. */
export interface MadeKey {
  readonly id: string;
  readonly secret: string;
}

/** The running backoffice and public API of a test of the public API keys, over the store world (so a store key exists too), with the helpers every test needs. */
export interface KeysWorld extends StoreWorld {
  /** `/groups/<id>/api-keys` plus a suffix (group `index`). */
  keysPath(index: number, rest?: string): string;
  /** Switches the public API of group `index` on (or off) with the given extra fields of `publicApi`. */
  setPublicApi(index: number, publicApi: Document | null): Promise<void>;
  /** Creates a key as `actor` (the response must be a 201): by default `places:read`, `companies:read`, `catalog:read`, in group `index`, with the public API of the group switched on. */
  makeKey(index?: number, body?: Record<string, unknown>, actor?: ObjectId): Promise<MadeKey>;
  /** A request to `/public/v1` with a key, the body read. */
  asKey(secret: string | undefined, path: string, headers?: Record<string, string>, method?: string): Promise<Reply<any>>;
  /** The stored document of a key, hash and all. */
  storedKey(id: string): Promise<Document | null>;
}

/** SHA-256 of a text, as the hash of a secret is stored. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A well-formed key that nobody was ever given. */
export const unknownKey = (): string => `fc_pk_${randomBytes(32).toString('base64url')}`;

/**
 * Starts the world of the public API tests.
 *
 * @param ctx Throw-away databases.
 * @param options Environment overrides, limiter and extra routes of the backoffice.
 */
export async function startKeysWorld(ctx: TestDatabases, options: BackofficeOptions = {}): Promise<KeysWorld> {
  const world = await startStoreWorld(ctx, options);
  const common = ctx.databases.common();
  const keysPath = (index: number, rest = ''): string => `/groups/${world.group(index).groupId.toHexString()}/api-keys${rest}`;
  const setPublicApi: KeysWorld['setPublicApi'] = async (index, publicApi) => {
    await common.collection('groups').updateOne({ _id: world.group(index).groupId }, publicApi === null ? { $unset: { publicApi: '' } } : { $set: { publicApi } });
  };
  return {
    ...world,
    keysPath,
    setPublicApi,
    makeKey: async (index = 0, body = {}, actor = world.office.cluster.psa) => {
      await setPublicApi(index, { enabled: true });
      const made = await world.as.call(actor, 'POST', keysPath(index), { name: 'Integration', permissions: ['places:read', 'companies:read', 'catalog:read'], ...body });
      if (made.status !== 201) {
        throw new Error(`creating the key answered ${String(made.status)}: ${JSON.stringify(made.body)}`);
      }
      return { id: made.body.data.id as string, secret: made.body.data.secret as string };
    },
    asKey: async (secret, path, headers = {}, method = 'GET') => {
      const response = await world.office.publicCall(method, path, secret, headers);
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
    },
    storedKey: (id) => common.collection('apiKeys').findOne({ _id: new ObjectId(id) }),
  };
}
