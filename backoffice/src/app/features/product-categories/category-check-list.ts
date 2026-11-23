import { booleanAttribute, Component, computed, ElementRef, inject, input, model } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { uniqueId } from '../../shared/ui/unique-id';
import { FlatNode, nodeName } from './category.types';

/**
 * Checkboxes over the tree of the categories, each indented by its level, to choose some of them
 * (the categories of modifiers of a category). It implements the Signal Forms value control
 * contract (`value`, `disabled`), so it binds to a `string[]` field. Chosen ids that are not in
 * the tree (categories outside the perimeter of the user) stay chosen.
 */
@Component({
  selector: 'fc-category-check-list',
  imports: [Checkbox],
  templateUrl: './category-check-list.html',
  styleUrl: './category-check-list.css',
})
export class CategoryCheckList {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);

  /** Legend of the group (already translated). */
  readonly label = input.required<string>();
  /** The categories to choose from, in reading order. */
  readonly entries = input.required<readonly FlatNode[]>();
  /** Ids of the chosen categories (two-way). */
  readonly value = model<string[]>([]);
  /** Error message; empty or null when valid. */
  readonly error = input<string | null>(null);
  /** Disables the whole group. */
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-category-check-list');
  protected readonly errorId = `${this.id}-error`;
  protected readonly rows = computed(() => {
    const chosen = new Set(this.value());
    return this.entries().map(({ node, level }) => ({
      id: node.id,
      level,
      text: nodeName(node, this.i18n.t('PRODUCT_CATEGORIES.NO_NAME')),
      checked: chosen.has(node.id),
    }));
  });

  /** Focuses the first checkbox (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus();
  }

  protected toggle(id: string, on: boolean): void {
    const others = this.value().filter((chosen) => chosen !== id);
    this.value.set(on ? [...others, id] : others);
  }
}
