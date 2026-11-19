import { computed, effect, inject, linkedSignal, Service } from '@angular/core';
import { readSessionStorage, removeSessionStorage, writeSessionStorage } from '../storage';
import { SessionService } from '../session/session.service';

/** `sessionStorage` key of the last group chosen by a platform admin or dealer. */
export const LAST_GROUP_ID_KEY = 'fc.lastGroupId';
/** `sessionStorage` key of that group's name (display only). */
export const LAST_GROUP_NAME_KEY = 'fc.lastGroupName';

const OBJECT_ID = /^[0-9a-f]{24}$/;

/** The group the user works on. */
export interface WorkingGroup {
  readonly id: string;
  readonly name: string;
}

function readPreference(): WorkingGroup | null {
  const id = readSessionStorage(LAST_GROUP_ID_KEY);
  if (id === null || !OBJECT_ID.test(id)) {
    return null;
  }
  return { id, name: readSessionStorage(LAST_GROUP_NAME_KEY) ?? '' };
}

/**
 * The working group (decision D-10). Users bound to a group (SA, CA, PA, E) always work on
 * theirs; PSA and dealers choose one with the header selector. The choice is only a
 * navigation preference kept in `sessionStorage` (cleared on sign-out): the group in the URL
 * and the backend decide what the user may see.
 */
@Service()
export class GroupContext {
  private readonly session = inject(SessionService);

  /** Whether the user picks the group (PSA and dealers) rather than having a fixed one. */
  readonly canChoose = computed(() => {
    const role = this.session.me()?.role;
    return role === 'PSA' || role === 'D';
  });

  private readonly chosen = linkedSignal<string | undefined, WorkingGroup | null>({
    source: () => this.session.me()?.id,
    computation: () => readPreference(),
  });

  /** Id of the working group, or `null` when a PSA/dealer has not chosen one yet. */
  readonly groupId = computed(() =>
    this.canChoose() ? (this.chosen()?.id ?? null) : (this.session.me()?.groupId ?? null),
  );

  /** Name of the working group (empty when only its id is known). */
  readonly groupName = computed(() =>
    this.canChoose() ? (this.chosen()?.name ?? '') : (this.session.me()?.group?.name ?? ''),
  );

  constructor() {
    effect(() => {
      if (this.session.status() === 'anonymous') {
        removeSessionStorage(LAST_GROUP_ID_KEY);
        removeSessionStorage(LAST_GROUP_NAME_KEY);
      }
    });
  }

  /**
   * Refreshes the name of the working group after it was renamed. Nothing happens for any other
   * group: opening or editing a record never changes the working group.
   *
   * @param groupId Id of the group that was renamed.
   * @param name Its new name.
   */
  rename(groupId: string, name: string): void {
    const chosen = this.chosen();
    if (this.canChoose() && chosen?.id === groupId && name !== '' && chosen.name !== name) {
      this.choose({ id: groupId, name });
    }
  }

  /**
   * Route of the list of a resource where the user came from: with no working group a PSA or
   * dealer comes from the cross-group list, otherwise from the list of the group of the page.
   *
   * @param groupId Group of the page.
   * @param resource The list.
   */
  listRoute(groupId: string, resource: 'companies' | 'places' | 'users'): string[] {
    return this.canChoose() && this.groupId() === null
      ? [`/${resource}`]
      : ['/groups', groupId, resource];
  }

  /** Forgets the working group ("all groups"), including the stored preference. */
  clear(): void {
    this.chosen.set(null);
    removeSessionStorage(LAST_GROUP_ID_KEY);
    removeSessionStorage(LAST_GROUP_NAME_KEY);
  }

  /** Remembers the group chosen with the selector. */
  choose(group: WorkingGroup): void {
    if (!OBJECT_ID.test(group.id)) {
      return;
    }
    this.chosen.set(group);
    writeSessionStorage(LAST_GROUP_ID_KEY, group.id);
    writeSessionStorage(LAST_GROUP_NAME_KEY, group.name);
  }
}
