import { removeSessionStorage } from '../storage';

/** `sessionStorage` key of the last group chosen by a platform admin or dealer. */
export const LAST_GROUP_ID_KEY = 'fc.lastGroupId';
/** `sessionStorage` key of that group's name (display only). */
export const LAST_GROUP_NAME_KEY = 'fc.lastGroupName';

/**
 * Forgets the remembered working group. The session calls it whenever a session ends or a new one
 * begins, so a group chosen in an earlier session (possibly on another environment) is never
 * carried into the next one.
 */
export function forgetWorkingGroup(): void {
  removeSessionStorage(LAST_GROUP_ID_KEY);
  removeSessionStorage(LAST_GROUP_NAME_KEY);
}
