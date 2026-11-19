import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, output } from '@angular/core';
import { ApiPage } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { GroupRef } from '../../core/reference/reference-api';
import { SessionService } from '../../core/session/session.service';
import { Select } from '../../shared/ui/select/select';
import { abbreviateId } from '../activity-log/activity-log.types';
import { DealerRecord } from '../dealers/dealer.types';

/** Most groups offered by the group filter (the API limit of a page). */
const GROUPS_LIMIT = 100;
/** Most dealers offered by the dealer filter. */
const DEALERS_LIMIT = 200;

/** A change of one of the two filters (`''` clears it). */
export interface CrossGroupFilterChange {
  readonly name: 'groupId' | 'dealerId';
  readonly value: string;
}

/**
 * Group and dealer filters of the cross-group lists (companies, places). The group filter is
 * offered to PSA and dealers (the server returns only the groups of their scope); the dealer
 * filter only to a platform administrator who can read the dealers. A group that is in the URL
 * but not among the first groups read stays selectable with its short id.
 */
@Component({
  selector: 'fc-cross-group-filters',
  imports: [Select, TPipe],
  template: `
    <fc-select
      [label]="'CROSS_GROUP.FILTER.GROUP' | t"
      [placeholder]="'CROSS_GROUP.FILTER.ALL_GROUPS' | t"
      [options]="groupOptions()"
      [value]="groupId() ?? ''"
      (valueChange)="filterChange.emit({ name: 'groupId', value: $event })"
    />
    @if (showDealer()) {
      <fc-select
        [label]="'CROSS_GROUP.FILTER.DEALER' | t"
        [placeholder]="'CROSS_GROUP.FILTER.ALL_DEALERS' | t"
        [options]="dealerOptions()"
        [value]="dealerId() ?? ''"
        (valueChange)="filterChange.emit({ name: 'dealerId', value: $event })"
      />
    }
  `,
  styles: ':host { display: contents; }',
})
export class CrossGroupFilters {
  private readonly session = inject(SessionService);
  protected readonly i18n = inject(I18nService);

  /** Group currently filtered (valid id or `undefined`). */
  readonly groupId = input<string>();
  /** Dealer currently filtered (valid id or `undefined`). */
  readonly dealerId = input<string>();
  /** A filter changed. */
  readonly filterChange = output<CrossGroupFilterChange>();

  /** The dealer filter is for the platform administrator with `dealers:read`. */
  protected readonly showDealer = computed(
    () => this.session.me()?.role === 'PSA' && this.session.can('dealers:read'),
  );

  private readonly groups = httpResource<ApiPage<GroupRef>>(() => ({
    url: '/v1/groups',
    params: { limit: GROUPS_LIMIT, sort: 'name' },
  }));
  private readonly dealers = httpResource<ApiPage<DealerRecord>>(() =>
    this.showDealer()
      ? { url: '/v1/dealers', params: { limit: DEALERS_LIMIT, sort: 'businessName' } }
      : undefined,
  );

  protected readonly groupOptions = computed(() => {
    const options = (this.groups.hasValue() ? this.groups.value().data : []).map((group) => ({
      value: group.id,
      label: group.name,
    }));
    const current = this.groupId();
    return current === undefined || options.some((option) => option.value === current)
      ? options
      : [...options, { value: current, label: abbreviateId(current) }];
  });
  protected readonly dealerOptions = computed(() => {
    const options = (this.dealers.hasValue() ? this.dealers.value().data : []).map((dealer) => ({
      value: dealer.id,
      label: dealer.businessName,
    }));
    const current = this.dealerId();
    return current === undefined || options.some((option) => option.value === current)
      ? options
      : [...options, { value: current, label: abbreviateId(current) }];
  });
}
