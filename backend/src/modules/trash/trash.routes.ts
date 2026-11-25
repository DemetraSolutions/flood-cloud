import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import type { Permission } from '../../shared/security/rbac/permissions.ts';
import { requireGroupAccesses } from '../../shared/security/scope/group-access.ts';
import type { CrossGroupAccessHandler } from '../../shared/security/scope/group-access.ts';
import type { GroupsRepository } from '../../shared/security/scope/groups.repository.ts';
import { inputOf, validateBody, validateParams } from '../../shared/validation/middleware.ts';
import { KIND_PERMISSIONS, TRASH_BODY_LIMIT, TRASH_KINDS, contactsDeleteBody, fixedKind, idsBody, parseEmptyBody, trashParams } from './trash.schemas.ts';
import type { IdsBody } from './trash.schemas.ts';
import type { TrashController } from './trash.controller.ts';

/**
 * The routes of the trash page (`doc/Tasks.md` 9-ter, step P2): restore and delete several items of a kind in one call, and empty a tab (PSA only), plus the restore of groups, which
 * are platform-wide and are never deleted. They are action resources with no `If-Match`: a selection comes from lists that carry no versions, and each item operation checks its own
 * state atomically, as the single-item route does.
 *
 * The permission depends on the kind, so each kind has its own routes (`<kind>:trash` to restore, `<kind>:delete` to delete) and the audit of the access to the group sees a refusal as a
 * denial. Emptying a tab is `trash:empty`, which only the PSA has and which implies the delete permissions (the effective permissions of a PSA are the whole ceiling). One call counts as one
 * request on the per-user rule of the trash.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @param groups Group lookup, to verify the groups named in the body of the restore of groups.
 * @param onCrossGroupAccess Audit callback of the access of a PSA or a dealer to a group (the restore of groups reports every group it reaches).
 * @returns The route definitions to mount on `/v1`.
 */
export function createTrashRoutes(
  controller: TrashController,
  rules: Pick<RateLimitRules, 'trashAdminPerUser'>,
  groups: Pick<GroupsRepository, 'findAccess' | 'resolveCluster'>,
  onCrossGroupAccess: CrossGroupAccessHandler,
): RouteDefinition[] {
  const common = { bodyLimit: TRASH_BODY_LIMIT, rateLimit: [rules.trashAdminPerUser] };
  const base = '/groups/:groupId/trash';
  // One route for each kind and operation, with the permission of that kind: the permission check is the audited one of the route builder.
  const perKind = TRASH_KINDS.flatMap((kind) => [
    defineRoute({
      method: 'POST',
      path: `${base}/${kind}/restore`,
      auth: { kind: 'user', permission: KIND_PERMISSIONS.restore[kind], group: true },
      ...common,
      middleware: [fixedKind(kind), validateBody(idsBody)],
      handler: controller.restore,
    }),
    defineRoute({
      method: 'POST',
      path: `${base}/${kind}/delete`,
      auth: { kind: 'user', permission: KIND_PERMISSIONS.delete[kind], group: true },
      ...common,
      // The deletion of a contact searches collections without an index: a call names at most 10.
      middleware: [fixedKind(kind), validateBody(kind === 'contacts' ? contactsDeleteBody : idsBody)],
      handler: controller.remove,
    }),
  ]);
  // The same paths with the kind as a parameter, after the ones above: they are reached only by a kind that does not exist, which `trashParams` refuses with `422` (to a caller who may use
  // the trash at all: any of the permissions opens it). The handlers are never reached.
  const unknownKind = (action: 'restore' | 'delete', permissions: readonly Permission[], handler: TrashController['restore']): RouteDefinition =>
    defineRoute({
      method: 'POST',
      path: `${base}/:kind/${action}`,
      auth: { kind: 'user', anyPermission: permissions, group: true },
      ...common,
      middleware: [validateParams(trashParams), validateBody(idsBody)],
      handler,
    });
  return [
    ...perKind,
    unknownKind('restore', Object.values(KIND_PERMISSIONS.restore), controller.restore),
    unknownKind('delete', Object.values(KIND_PERMISSIONS.delete), controller.remove),
    defineRoute({
      method: 'POST',
      path: `${base}/:kind/empty`,
      auth: { kind: 'user', permission: 'trash:empty', group: true },
      ...common,
      middleware: [validateParams(trashParams), parseEmptyBody],
      handler: controller.empty,
    }),
    defineRoute({
      method: 'POST',
      path: '/trash/groups/restore',
      auth: { kind: 'user', permission: 'groups:trash' },
      ...common,
      middleware: [validateBody(idsBody), requireGroupAccesses(groups, (res) => inputOf<IdsBody>(res, 'body').ids, onCrossGroupAccess)],
      handler: controller.restoreGroups,
    }),
  ];
}
