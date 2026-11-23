import {
  booleanAttribute,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceItem } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { uniqueId } from '../../shared/ui/unique-id';
import { StationsModel } from './category-model';
import { PlaceSetupReader } from './category-place-setup';

/** The two kinds of order a station serves. */
type Kind = keyof StationsModel;

/**
 * The print stations of a category, store by store: a section for each store with the stations
 * that receive the orders in the rooms and the ones that receive the orders at the counter. The
 * stations of a store are read only when its section is opened (or already has a choice). It
 * implements the Signal Forms value control contract (`value`, `disabled`), so it binds to the
 * stations of the form model; the stores that are not listed (outside the perimeter of the user)
 * keep their choice.
 */
@Component({
  selector: 'fc-category-stations',
  imports: [Button, Checkbox, TPipe],
  templateUrl: './category-stations.html',
  styleUrl: './category-stations.css',
})
export class CategoryStations {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly reader = inject(PlaceSetupReader);

  /** Group of the stores. */
  readonly groupId = input.required<string>();
  /** The stores to choose from. */
  readonly places = input.required<readonly ReferenceItem[]>();
  /** The chosen stations (two-way). */
  readonly value = model<StationsModel>({ rooms: {}, counter: {} });
  /** Error message; empty or null when valid. */
  readonly error = input<string | null>(null);
  /** Disables every checkbox. */
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-category-stations');
  protected readonly errorId = `${this.id}-error`;
  protected readonly states = this.reader.states;
  /** The stores whose section is open. */
  protected readonly opened = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // The stores that already have a choice start open.
    effect(() => {
      const value = this.value();
      const chosen = this.places()
        .map((place) => place.id)
        .filter((id) => (value.rooms[id]?.length ?? 0) + (value.counter[id]?.length ?? 0) > 0);
      untracked(() => this.opened.update((current) => new Set([...current, ...chosen])));
    });
    // The setup of an open store is read once.
    effect(() => {
      const groupId = this.groupId();
      const opened = this.opened();
      untracked(() => opened.forEach((placeId) => this.reader.load(groupId, placeId)));
    });
  }

  /** Focuses the summary of the first store (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLElement>('summary')?.focus();
  }

  protected onToggle(placeId: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.opened.update((current) => {
      const next = new Set(current);
      if (open) {
        next.add(placeId);
      } else {
        next.delete(placeId);
      }
      return next;
    });
  }

  protected retry(placeId: string): void {
    this.reader.load(this.groupId(), placeId);
  }

  /** How many stations of a store are chosen, for both kinds of order. */
  protected count(placeId: string): number {
    const value = this.value();
    return (value.rooms[placeId]?.length ?? 0) + (value.counter[placeId]?.length ?? 0);
  }

  protected has(kind: Kind, placeId: string, stationId: string): boolean {
    return this.value()[kind][placeId]?.includes(stationId) ?? false;
  }

  protected toggle(kind: Kind, placeId: string, stationId: string, on: boolean): void {
    const others = (this.value()[kind][placeId] ?? []).filter((id) => id !== stationId);
    this.value.update((current) => ({
      ...current,
      [kind]: { ...current[kind], [placeId]: on ? [...others, stationId] : others },
    }));
  }
}
