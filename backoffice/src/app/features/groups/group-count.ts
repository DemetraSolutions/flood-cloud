import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ElementCount } from './group.types';

/**
 * Count of the elements of a group in a list cell: the active ones, and when some are in the
 * trash a smaller secondary note. The accessible name reads both numbers.
 */
@Component({
  selector: 'fc-group-count',
  imports: [TPipe],
  templateUrl: './group-count.html',
  styleUrl: './group-count.css',
  host: { role: 'group', '[attr.aria-label]': 'label()' },
})
export class GroupCount {
  private readonly i18n = inject(I18nService);

  /** Active and trashed elements. */
  readonly count = input.required<ElementCount>();

  protected readonly label = computed(() => {
    const { active, trashed } = this.count();
    return this.i18n.t(trashed > 0 ? 'GROUPS.COUNT.LABEL_TRASHED' : 'GROUPS.COUNT.LABEL', {
      active,
      trashed,
    });
  });
}
