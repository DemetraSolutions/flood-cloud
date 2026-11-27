/**
 * The provider accounts the worker may use.
 *
 * The accounts are data of the backend (`dealers.integrations.<provider>` and, for the platform, `settings`
 * `INTEGRATIONS` `value.<provider>`), written by a PSA and read here, **never written** (`doc/Data-Model.md`, worker
 * contract). Only the hubs of the `WORKER_HUBS` allowlist are ever decrypted; every other account is read only for its
 * username, to find two hubs that share one (compared trimmed, NFKC-normalised and lower case; the provider counts one tier per login: doubling it is forbidden, so both
 * hubs are disabled and nothing is sent through them).
 *
 * A dealer's hub also needs the dealer's linked user (same `_id`, D-09) to be active and not in the trash: `status` `true`
 * and `trash` not `true` in `common.users` (only those two fields are read); otherwise it is disabled with `dealer_disabled`,
 * `dealer_trashed` or `dealer_missing`, whatever `integrations.<provider>.enabled` says.
 *
 * A hub is unusable for a reason code (logged once per change, with the hub and the code, never a value): `missing`,
 * `invalid_account`, `disabled`, `duplicate_username`, or a {@link DecryptFailure}. The registry is refreshed on a timer
 * and a hub is read again right before a provider sign-in (`get(hub, { fresh: true })`; that single-hub read sees the usernames of the other hubs as of the last full refresh, so a username another hub took in the meantime is caught only for the hub being read, the other follows at the next refresh); whenever a usable hub stops
 * being usable or its credentials change, `onDrop` tells the adapter to forget what it cached.
 *
 * @module
 */
import { ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import { MAX_TIME_MS } from '../db/timeouts.ts';
import type { Logger } from '../logger.ts';
import type { Account } from '../providers/types.ts';
import { dealerPasswordContext, platformPasswordContext } from './credentials.ts';
import type { CredentialDecryptor } from './credentials.ts';
import { dealerHub, parseHub } from './hub.ts';

/** The account registry. */
export interface AccountRegistry {
  /** Reads the accounts again (all of them, to find shared usernames). */
  refresh(): Promise<void>;
  /**
   * The usable account of a hub.
   *
   * @param hub A hub of the allowlist.
   * @param options `fresh` reads this hub's account from the database first (use it right before a provider sign-in).
   * @returns The account, or `undefined` when the hub is not allowed or not usable.
   */
  get(hub: string, options?: { readonly fresh?: boolean }): Promise<Account | undefined>;
  /** The allowlisted hubs that are usable now. */
  hubs(): readonly string[];
}

/** Collaborators and settings of {@link createAccountRegistry}. */
export interface RegistryOptions {
  /** `dealers` of the common database (read only). */
  readonly dealers: Collection<Document>;
  /** `users` of the common database (read only): the state of the dealer's linked user (same `_id`, D-09). */
  readonly users: Collection<Document>;
  /** `settings` of the common database (read only). */
  readonly settings: Collection<Document>;
  /** The allowlist (`WORKER_HUBS`). */
  readonly hubs: readonly string[];
  readonly decrypt: CredentialDecryptor;
  readonly logger: Logger;
  /** Called with a hub whose account was usable and no longer is, or whose credentials changed. */
  readonly onDrop: (hub: string) => void;
  /** Most dealers read per provider; reaching it is logged, the shared-username check is then incomplete. */
  readonly scanLimit: number;
}

/** The state of the user linked to a dealer: only an `active` one lets its hub work (`status` is `true` and `trash` is not). */
type DealerState = 'active' | 'disabled' | 'trashed' | 'missing';

interface Source {
  readonly hub: string;
  readonly raw: unknown;
}

interface Entry {
  readonly account?: Account;
  readonly reason: string;
}

/** The form of a username that is compared: trimmed, NFKC-normalised, lower case (look-alike logins count as one). */
const loginKey = (username: string): string => username.trim().normalize('NFKC').toLowerCase();

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

interface Shape {
  readonly enabled: boolean;
  readonly username: string;
  readonly password: unknown;
  readonly maxPerHour: number;
  readonly maxPerYear: number | null;
}

/** Reads the fields of a stored account, or `undefined` when its shape is not the documented one. */
function readShape(raw: unknown): Shape | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const { enabled, username, password, maxPerHour, maxPerYear } = raw;
  if (typeof enabled !== 'boolean' || typeof username !== 'string' || username.length < 1 || username.length > 100) {
    return undefined;
  }
  if (!isInteger(maxPerHour, 1, 1000) || !(maxPerYear === null || isInteger(maxPerYear, 1, 100_000_000))) {
    return undefined;
  }
  return { enabled, username, password, maxPerHour, maxPerYear };
}

/**
 * Creates the registry.
 *
 * @param options Collections, allowlist, decryptor, logger and drop hook.
 * @returns The registry.
 */
