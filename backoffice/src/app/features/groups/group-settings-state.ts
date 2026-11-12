import { httpResource } from '@angular/common/http';
import { computed, inject, linkedSignal, Service, Signal, signal } from '@angular/core';
import { ApiData } from '../../core/api/api.types';
import { GroupContext } from '../../core/groups/group-context';
import { GroupFeatures } from '../../core/groups/group-features';
import { SessionService } from '../../core/session/session.service';
import { apiErrorOf } from '../profile/sessions';
import { Group } from './group.types';

/**
 * State shared by the sections of the group record (`/groups/:groupId/settings/…`): the group,
 * loaded once by the layout page, and what the signed-in user may change. It is provided by the
 * layout page (not in the root), so each opened record has its own.
 *
 * Roles (decision D-13): name, description, languages and statistics settings are changed by
 * PSA, dealers and SA (permission `groups:update`); features and integrations by PSA and dealers;
 * `demo` by the PSA only. Everyone with `groups:read` sees every field.
 */
@Service({ autoProvided: false })
export class GroupSettingsState {
  private readonly session = inject(SessionService);
  private readonly context = inject(GroupContext);
  private readonly features = inject(GroupFeatures);

  private readonly source = signal<Signal<string> | null>(null);

  /** Binds the state to the group id of the page (called once by the layout). */
  attach(groupId: Signal<string>): void {
    this.source.set(groupId);
  }

  /** Id of the group of the record, `null` until the layout attached it. */
  readonly groupId = computed(() => this.source()?.() ?? null);

  private readonly resource = httpResource<ApiData<Group>>(() => {
    const id = this.groupId();
    return id === null ? undefined : `/v1/groups/${encodeURIComponent(id)}`;
  });

  private readonly saved = linkedSignal<ApiData<Group> | undefined, Group | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.resource.hasValue() ? this.resource.value() : undefined),
    computation: (value) => value?.data ?? null,
  });

  /** The group; `null` while loading or when it could not be loaded. */
  readonly group = this.saved.asReadonly();
  /** Whether the group is being loaded. */
  readonly loading = this.resource.isLoading;
  /** Whether loading the group failed (also for failures that are not API errors). */
  readonly loadFailed = computed(() => this.resource.error() !== undefined);
  /** Why the group could not be loaded, when the backend said so. */
  readonly loadError = computed(() => apiErrorOf(this.resource.error()));

  /** Whether the user may write at all (`groups:update`). */
  readonly canUpdate = computed(() => this.session.can('groups:update'));
  /** Features and integrations: PSA and dealers with `groups:update`. */
  readonly canManage = computed(() => {
    const role = this.session.me()?.role;
    return this.canUpdate() && (role === 'PSA' || role === 'D');
  });
  /** `demo`: the PSA only. */
  readonly canDemo = computed(() => this.canUpdate() && this.session.me()?.role === 'PSA');

  /** Loads the group again (after an action on its state). */
  reload(): void {
    this.resource.reload();
    void this.features.refresh();
  }

  /**
   * Takes the group returned by a successful update as the current one, aligns the working
   * group (the selector shows the new name) and reads the features of the context again.
   */
  apply(group: Group): void {
    this.saved.set(group);
    this.context.adopt(group.id, group.name);
    void this.features.refresh();
  }

  /** Aligns the working group with the loaded record (once its page loaded). */
  adopt(group: Group): void {
    this.context.adopt(group.id, group.name);
  }
}
