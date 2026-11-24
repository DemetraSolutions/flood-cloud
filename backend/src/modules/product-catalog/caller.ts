import type { ObjectId } from 'mongodb';
import type { ActivityActor } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { AuthPrincipal, ScopeHolder } from '../../shared/security/scope/principal.ts';
import type { Scope } from '../../shared/security/scope/scope.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import type { GroupLanguages } from './group-languages.ts';

/** Characters of the prefix of a public key that are the `fc_pk_` marker, which the activity log redacts: only what follows is recorded. */
const KEY_MARKER_LENGTH = 'fc_pk_'.length;

/**
 * The user who works at the till of the point of sale, as the server of the store declared him and the cloud verified him on this request (`X-Operator-Id`, see the store catalog module): his id, for the
 * activity log, and his language, for the texts a write must have. It is declared by the store, not authenticated by the cloud: it grants nothing the store key cannot do.
 */
export interface StoreOperator {
  readonly id: ObjectId;
  /** The language of the operator (a code of the languages of the platform). */
  readonly language: string;
}

/**
 * The server of a point of sale, as the services of the product catalog see it: the perimeter "one place" of its store key and, for a write, the operator that was verified. It is **not** a user and has
 * no role: it is built by the store catalog module from the verified store principal alone (never from a value of the request), and the services read only {@link ScopeHolder.scope}, the activity
 * actor and the language through the functions of this module.
 */
export interface StoreCaller extends ScopeHolder {
  /** Marks the store caller (a backoffice principal has no `kind`). */
  readonly kind: 'store';
  /** Id of the store key that authenticated the request: the actor of the activity log. */
  readonly keyId: ObjectId;
  readonly scope: Extract<Scope, { readonly kind: 'store' }>;
  /** The operator of a write; `null` for a read. */
  readonly operator: StoreOperator | null;
}

/**
 * An integration that authenticated with a public API key (`catalog:read`, `catalog:write`), as the services of the product catalog see it: the perimeter of its restrictions and nothing else. It is **not** a user and has no
 * role: the public catalog module builds it from the verified key alone (never from a value of the request). A key without restrictions has the scope of the group and behaves as a group administrator; a key restricted to
 * companies or places has the scope `places` with the active places that result, and behaves as a place administrator of those places (the rules of the single place included). It has no operator: the texts a write must have
 * are required in the first language of the group.
 */
export interface ApiKeyCaller extends ScopeHolder {
  /** Marks the API key caller. */
  readonly kind: 'apiKey';
  /** Id of the key that authenticated the request: the actor of the activity log. */
  readonly keyId: ObjectId;
  /** The first characters of the key, which recognize it in a list (never the secret): kept in the entries of the activity log. */
  readonly prefix: string;
  readonly scope: Extract<Scope, { readonly kind: 'group' | 'places' }>;
}

/**
 * Whoever operates on the product catalog: a backoffice user, the server of a point of sale or a public API key. Only `scope` is common (and `userId` and `role` for the user), so every use goes through the functions of
 * this module and of `availability.ts`. `soleLocation` is set by the service wrapper (`withSoleLocation`) when the group has exactly one place that is not in the trash and the caller is limited to it: the
 * entries "for every place" are then wholly his.
 */
export type CatalogCaller = (AuthPrincipal | StoreCaller | ApiKeyCaller) & { readonly soleLocation?: true };

/**
 * Whether a caller is the server of a point of sale.
 *
 * @param caller The caller.
 */
export function isStoreCaller(caller: CatalogCaller): caller is StoreCaller & { readonly soleLocation?: true } {
  return 'kind' in caller && caller.kind === 'store';
}

/**
 * Whether a caller is a public API key.
 *
 * @param caller The caller.
 */
export function isApiKeyCaller(caller: CatalogCaller): caller is ApiKeyCaller & { readonly soleLocation?: true } {
  return 'kind' in caller && caller.kind === 'apiKey';
}

/**
 * The actor of the activity log of a write: the user, the store (by the id of its store key) or the public API key (by its id). The operator of a store is never the actor: he is declared, not authenticated.
 *
 * @param caller The caller.
 */
export function actorOfCaller(caller: CatalogCaller): ActivityActor {
  if (isApiKeyCaller(caller)) {
    return { kind: 'apiKey', id: caller.keyId };
  }
  return isStoreCaller(caller) ? { kind: 'store', id: caller.keyId } : actorOf(caller);
}

/**
 * The metadata of an entry of the activity log that tells who stood at the till (`operatorId` for a store that declared an operator) or which public key wrote (`keyHint`: the six characters after `fc_pk_`, never the marker the log would redact), nothing otherwise.
 *
 * @param caller The caller.
 */
export function operatorMetadata(caller: CatalogCaller): Record<string, string> {
  if (isApiKeyCaller(caller)) {
    return { keyHint: caller.prefix.slice(KEY_MARKER_LENGTH) };
  }
  return isStoreCaller(caller) && caller.operator !== null ? { operatorId: caller.operator.id.toHexString() } : {};
}

/** What the language of a caller is read from. */
export interface LanguageSources {
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly languages: GroupLanguages;
}

/**
 * The language texts are shown and required in for a caller: the one of the user; for a store the one of the operator of the write, else the first language of the group (a read has no operator); for a public API key the first language of the group.
 *
 * @param sources The users and the languages of the group.
 * @param caller The caller.
 * @param groupId The group of the verified access.
 * @throws {AppError} `NOT_FOUND` if the user disappeared since the authentication.
 */
export async function languageOfCaller(sources: LanguageSources, caller: CatalogCaller, groupId: ObjectId): Promise<string> {
  if (isApiKeyCaller(caller)) {
    return (await sources.languages.of(groupId))[0]!;
  }
  if (isStoreCaller(caller)) {
    return caller.operator?.language ?? (await sources.languages.of(groupId))[0]!;
  }
  const user = await sources.users.findById(caller.userId);
  if (user === null) {
    throw new AppError('NOT_FOUND');
  }
  return user.user.language;
}
