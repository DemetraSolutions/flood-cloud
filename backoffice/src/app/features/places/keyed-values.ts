import { Component, computed, inject, input } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { TextField } from '../../shared/ui/text-field/text-field';
import { PlaceState } from './place-state';

/** The blocks that hold a map from a key to a value (`minAmount` by currency, kiosk texts by language). */
type MapSection = 'delivery' | 'kiosk';

/**
 * A text or number for each of a set of keys (the minimum order by currency of the group, a kiosk
 * text by language of the group): the controls of the keys the group has plus those already
 * stored, so a value of a currency or language the group no longer has is still shown and kept.
 * The values are held by a property of the model of a block that the controls edit through the
 * {@link PlaceState}.
 */
@Component({
  selector: 'fc-keyed-values',
  imports: [TextField, TPipe],
  templateUrl: './keyed-values.html',
  styleUrl: './place-section.css',
})
export class KeyedValues {
  protected readonly state = inject(PlaceState);

  /** The block of the model. */
  readonly section = input.required<MapSection>();
  /** The property of the block that holds the map. */
  readonly prop = input.required<string>();
  /** The keys the group has. */
  readonly keys = input.required<readonly string[]>();
  /** Title of the group (already translated). */
  readonly legend = input.required<string>();
  /** Label of the control of a key (already translated). */
  readonly labelOf = input.required<(key: string) => string>();
  /** Kind of the controls. */
  readonly type = input<'text' | 'number'>('text');

  private readonly values = computed(
    () =>
      (this.state.model()[this.section()] as unknown as Record<string, Record<string, string>>)[
        this.prop()
      ],
  );
  protected readonly entries = computed(() => [
    ...new Set([...this.keys(), ...Object.keys(this.values())]),
  ]);

  protected valueOf(key: string): string {
    return this.values()[key] ?? '';
  }

  protected set(key: string, value: string): void {
    const prop = this.prop();
    this.state.edit(this.section(), (block) => {
      const current = (block as unknown as Record<string, Record<string, string>>)[prop];
      return { ...block, [prop]: { ...current, [key]: value } };
    });
  }
}