export function createAccountRegistry(options: RegistryOptions): AccountRegistry {
  const { dealers, settings, users, decrypt, logger, onDrop, scanLimit } = options;
  const allowed = new Set(options.hubs);
  const providers = [...new Set(options.hubs.map((hub) => parseHub(hub).provider))];
  const entries = new Map<string, Entry>();
  /** Every enabled account read at the last scan or fresh read, by hub: its username in lower case. */
  const logins = new Map<string, string>();
  const reported = new Map<string, string>();

  const projection = (provider: string): Document => ({ [`integrations.${provider}`]: 1 });

  /** The platform's account of a provider. */
  const platformSource = async (provider: string): Promise<Source> => {
    const doc = await settings.findOne({ key: 'INTEGRATIONS' }, { projection: { [`value.${provider}`]: 1 }, maxTimeMS: MAX_TIME_MS });
    const value: unknown = doc?.['value'];
    return { hub: provider, raw: isObject(value) ? value[provider] : undefined };
  };

  /** A dealer's account of a provider. */
  const dealerSource = async (provider: string, dealerId: string): Promise<Source> => {
    const doc = await dealers.findOne({ _id: new ObjectId(dealerId) }, { projection: projection(provider), maxTimeMS: MAX_TIME_MS });
    const integrations: unknown = doc?.['integrations'];
    return { hub: dealerHub(provider, dealerId), raw: isObject(integrations) ? integrations[provider] : undefined };
  };

  const stateOf = (user: Document | null): DealerState => {
    if (user === null) {
      return 'missing';
    }
    if (user['trash'] === true) {
      return 'trashed';
    }
    return user['status'] === true ? 'active' : 'disabled';
  };

  /** The state of the users of some dealer hubs, in one query. */
  const dealerStates = async (hubList: readonly string[]): Promise<Map<string, DealerState>> => {
    const ids = new Map(hubList.map((hub) => [parseHub(hub).dealerId as string, hub]));
    const found = await users.find({ _id: { $in: [...ids.keys()].map((id) => new ObjectId(id)) } }, { projection: { status: 1, trash: 1 }, maxTimeMS: MAX_TIME_MS }).toArray();
    const byId = new Map(found.map((user) => [(user['_id'] as ObjectId).toHexString(), stateOf(user)]));
    return new Map(hubList.map((hub) => [hub, byId.get(parseHub(hub).dealerId as string) ?? 'missing']));
  };

  const evaluate = (hub: string, raw: unknown, dealer: DealerState | undefined): Entry => {
    const { provider, dealerId } = parseHub(hub);
    if (raw === undefined) {
      return { reason: 'missing' };
    }
    const shape = readShape(raw);
    if (shape === undefined) {
      return { reason: 'invalid_account' };
    }
    if (!shape.enabled) {
      return { reason: 'disabled' };
    }
    if (dealer !== undefined && dealer !== 'active') {
      return { reason: `dealer_${dealer}` };
    }
    const login = loginKey(shape.username);
    for (const [other, otherLogin] of logins) {
      if (other !== hub && otherLogin === login) {
        return { reason: 'duplicate_username' };
      }
    }
    const context = dealerId === undefined ? platformPasswordContext(provider) : dealerPasswordContext(provider, dealerId);
    const password = decrypt(shape.password, context);
    if (!password.ok) {
      return { reason: password.reason };
    }
    return { reason: 'ok', account: { hub, provider, username: shape.username, password: password.value, maxPerHour: shape.maxPerHour, maxPerYear: shape.maxPerYear } };
  };

  /** Stores the verdict on a hub, tells the adapter when the hub changed for the worse or in its credentials, logs changes. */
  const apply = (hub: string, entry: Entry): void => {
    const before = entries.get(hub)?.account;
    const after = entry.account;
    if (before !== undefined && (after === undefined || before.username !== after.username || before.password.reveal() !== after.password.reveal())) {
      onDrop(hub);
    }
    entries.set(hub, entry);
    if (reported.get(hub) !== entry.reason) {
      reported.set(hub, entry.reason);
      const level = entry.reason === 'ok' || entry.reason === 'disabled' || entry.reason === 'missing' ? 'info' : 'warn';
      logger[level]('hub account state', { hub, state: entry.reason });
    }
  };

  const noteLogin = (source: Source): void => {
    const shape = readShape(source.raw);
    if (shape?.enabled === true) {
      logins.set(source.hub, loginKey(shape.username));
    } else {
      logins.delete(source.hub);
    }
  };

  return {
    async refresh() {
      const sources = new Map<string, Source>();
      for (const provider of providers) {
        const platform = await platformSource(provider);
        sources.set(platform.hub, platform);
        const path = `integrations.${provider}`;
        const found = await dealers.find({ [path]: { $exists: true } }, { projection: projection(provider), maxTimeMS: MAX_TIME_MS }).limit(scanLimit + 1).toArray();
        if (found.length > scanLimit) {
          logger.warn('too many accounts to read: the shared-username check is incomplete', { provider, limit: scanLimit });
        }
        for (const doc of found.slice(0, scanLimit)) {
          const id: unknown = doc['_id'];
          const integrations: unknown = doc['integrations'];
          if (id instanceof ObjectId && isObject(integrations)) {
            const hub = dealerHub(provider, id.toHexString());
            sources.set(hub, { hub, raw: integrations[provider] });
          }
        }
      }
      logins.clear();
      for (const source of sources.values()) {
        noteLogin(source);
      }
      const states = await dealerStates(options.hubs.filter((hub) => parseHub(hub).dealerId !== undefined));
      for (const hub of allowed) {
        apply(hub, evaluate(hub, sources.get(hub)?.raw, states.get(hub)));
      }
    },

    async get(hub, getOptions = {}) {
      if (!allowed.has(hub)) {
        return undefined;
      }
      if (getOptions.fresh === true) {
        const { provider, dealerId } = parseHub(hub);
        const source = dealerId === undefined ? await platformSource(provider) : await dealerSource(provider, dealerId);
        noteLogin(source);
        const dealer = dealerId === undefined ? undefined : stateOf(await users.findOne({ _id: new ObjectId(dealerId) }, { projection: { status: 1, trash: 1 }, maxTimeMS: MAX_TIME_MS }));
        apply(hub, evaluate(hub, source.raw, dealer));
      }
      return entries.get(hub)?.account;
    },

    hubs() {
      return options.hubs.filter((hub) => entries.get(hub)?.account !== undefined);
    },
  };
}
