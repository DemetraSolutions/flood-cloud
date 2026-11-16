import type { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { BackofficeOptions } from './backoffice.ts';
import { startPlacesWorld } from './places.ts';
import type { PlacesWorld } from './places.ts';
import type { TestDatabases } from './mongo.ts';
import type { Reply } from './users.ts';

/** What an exchange hands to the app of a store. */
export interface ActivatedKey {
  readonly key: string;
  readonly keyId: string;
  readonly groupId: string;
  readonly companyId: string;
  readonly placeId: string;
}

/** The running backoffice of a store key test, with what every one of them needs: codes, exchanges, requests made with a key, and the stored documents. */
export interface StoreWorld extends PlacesWorld {
  /** `/groups/<id>/places/<place>/store-key` plus a suffix (group `index`). */
  keyPath(index: number, placeId: ObjectId, rest?: string): string;
  /** A PSA (or the given actor) makes the activation code of a place; the code is returned (the response must be a 201). */
  codeFor(placeId: ObjectId, index?: number, actor?: ObjectId): Promise<string>;
  /** `POST /v1/store-activations`, anonymous. */
  exchange(code: unknown, extra?: Record<string, unknown>, headers?: Record<string, string>): Promise<Reply<any>>;
  /** A new code and its exchange: the key of the place (the response must be a 201). */
  activate(placeId: ObjectId, index?: number): Promise<ActivatedKey>;
  /** A request of the server of a store, with its key. */
  asStore(key: string | undefined, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<any>>;
  /** The stored active key of a place, hash and all, or `null`. */
  activeKey(placeId: ObjectId): Promise<Document | null>;
  /** Every stored key of a place, oldest activation first. */
  keysOf(placeId: ObjectId): Promise<Document[]>;
}

/**
 * Starts the places world with the helpers of the store keys.
 *
 * @param ctx Throw-away databases.
 * @param options Environment overrides, limiter and extra routes of the backoffice.
 */
export async function startStoreWorld(ctx: TestDatabases, options: BackofficeOptions = {}): Promise<StoreWorld> {
  const world = await startPlacesWorld(ctx, options);
  const common = ctx.databases.common();
  const reply = async (response: Response): Promise<Reply<any>> => {
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
  };
  const keyPath = (index: number, placeId: ObjectId, rest = ''): string => `/groups/${world.group(index).groupId.toHexString()}/places/${placeId.toHexString()}/store-key${rest}`;
  const codeFor: StoreWorld['codeFor'] = async (placeId, index = 0, actor = world.office.cluster.psa) => {
    const made = await world.as.call(actor, 'POST', keyPath(index, placeId, '/activation-codes'));
    if (made.status !== 201) {
      throw new Error(`creating the activation code answered ${String(made.status)}: ${JSON.stringify(made.body)}`);
    }
    return made.body.data.code as string;
  };
  const exchange: StoreWorld['exchange'] = async (code, extra = {}, headers = {}) =>
    reply(await world.office.call('POST', '/store-activations', undefined, { activationCode: code, ...extra }, headers));
  return {
    ...world,
    keyPath,
    codeFor,
    exchange,
    activate: async (placeId, index = 0) => {
      const done = await exchange(await codeFor(placeId, index));
      if (done.status !== 201) {
        throw new Error(`the exchange answered ${String(done.status)}: ${JSON.stringify(done.body)}`);
      }
      return done.body.data as ActivatedKey;
    },
    asStore: async (key, method, path, body, headers) => reply(await world.office.call(method, path, key, body, headers)),
    activeKey: (placeId) => common.collection('storeKeys').findOne({ placeId, status: 'active' }),
    keysOf: (placeId) => common.collection('storeKeys').find({ placeId }).sort({ activatedAt: 1, _id: 1 }).toArray(),
  };
}
