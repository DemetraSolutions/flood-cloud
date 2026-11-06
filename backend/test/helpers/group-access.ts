import type { ObjectId } from 'mongodb';
import type { Request, Response } from 'express';
import { AppError } from '../../src/shared/http/errors.ts';
import { requireGroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';

/**
 * Obtains a verified {@link GroupAccess} the only legitimate way: through `requireGroupAccess`, over a
 * fake repository where the group exists, is available and sits on `clusterId` (the default cluster when `undefined`).
 *
 * @param principal The authenticated caller.
 * @param groupId The group id as it appears in the path.
 * @param clusterId Value of the group's `dataCluster`; `cluster0` by default.
 * @returns The access, or `null` when the middleware answers `404` (malformed id or outside the perimeter).
 */
export async function accessFor(principal: AuthPrincipal, groupId: ObjectId | string, clusterId = 'cluster0'): Promise<GroupAccess | null> {
  const raw = typeof groupId === 'object' ? groupId.toHexString() : groupId;
  const handler = requireGroupAccess({
    findAccess: async (id) => ({ availability: 'available', group: { _id: id, dataCluster: clusterId } }),
    resolveCluster: (group) => group.dataCluster as string,
  });
  const res = { locals: { auth: principal } } as unknown as Response;
  try {
    await handler({ params: { groupId: raw } } as unknown as Request, res, () => undefined);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      return null;
    }
    throw error;
  }
  return res.locals.groupAccess as GroupAccess;
}
