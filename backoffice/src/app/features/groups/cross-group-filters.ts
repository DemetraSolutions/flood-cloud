import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { GroupRef } from '../../core/reference/reference-api';
import { SessionService } from '../../core/session/session.service';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { Select } from '../../shared/ui/select/select';
import { abbreviateId } from '../activity-log/activity-log.types';
import { DealerRecord } from '../dealers/dealer.types';

/** Groups offered at a time by the group search. */
const GROUPS_LIMIT = 20;
/** Most dealers offered by the dealer filter. */
const DEALERS_LIMIT = 200;

/** A change of one of the two filters (`''` clears it). */
export interface CrossGroupFilterChange {
  readonly name: 'groupId' | 'dealerId';
  readonly value: string;
}

/**
 * Group and dealer filters of the cross-group lists (companies, places). The group filter is a
 * searchable combobox on `GET /v1/groups?q=` (the server returns only the groups of the user's
 * scope, so a dealer sees its own); the dealer filter is a plain list, only for a platform
 * administrator who can read the dealers. The name of a group that comes from the URL is read
 * with `GET /v1/groups/{id}` (the short id while it is unknown).
 */
@Component({
  selector: 'fc-cross-group-filters',
  imports: [SearchCombobox, Select, TPipe],
  template: `
    @if (showGroup()) {
      <fc-search-combobox
        [label]="'CROSS_GROUP.FILTER.GROUP' | t"
        [placeholder]="'CROSS_GROUP.FILTER.ALL_GROUPS' | t"
        [clearLabel]="'CROSS_GROUP.FILTER.CLEAR_GROUP' | t"
        [search]="searchGroups"
        [value]="groupId() ?? ''"
        [valueLabel]="groupLabel()"
        (choice)="onGroup($event)"
      />
    }
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
  /** Whether the group filter is offered (not on a list of the groups themselves). */
  readonly showGroup = input(true);
  /** A filter changed. */
  readonly filterChange = output<CrossGroupFilterChange>();

  /** The dealer filter is for the platform administrator with `dealers:read`. */
  protected readonly showDealer = computed(
    () => this.session.me()?.role === 'PSA' && this.session.can('dealers:read'),
  );

  private readonly http = inject(HttpClient);
  /** The group chosen in this component, whose name is already known. */
  private readonly known = signal<SearchOption | null>(null);
  private readonly resolved = httpResource<ApiData<{ readonly name: string }>>(() => {
    const id = this.groupId();
    return id === undefined || this.known()?.value === id
      ? undefined
      : `/v1/groups/${encodeURIComponent(id)}`;
  });

  /** Name of the filtered group for a value not chosen here: unknown while it is being read. */
  protected readonly groupLabel = computed(() => {
    const id = this.groupId();
    if (id === undefined) {
      return null;
    }
    if (this.resolved.hasValue()) {
      return this.resolved.value().data.name || abbreviateId(id);
    }
    return this.resolved.isLoading() ? null : abbreviateId(id);
  });

  /** Groups matching the text (the first ones for an empty text), by name. */
  protected readonly searchGroups = async (text: string): Promise<readonly SearchOption[]> => {
    const params: Record<string, string | number> = { limit: GROUPS_LIMIT, sort: 'name' };
    if (text !== '') {
      params['q'] = text;
    }
    const page = await firstValueFrom(this.http.get<ApiPage<GroupRef>>('/v1/groups', { params }));
    return page.data.map((group) => ({ value: group.id, label: group.name }));
  };

  protected onGroup(option: SearchOption | null): void {
    this.known.set(option);
    this.filterChange.emit({ name: 'groupId', value: option?.value ?? '' });
  }

  private readonly dealers = httpResource<ApiPage<DealerRecord>>(() =>
    this.showDealer()
      ? { url: '/v1/dealers', params: { limit: DEALERS_LIMIT, sort: 'businessName' } }
      : undefined,
  );

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
