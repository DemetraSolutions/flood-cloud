import { booleanAttribute, Component, ElementRef, inject, input, model } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { uniqueId } from '../../shared/ui/unique-id';
import { AttributeGroup, textOf } from '../product-catalog/product-catalog.types';

/**
 * The attributes of a product: a group of checkboxes for each group of attributes of the group
 * (the product has the attributes it is checked in). It implements the Signal Forms value control
 * contract (`value`, `disabled`), so it binds to the `string[]` of the ids of the attributes; the
 * chosen ids that are not listed stay chosen.
 */
@Component({
  selector: 'fc-product-attributes',
  imports: [Checkbox, TPipe],
  templateUrl: './product-attributes.html',
  styleUrl: './product-section.css',
})
export class ProductAttributes {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly i18n = inject(I18nService);

  /** The groups of attributes of the group. */
  readonly groups = input.required<readonly AttributeGroup[]>();
  /** Ids of the chosen attributes (two-way). */
  readonly value = model<string[]>([]);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-attributes');
  protected readonly errorId = `${this.id}-error`;

  /** Focuses the first checkbox (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus();
  }

  protected nameOf(texts: AttributeGroup['name']): string {
    return textOf(texts, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }

  protected has(id: string): boolean {
    return this.value().includes(id);
  }

  protected toggle(id: string, on: boolean): void {
    const others = this.value().filter((chosen) => chosen !== id);
    this.value.set(on ? [...others, id] : others);
  }
}
