import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { GroupContext } from '../../core/groups/group-context';
import { GroupFeatures } from '../../core/groups/group-features';
import { TPipe } from '../../core/i18n/t-pipe';
import { abbreviateId } from '../activity-log/activity-log.types';

/**
 * Says which group a page of `/groups/:groupId/...` belongs to, when that is not the working
 * group of the toolbar (a PSA or dealer opened a record of another group, or has no working
 * group): opening a record never changes the working group, so the page names its own group
 * and links to its record. Nothing is shown for the working group or for users bound to a
 * group.
 */
@Component({
  selector: 'fc-record-group',
  imports: [RouterLink, TPipe],
  template: `@if (visible()) {
    <p class="record-group">
      {{ 'RECORD_GROUP.LABEL' | t }}
      <a [routerLink]="['/groups', groupId(), 'settings']">{{ name() }}</a>
    </p>
  }`,
  styles: '.record-group { margin-block: 0 var(--space-3); color: var(--color-text-muted); }',
})
export class RecordGroup {
  private readonly context = inject(GroupContext);
  private readonly features = inject(GroupFeatures);

  /** Group of the page (from the URL). */
  readonly groupId = input.required<string>();

  protected readonly visible = computed(
    () => this.context.canChoose() && this.groupId() !== this.context.groupId(),
  );
  protected readonly name = computed(
    () => this.features.nameOf(this.groupId()) || abbreviateId(this.groupId()),
  );

  constructor() {
    // The name comes with the features of the group (one read, shared with the page).
    effect(() => {
      const groupId = this.groupId();
      if (this.visible()) {
        untracked(() => void this.features.ensure(groupId));
      }
    });
  }
}
