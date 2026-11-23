import type { ObjectId } from 'mongodb';
import type { ActivityActor } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { AuthPrincipal, ScopeHolder } from '../../shared/security/scope/principal.ts';
import type { Scope } from '../../shared/security/scope/scope.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import type { GroupLanguages } from './group-languages.ts';

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
 * Whoever operates on the product catalog: a backoffice user or the server of a point of sale. Only `scope` is common (and `userId` and `role` for the user), so every use goes through the functions of
 * this module and of `availability.ts`. `soleLocation` is set by the service wrapper (`withSoleLocation`) when the group has exactly one place that is not in the trash and the caller is limited to it: the
 * entries "for every place" are then wholly his.
 */
export type CatalogCaller = (AuthPrincipal | StoreCaller) & { readonly soleLocation?: true };

/**
 * Whether a caller is the server of a point of sale.
 *
 * @param caller The caller.
 */
export function isStoreCaller(caller: CatalogCaller): caller is StoreCaller & { readonly soleLocation?: true } {
  return 'kind' in caller && caller.kind === 'store';
}

/**
 * The actor of the activity log of a write: the user, or the store (by the id of its store key). The operator of a store is never the actor: he is declared, not authenticated.
 *
 * @param caller The caller.
 */
export function actorOfCaller(caller: CatalogCaller): ActivityActor {
  return isStoreCaller(caller) ? { kind: 'store', id: caller.keyId } : actorOf(caller);
}

/**
 * The metadata of an entry of the activity log that tells who stood at the till: `operatorId` for a store that declared an operator, nothing otherwise.
 *
 * @param caller The caller.
 */
export function operatorMetadata(caller: CatalogCaller): Record<string, string> {
  return isStoreCaller(caller) && caller.operator !== null ? { operatorId: caller.operator.id.toHexString() } : {};
}

/** What the language of a caller is read from. */
export interface LanguageSources {
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly languages: GroupLanguages;
}

/**
 * The language texts are shown and required in for a caller: the one of the user; for a store the one of the operator of the write, else the first language of the group (a read has no operator).
 *
 * @param sources The users and the languages of the group.
 * @param caller The caller.
 * @param groupId The group of the verified access.
 * @throws {AppError} `NOT_FOUND` if the user disappeared since the authentication.
 */
export async function languageOfCaller(sources: LanguageSources, caller: CatalogCaller, groupId: ObjectId): Promise<string> {
  if (isStoreCaller(caller)) {
    return caller.operator?.language ?? (await sources.languages.of(groupId))[0]!;
  }
  const user = await sources.users.findById(caller.userId);
  if (user === null) {
    throw new AppError('NOT_FOUND');
  }
  return user.user.language;
}
