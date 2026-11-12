import { computed, inject, resource, Service, Signal, signal } from '@angular/core';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { SessionService } from '../../../core/session/session.service';

/**
 * Stores a company or store administrator (CA, PA) may use in fidelity and promotion elements.
 * The server is the authority (it answers `403` outside the perimeter); this only lets the page
 * explain in advance: elements of stores outside the perimeter, or that apply to the whole group,
 * are read-only for them, and the selector offers only their stores. Provided by the page (not in
 * the root): one per opened group.
 */
@Service({ autoProvided: false })
export class PlacePerimeter {
  private readonly session = inject(SessionService);
  private readonly reference = inject(ReferenceApi);
  private readonly source = signal<Signal<string> | null>(null);

  /** Binds the perimeter to the group id of the page (called once by the page). */
  attach(groupId: Signal<string>): void {
    this.source.set(groupId);
  }

  /** Whether the user is limited to a perimeter of stores (CA and PA). */
  readonly restricted = computed(() => {
    const role = this.session.me()?.role;
    return role === 'CA' || role === 'PA';
  });

  private readonly stores = resource({
    params: () => {
      const groupId = this.source()?.();
      return this.restricted() && groupId !== undefined ? groupId : undefined;
    },
    loader: ({ params }) => this.reference.placeIds(params),
  });

  /**
   * Ids of the stores of the perimeter; `null` while they load, when they could not be read or
   * when there are too many to list (then only the server decides).
   */
  readonly allowed = computed<ReadonlySet<string> | null>(() =>
    this.stores.hasValue() ? this.stores.value() : null,
  );

  /**
   * Whether the user may write an element that applies to these stores (an empty list is the
   * whole group). Always true for those who are not restricted.
   */
  covers(placeIds: readonly string[]): boolean {
    if (!this.restricted()) {
      return true;
    }
    if (placeIds.length === 0) {
      return false;
    }
    const allowed = this.allowed();
    return allowed === null || placeIds.every((id) => allowed.has(id));
  }
}
